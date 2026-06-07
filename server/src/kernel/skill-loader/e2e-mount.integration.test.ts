/**
 * Integration e2e for the mount layer (Phase 3, ADR-0017). Spins up a local git
 * repo as the skill source, a temp project as the workspace, then exercises the
 * full `ensureLinksForLaunch` flow end-to-end:
 *
 * 1. `ensureSkillRepo` (1/3 git layer) — clone the local repo into the shared cache.
 * 2. `ensureLink` — create the `_c3_<id>` symlink in the vendor discovery dir.
 * 3. `.gitignore` ack — approve the first-time append; verify the line is written.
 * 4. `ensureLinksForLaunch` — the full orchestrator call.
 * 5. Second call — cache hit (no clone, no relink, no re-ask).
 *
 * Uses real `git` CLI and real filesystem — no stubs. The shared cache is
 * isolated via `CLAUDE_CONFIG_DIR` (disjoint from `~/.c3/repo/`).
 *
 * From repo root: `rtk proxy npx vitest run skill-loader/e2e-mount.integration.test.ts`
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, readlink, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { ensureLinksForLaunch } from './index.js'
import { resetStateCacheForTests } from '../../state.js'
import { createClaudeSkillLoader } from '../agent/adapters/claude/skill.js'
import { createCodexSkillLoader } from '../agent/adapters/codex/skill.js'
import { createOpencodeSkillLoader } from '../agent/adapters/opencode/skill.js'
import type { SkillRepoConfig } from '@ccc/shared/protocol'
import { setSkillApprovalSend } from './approval.js'
import type { SkillApprovalAsk } from './approval.js'

/** Create a local git repo with a skill. */
async function initSkillRepo(dir: string, name: string, extraDir?: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  // Init bare git repo
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })

  const skillRoot = extraDir ? join(dir, extraDir) : dir
  await mkdir(skillRoot, { recursive: true })
  await writeFile(
    join(skillRoot, 'SKILL.md'),
    `---
name: ${name}
description: E2E test skill
---
# ${name}
This is a test skill.
`,
  )
  // Also add a dummy file so git has something to commit in the root
  if (!extraDir) {
    execFileSync('git', ['add', '.'], { cwd: dir })
  } else {
    execFileSync('git', ['add', extraDir], { cwd: dir })
  }
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir })
  const log = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf-8' })
  return log.trim()
}

