/**
 * Unit tests for the skill mount lifecycle orchestrator (mount layer 2/3).
 *
 * External skills now mount silently into every build-link-capable vendor at the
 * configured ref's head — no trust knobs, no orphan/consume tracking. Covers:
 * - ensureLinksForLaunch: full path, cache hit, unsupported vendor (grey),
 *   multi-vendor fan-out, .gitignore ack gate, repo error → skip (not throw).
 *
 * From repo root: `rtk proxy npx vitest run skill-loader/index.test.ts`
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SkillRepoConfig, VendorId } from '@ccc/shared/protocol'
import type { SkillLoader } from '../agent/adapters/types.js'
import { resetStateCacheForTests } from '../../state.js'
import { ensureLinksForLaunch } from './index.js'
import type { EnsureSkillRepoResult } from '../../skill-repo.js'
import type { SkillApprovalAsk } from './approval.js'
import { setSkillApprovalSend } from './approval.js'

// ---------------------------------------------------------------------------
// Fake SkillLoader
// ---------------------------------------------------------------------------

function fakeLoader(vendor: VendorId, skillDir: string): SkillLoader {
  return {
    vendor,
    getVendorSkillDir: () => skillDir,
    detectSkillSupport: async () => ({ state: 'full', sdkVersion: 'test', checkedAt: 0 }),
    ensureLink: async (target: string, linkPath: string) => {
      const { symlink } = await import('node:fs/promises')
      await symlink(target, linkPath, 'dir')
    },
  }
}

function unsupportedLoader(vendor: VendorId, skillDir: string): SkillLoader {
  return {
    vendor,
    getVendorSkillDir: () => skillDir,
    detectSkillSupport: async () => ({ state: 'none', sdkVersion: 'test', checkedAt: 0 }),
    ensureLink: async () => {},
  }
}

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensureLinksForLaunch', () => {
  let tmpRoot: string
  let claudeSkillDir: string
  let codexSkillDir: string
  let origConfigDir: string | undefined

  beforeEach(async () => {
    origConfigDir = process.env.CLAUDE_CONFIG_DIR
    resetStateCacheForTests()
    setSkillApprovalSend(() => {})
    tmpRoot = await mkdtemp(join(tmpdir(), 'skill-mount-'))
    process.env.CLAUDE_CONFIG_DIR = tmpRoot
    claudeSkillDir = join(tmpRoot, '.claude', 'skills')
    codexSkillDir = join(tmpRoot, '.codex', 'skills')
    await mkdir(claudeSkillDir, { recursive: true })
    await mkdir(codexSkillDir, { recursive: true })
  })

  afterEach(async () => {
    if (origConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = origConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    resetStateCacheForTests()
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
    setSkillApprovalSend(() => {})
  })

  it('mounts a new skill with a symlink', async () => {
    const source = join(tmpRoot, 'source')
    await mkdir(source, { recursive: true })
    const result = await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [baseConfig],
      loaders: { claude: fakeLoader('claude', claudeSkillDir) },
      ensureRepo: okRepo(source),
      resolveRef: async () => 'sha-resolved',
      requestApproval: async () => true,
    })
    expect(result.mounted).toHaveLength(1)
    expect(result.mounted[0].vendor).toBe('claude')
    expect(result.mounted[0].linkPath).toContain('_c3_my-skill')
    const linkTarget = await readlink(result.mounted[0].linkPath)
    expect(linkTarget).toBe(source)
  })

  it('cache hit on second call (skip clone + skip relink)', async () => {
    const source = join(tmpRoot, 'source')
    await mkdir(source, { recursive: true })
    // First call: mounts
    const r1 = await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [baseConfig],
      loaders: { claude: fakeLoader('claude', claudeSkillDir) },
      ensureRepo: okRepo(source),
      resolveRef: async () => 'sha-1',
      requestApproval: async () => true,
    })
    expect(r1.mounted).toHaveLength(1)
    // Second call: cache hit
    const r2 = await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [baseConfig],
      loaders: { claude: fakeLoader('claude', claudeSkillDir) },
      ensureRepo: okRepo(source),
      resolveRef: async () => 'sha-1',
      requestApproval: async () => true,
    })
    expect(r2.mounted).toHaveLength(0)
    expect(r2.skipped.some((s) => s.reason === 'cache-hit')).toBe(true)
  })

  it('unsupported vendor → skip + greyed, session still launched', async () => {
    const result = await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [baseConfig],
      loaders: { claude: unsupportedLoader('claude', claudeSkillDir) },
      ensureRepo: okRepo(join(tmpRoot, 'source')),
      resolveRef: async () => 'sha-1',
      requestApproval: async () => true,
    })
    expect(result.mounted).toHaveLength(0)
    expect(result.greyed).toContain('claude')
    expect(result.skipped.some((s) => s.reason === 'unsupported')).toBe(true)
  })

  it('fans out to every build-link-capable vendor', async () => {
    const source = join(tmpRoot, 'source')
    await mkdir(source, { recursive: true })
    const result = await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [baseConfig],
      loaders: {
        claude: fakeLoader('claude', claudeSkillDir),
        codex: fakeLoader('codex', codexSkillDir),
      },
      ensureRepo: okRepo(source),
      resolveRef: async () => 'sha-1',
      requestApproval: async () => true,
    })
    expect(result.mounted).toHaveLength(2)
    expect(result.mounted.map((m) => m.vendor).sort()).toEqual(['claude', 'codex'])
  })

  it('repo error → skip (not throw)', async () => {
    const result = await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [baseConfig],
      loaders: { claude: fakeLoader('claude', claudeSkillDir) },
      ensureRepo: failRepo('clone failed'),
      resolveRef: async () => 'sha-1',
      requestApproval: async () => true,
    })
    expect(result.mounted).toHaveLength(0)
    expect(result.skipped.some((s) => s.reason === 'repo-error')).toBe(true)
  })

  it('gitignore ack is consumed after first approval', async () => {
    const source = join(tmpRoot, 'source')
    await mkdir(source, { recursive: true })
    let gitignoreCount = 0
    const approve = async (ask: SkillApprovalAsk) => {
      if (ask.kind === 'gitignore') gitignoreCount++
      return true
    }
    await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [baseConfig],
      loaders: { claude: fakeLoader('claude', claudeSkillDir) },
      ensureRepo: okRepo(source),
      resolveRef: async () => 'sha-1',
      requestApproval: approve,
    })
    expect(gitignoreCount).toBe(1)
    // Second mount: gitignore already acked → no new gitignore approval
    await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [{ ...baseConfig, id: 's2' }],
      loaders: { claude: fakeLoader('claude', claudeSkillDir) },
      ensureRepo: okRepo(source),
      resolveRef: async () => 'sha-2',
      requestApproval: approve,
    })
    expect(gitignoreCount).toBe(1) // no new gitignore approval
  })

  it('gitignore cancel → skip (gitignore-cancelled), session still launches', async () => {
    const result = await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [baseConfig],
      loaders: { claude: fakeLoader('claude', claudeSkillDir) },
      ensureRepo: okRepo(join(tmpRoot, 'source')),
      resolveRef: async () => 'sha-1',
      requestApproval: async () => false,
    })
    expect(result.mounted).toHaveLength(0)
    expect(result.skipped.some((s) => s.reason === 'gitignore-cancelled')).toBe(true)
  })
})
