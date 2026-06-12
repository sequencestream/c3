/**
 * Integration e2e for the external-skill install action (2026-06-12). Spins up a
 * local git repo as the skill source, a temp project as the workspace, then runs
 * the real `installSkill` flow end-to-end:
 *
 * 1. `ensureSkillRepo` (1/3 git layer) — clone the local repo into the shared cache.
 * 2. force-relink — create the `_c3_<id>` symlink in BOTH public dirs.
 * 3. `.gitignore` ack — approve the first-time append; verify both lines are written.
 * 4. re-install after an upstream commit — pulls the new head, relink survives.
 * 5. `getSkillLinkStatuses` reflects the live links.
 *
 * Uses real `git` CLI and real filesystem — no stubs. The shared cache is isolated
 * via `C3_DIR` and `CLAUDE_CONFIG_DIR`.
 *
 * From repo root: `rtk proxy npx vitest run skill-loader/e2e-mount.integration.test.ts`
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, readlink, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { getSkillLinkStatuses, installSkill, PUBLIC_SKILL_DIRS } from './index.js'
import { resetStateCacheForTests } from '../../state.js'
import type { SkillRepoConfig } from '@ccc/shared/protocol'
import { setSkillApprovalSend } from './approval.js'
import type { SkillApprovalAsk } from './approval.js'

/** Create a local git repo with a skill; returns the HEAD sha. */
async function initSkillRepo(dir: string, name: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: E2E test skill\n---\n# ${name}\n`,
  )
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' }).trim()
}

describe('e2e: external skill install integration', () => {
  let tmpRoot: string
  let projectDir: string
  let repoDir: string
  let origConfigDir: string | undefined
  let approvalLog: SkillApprovalAsk[]
  const originalC3Dir = process.env.C3_DIR

  const claudeLink = (id: string): string =>
    join(projectDir, ...PUBLIC_SKILL_DIRS.claudeSkills, `_c3_${id}`)
  const agentsLink = (id: string): string =>
    join(projectDir, ...PUBLIC_SKILL_DIRS.agentsSkills, `_c3_${id}`)

  beforeEach(async () => {
    approvalLog = []
    setSkillApprovalSend(() => {})
    origConfigDir = process.env.CLAUDE_CONFIG_DIR
    tmpRoot = await mkdtemp(join(tmpdir(), 'e2e-install-'))
    process.env.CLAUDE_CONFIG_DIR = tmpRoot
    process.env.C3_DIR = join(tmpRoot, '.c3')
    resetStateCacheForTests()

    projectDir = join(tmpRoot, 'project')
    await mkdir(projectDir, { recursive: true })

    repoDir = join(tmpRoot, 'skill-repo')
    await initSkillRepo(repoDir, 'my-test-skill')
  })

  afterEach(async () => {
    if (origConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = origConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    if (originalC3Dir !== undefined) process.env.C3_DIR = originalC3Dir
    else delete process.env.C3_DIR
    setSkillApprovalSend(() => {})
    resetStateCacheForTests()
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  it('full e2e: clone → link both public dirs → .gitignore ack', async () => {
    const config: SkillRepoConfig = { id: 'my-test-skill', repo: repoDir, ref: 'main' }

    const result = await installSkill({
      projectDir,
      config,
      requestApproval: async (ask) => {
        approvalLog.push(ask)
        return true
      },
    })
    expect(result.ok).toBe(true)
    expect(result.linkedDirs?.sort()).toEqual(['agentsSkills', 'claudeSkills'])

    // Both symlinks resolve to a real dir containing SKILL.md.
    for (const link of [claudeLink('my-test-skill'), agentsLink('my-test-skill')]) {
      const target = await readlink(link)
      expect((await stat(link)).isDirectory()).toBe(true)
      expect((await stat(join(target, 'SKILL.md'))).isFile()).toBe(true)
    }

    // .gitignore got both public-dir patterns; the only gate was the one-time ack.
    const gitignore = await readFile(join(projectDir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('.claude/skills/_c3_*/')
    expect(gitignore).toContain('.agents/skills/_c3_*/')
    expect(approvalLog).toHaveLength(1)
    expect(approvalLog[0].kind).toBe('gitignore')

    const [s] = await getSkillLinkStatuses(projectDir, [config])
    expect(s).toEqual({ id: 'my-test-skill', claudeSkills: true, agentsSkills: true })
  })

  it('re-install after an upstream commit pulls the new head; links survive', async () => {
    const config: SkillRepoConfig = { id: 'my-test-skill', repo: repoDir, ref: 'main' }
    await installSkill({ projectDir, config, requestApproval: async () => true })
    const firstTarget = await readlink(claudeLink('my-test-skill'))

    // New upstream commit — adds a file to the skill source.
    await writeFile(join(repoDir, 'EXTRA.md'), 'extra\n')
    execFileSync('git', ['add', '.'], { cwd: repoDir })
    execFileSync('git', ['commit', '-m', 'second'], { cwd: repoDir })

    const result = await installSkill({ projectDir, config, requestApproval: async () => true })
    expect(result.ok).toBe(true)
    // Same shared cache dir (repo+ref hashed), now pulled to the new head.
    const newTarget = await readlink(claudeLink('my-test-skill'))
    expect(newTarget).toBe(firstTarget)
    expect((await stat(join(newTarget, 'EXTRA.md'))).isFile()).toBe(true)
  })

  it('repo error (nonexistent subpath) → ok:false, not thrown', async () => {
    const config: SkillRepoConfig = {
      id: 'subpath-skill',
      repo: repoDir,
      ref: 'main',
      subpath: 'nonexistent-dir',
    }
    const result = await installSkill({ projectDir, config, requestApproval: async () => true })
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('repo-error')
    expect(result.detail).toContain('不存在')
  })
})