describe('e2e: skill mount integration', () => {
  let tmpRoot: string
  let projectDir: string
  let claudeSkillDir: string
  let repoDir: string
  let origConfigDir: string | undefined
  let approvalLog: SkillApprovalAsk[]
  const originalC3Dir = process.env.C3_DIR

  beforeEach(async () => {
    approvalLog = []
    setSkillApprovalSend(() => {}) // silence WS send
    origConfigDir = process.env.CLAUDE_CONFIG_DIR
    tmpRoot = await mkdtemp(join(tmpdir(), 'e2e-mount-'))
    // Isolate both CLAUDE_CONFIG_DIR (state.json) and C3_DIR (repo cache)
    process.env.CLAUDE_CONFIG_DIR = tmpRoot
    process.env.C3_DIR = join(tmpRoot, '.c3')
    resetStateCacheForTests()

    projectDir = join(tmpRoot, 'project')
    claudeSkillDir = join(projectDir, '.claude', 'skills')
    await mkdir(claudeSkillDir, { recursive: true })

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

  it('full e2e: clone → ensureLink → .gitignore ack → cache-hit', async () => {
    const config: SkillRepoConfig = {
      id: 'my-test-skill',
      repo: repoDir, // use the local repo path
      ref: 'main',
    }

    // ---- First call: full flow ----
    const result1 = await ensureLinksForLaunch({
      projectDir,
      configs: [config],
      loaders: { claude: createClaudeSkillLoader() },
      requestApproval: async (ask) => {
        approvalLog.push(ask)
        // Approve the gitignore gate
        return true
      },
    })

    // Verify: mounted with symlink
    expect(result1.mounted).toHaveLength(1)
    expect(result1.mounted[0].id).toBe('my-test-skill')
    expect(result1.mounted[0].vendor).toBe('claude')

    // Verify the symlink exists and points to a real directory containing SKILL.md
    const linkPath = join(claudeSkillDir, '_c3_my-test-skill')
    const linkTarget = await readlink(linkPath)
    expect(linkTarget).toBeTruthy()
    // Verify it's a real directory (symlink to SKILL.md parent)
    const skillStat = await stat(linkPath)
    expect(skillStat.isDirectory()).toBe(true)
    // Verify the target has SKILL.md (it's a real skill source)
    const skillMd = await stat(join(linkTarget, 'SKILL.md'))
    expect(skillMd.isFile()).toBe(true)

    // Verify .gitignore was updated
    const gitignore = await readFile(join(projectDir, '.gitignore'), 'utf-8')
    expect(gitignore).toContain('_c3_*/')

    // Verify approval log: the only gate is the one-time gitignore ack
    expect(approvalLog).toHaveLength(1)
    expect(approvalLog[0].kind).toBe('gitignore')
  })

  it('second call is a cache hit (no clone, no relink, no re-ask)', async () => {
    const config: SkillRepoConfig = {
      id: 'my-test-skill',
      repo: repoDir,
      ref: 'main',
    }

    // First call — mount
    await ensureLinksForLaunch({
      projectDir,
      configs: [config],
      loaders: { claude: createClaudeSkillLoader() },
      requestApproval: async () => true,
    })

    approvalLog = [] // clear log

    // Second call — should be cache hit
    const result2 = await ensureLinksForLaunch({
      projectDir,
      configs: [config],
      loaders: { claude: createClaudeSkillLoader() },
      requestApproval: async (ask) => {
        approvalLog.push(ask)
        return true
      },
    })

    // No new mounts — it was a cache hit
    expect(result2.mounted).toHaveLength(0)
    // Should be in skipped as cache-hit
    expect(result2.skipped.some((s) => s.reason === 'cache-hit')).toBe(true)
    // No new approvals (gitignore already acked, same ref)
    expect(approvalLog).toHaveLength(0)
  })

  it('fans out into claude + codex', async () => {
    const config: SkillRepoConfig = {
      id: 'multi-vendor',
      repo: repoDir,
      ref: 'main',
    }

    const codexSkillDir = join(projectDir, '.codex', 'skills')
    await mkdir(codexSkillDir, { recursive: true })

    const result = await ensureLinksForLaunch({
      projectDir,
      configs: [config],
      loaders: {
        claude: createClaudeSkillLoader(),
        codex: createCodexSkillLoader(),
        opencode: createOpencodeSkillLoader(),
      },
      requestApproval: async () => true,
    })

    // claude + codex should mount (opencode may be none=partial, skip)
    const claudeMount = result.mounted.find((m) => m.vendor === 'claude')
    const codexMount = result.mounted.find((m) => m.vendor === 'codex')
    expect(claudeMount).toBeTruthy()
    expect(codexMount).toBeTruthy()

    // Verify both symlinks exist and point to real skill source dirs
    const claudeLink = join(claudeSkillDir, '_c3_multi-vendor')
    const codexLink = join(codexSkillDir, '_c3_multi-vendor')
    const claudeTarget = await readlink(claudeLink)
    const codexTarget = await readlink(codexLink)
    expect(claudeTarget).toBeTruthy()
    expect(codexTarget).toBeTruthy()
    // Both point at the same cache source
    expect(claudeTarget).toBe(codexTarget)
    // Each has SKILL.md (via the symlink)
    const claudeStat = await stat(join(claudeTarget, 'SKILL.md'))
    expect(claudeStat.isFile()).toBe(true)
    const codexStat = await stat(join(codexTarget, 'SKILL.md'))
    expect(codexStat.isFile()).toBe(true)
  })

  it('unsupported vendor is greyed (symlink not created)', async () => {
    // Create a loader that reports none
    const { createSkillLoader } = await import('../agent/adapters/skill-loader-base.js')

    const noneLoader = createSkillLoader('claude', ['.claude', 'skills'], {
      version: async () => 'test',
      support: async () => 'none',
    })

    const config: SkillRepoConfig = {
      id: 'grey-skill',
      repo: repoDir,
      ref: 'main',
    }

    const result = await ensureLinksForLaunch({
      projectDir,
      configs: [config],
      loaders: { claude: noneLoader },
      requestApproval: async () => true,
    })

    // No mount, vendor greyed
    expect(result.mounted).toHaveLength(0)
    expect(result.greyed).toContain('claude')
    expect(result.skipped.some((s) => s.reason === 'unsupported')).toBe(true)
  })

  it('repo error (nonexistent subpath) is skipped, not thrown', async () => {
    const config: SkillRepoConfig = {
      id: 'subpath-skill',
      repo: repoDir,
      ref: 'main',
      subpath: 'nonexistent-dir',
    }

    const result = await ensureLinksForLaunch({
      projectDir,
      configs: [config],
      loaders: { claude: createClaudeSkillLoader() },
      requestApproval: async () => true,
    })

    expect(result.mounted).toHaveLength(0)
    expect(result.skipped.some((s) => s.reason === 'repo-error')).toBe(true)
    expect(result.skipped[0].detail).toContain('不存在')
  })
})
