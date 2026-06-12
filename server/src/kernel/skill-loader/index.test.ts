/**
 * Unit tests for the external-skill install + link-status engine (2026-06-12).
 *
 * External skills are installed explicitly (not mounted at launch) into the two
 * shared public dirs (`.claude/skills`, `.agents/skills`). Covers:
 * - getSkillLinkStatuses: link presence per public dir, reflects create/delete.
 * - installSkill: force-relink into both dirs, overwrite stale link, .gitignore
 *   append + one-time ack, gitignore-cancel, repo-error (never throws).
 * - hasAnyInstalledSkill: two-state probe for the launch write guard.
 *
 * From repo root: `rtk proxy npx vitest run skill-loader/index.test.ts`
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, readlink, readFile, symlink, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SkillRepoConfig } from '@ccc/shared/protocol'
import { resetStateCacheForTests } from '../../state.js'
import {
  getSkillLinkStatuses,
  hasAnyInstalledSkill,
  installSkill,
  PUBLIC_SKILL_DIRS,
} from './index.js'
import type { EnsureSkillRepoResult } from '../../skill-repo.js'
import { setSkillApprovalSend } from './approval.js'

const baseConfig: SkillRepoConfig = {
  id: 'my-skill',
  repo: 'https://github.com/test/repo',
  ref: 'main',
}

function okRepo(skillDir: string): (config: SkillRepoConfig) => Promise<EnsureSkillRepoResult> {
  return async () => ({ ok: true, cacheDir: '/tmp/cache', skillDir })
}

function failRepo(
  msg = 'clone failed',
): (config: SkillRepoConfig) => Promise<EnsureSkillRepoResult> {
  return async () => ({ ok: false, cacheDir: '/tmp/cache', error: msg })
}

function claudeLink(projectDir: string, id: string): string {
  return join(projectDir, ...PUBLIC_SKILL_DIRS.claudeSkills, `_c3_${id}`)
}
function agentsLink(projectDir: string, id: string): string {
  return join(projectDir, ...PUBLIC_SKILL_DIRS.agentsSkills, `_c3_${id}`)
}

describe('external skill install + status', () => {
  let tmpRoot: string
  let origConfigDir: string | undefined

  beforeEach(async () => {
    origConfigDir = process.env.CLAUDE_CONFIG_DIR
    resetStateCacheForTests()
    setSkillApprovalSend(() => {})
    tmpRoot = await mkdtemp(join(tmpdir(), 'skill-install-'))
    process.env.CLAUDE_CONFIG_DIR = tmpRoot
  })

  afterEach(async () => {
    if (origConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = origConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    resetStateCacheForTests()
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
    setSkillApprovalSend(() => {})
  })

  // -------------------------------------------------------------------------
  // Status query
  // -------------------------------------------------------------------------

  it('status reports unlinked for a fresh project', async () => {
    const [s] = await getSkillLinkStatuses(tmpRoot, [baseConfig])
    expect(s).toEqual({ id: 'my-skill', claudeSkills: false, agentsSkills: false })
  })

  it('status flips to linked after a symlink is created, and back after delete', async () => {
    const source = join(tmpRoot, 'source')
    await mkdir(source, { recursive: true })
    const link = claudeLink(tmpRoot, baseConfig.id)
    await mkdir(join(tmpRoot, ...PUBLIC_SKILL_DIRS.claudeSkills), { recursive: true })
    await symlink(source, link, 'dir')

    let [s] = await getSkillLinkStatuses(tmpRoot, [baseConfig])
    expect(s.claudeSkills).toBe(true)
    expect(s.agentsSkills).toBe(false)

    await rm(link, { recursive: true, force: true })
    ;[s] = await getSkillLinkStatuses(tmpRoot, [baseConfig])
    expect(s.claudeSkills).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Install action
  // -------------------------------------------------------------------------

  it('install links both public dirs to the repo skill dir + appends .gitignore', async () => {
    const source = join(tmpRoot, 'source')
    await mkdir(source, { recursive: true })
    const result = await installSkill({
      projectDir: tmpRoot,
      config: baseConfig,
      ensureRepo: okRepo(source),
      requestApproval: async () => true,
    })
    expect(result.ok).toBe(true)
    expect(result.linkedDirs?.sort()).toEqual(['agentsSkills', 'claudeSkills'])

    expect(await readlink(claudeLink(tmpRoot, baseConfig.id))).toBe(source)
    expect(await readlink(agentsLink(tmpRoot, baseConfig.id))).toBe(source)

    const gitignore = await readFile(join(tmpRoot, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('.claude/skills/_c3_*/')
    expect(gitignore).toContain('.agents/skills/_c3_*/')

    const [s] = await getSkillLinkStatuses(tmpRoot, [baseConfig])
    expect(s).toEqual({ id: 'my-skill', claudeSkills: true, agentsSkills: true })
  })

  it('install OVERWRITES a stale link, pointing it at the new head', async () => {
    const oldSrc = join(tmpRoot, 'old')
    const newSrc = join(tmpRoot, 'new')
    await mkdir(oldSrc, { recursive: true })
    await mkdir(newSrc, { recursive: true })
    // Seed a stale link at the claude dir.
    await mkdir(join(tmpRoot, ...PUBLIC_SKILL_DIRS.claudeSkills), { recursive: true })
    await symlink(oldSrc, claudeLink(tmpRoot, baseConfig.id), 'dir')

    const result = await installSkill({
      projectDir: tmpRoot,
      config: baseConfig,
      ensureRepo: okRepo(newSrc),
      requestApproval: async () => true,
    })
    expect(result.ok).toBe(true)
    expect(await readlink(claudeLink(tmpRoot, baseConfig.id))).toBe(newSrc)
  })

  it('install asks the .gitignore ack only once per project', async () => {
    const source = join(tmpRoot, 'source')
    await mkdir(source, { recursive: true })
    let acks = 0
    const approve = async (): Promise<boolean> => {
      acks++
      return true
    }
    await installSkill({
      projectDir: tmpRoot,
      config: baseConfig,
      ensureRepo: okRepo(source),
      requestApproval: approve,
    })
    await installSkill({
      projectDir: tmpRoot,
      config: { ...baseConfig, id: 's2' },
      ensureRepo: okRepo(source),
      requestApproval: approve,
    })
    expect(acks).toBe(1)
  })

  it('gitignore cancel → ok:false (gitignore-cancelled), no link built', async () => {
    const result = await installSkill({
      projectDir: tmpRoot,
      config: baseConfig,
      ensureRepo: okRepo(join(tmpRoot, 'source')),
      requestApproval: async () => false,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('gitignore-cancelled')
    await expect(lstat(claudeLink(tmpRoot, baseConfig.id))).rejects.toThrow()
  })

  it('repo error → ok:false (repo-error), never throws', async () => {
    const result = await installSkill({
      projectDir: tmpRoot,
      config: baseConfig,
      ensureRepo: failRepo('clone failed'),
      requestApproval: async () => true,
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('repo-error')
    expect(result.detail).toBe('clone failed')
  })

  // -------------------------------------------------------------------------
  // Launch write-guard probe
  // -------------------------------------------------------------------------

  it('hasAnyInstalledSkill: false when configured-but-not-installed, true after install', async () => {
    const source = join(tmpRoot, 'source')
    await mkdir(source, { recursive: true })
    expect(await hasAnyInstalledSkill(tmpRoot, [baseConfig])).toBe(false)

    await installSkill({
      projectDir: tmpRoot,
      config: baseConfig,
      ensureRepo: okRepo(source),
      requestApproval: async () => true,
    })
    expect(await hasAnyInstalledSkill(tmpRoot, [baseConfig])).toBe(true)
  })
})
