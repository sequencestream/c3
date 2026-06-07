/**
 * Unit tests for the skill mount lifecycle orchestrator (mount layer 2/3).
 *
 * Covers:
 * - ensureLinksForLaunch: full path, cache hit, unsupported vendor (grey),
 *   unreviewed cancel → SkillLoadCancelled, .gitignore ack gate,
 *   trust review-on-update first-load + same-ref silent + ref-change re-ask,
 *   repo error → skip (not throw).
 * - scanOrphans: finds unreviewed unconsumed mounts.
 * - markMountsConsumed: clears orphan status.
 *
 * From repo root: `rtk proxy npx vitest run skill-loader/index.test.ts`
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SkillRepoConfig, VendorId } from '@ccc/shared/protocol'
import type { SkillLoader, SkillSupportReport } from '../agent/adapters/types.js'
import {
  resetStateCacheForTests,
  setSkillSupport,
  setSkillLink,
  skillLinkKey,
} from '../../state.js'
import {
  ensureLinksForLaunch,
  scanOrphans,
  markMountsConsumed,
  SkillLoadCancelled,
} from './index.js'
import type { EnsureSkillRepoResult } from '../../skill-repo.js'
import type { SkillApprovalAsk } from './approval.js'
import { recordGitignoreAck, recordTrustAck, setSkillApprovalSend } from './approval.js'

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
  trust: 'unreviewed',
  vendor: 'claude',
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
      configs: [{ ...baseConfig, trust: 'pinned', pinCommit: 'a'.repeat(40) }],
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
      configs: [{ ...baseConfig, trust: 'pinned', pinCommit: 'a'.repeat(40) }],
      loaders: { claude: fakeLoader('claude', claudeSkillDir) },
      ensureRepo: okRepo(source),
      resolveRef: async () => 'sha-1',
      requestApproval: async () => true,
    })
    expect(r1.mounted).toHaveLength(1)
    // Second call: cache hit
    const r2 = await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [{ ...baseConfig, trust: 'pinned', pinCommit: 'a'.repeat(40) }],
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

  it('vendor=all → expands to all full vendors', async () => {
    const source = join(tmpRoot, 'source')
    await mkdir(source, { recursive: true })
    const result = await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [{ ...baseConfig, vendor: 'all', trust: 'pinned', pinCommit: 'a'.repeat(40) }],
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

  it('unreviewed + cancel → throws SkillLoadCancelled', async () => {
    // Pre-ack the gitignore gate so the trust gate is the one being tested.
    recordGitignoreAck(tmpRoot)
    await expect(
      ensureLinksForLaunch({
        projectDir: tmpRoot,
        configs: [{ ...baseConfig, trust: 'unreviewed' }],
        loaders: { claude: fakeLoader('claude', claudeSkillDir) },
        ensureRepo: okRepo(join(tmpRoot, 'source')),
        resolveRef: async () => 'sha-1',
        requestApproval: async () => false,
      }),
    ).rejects.toThrow(SkillLoadCancelled)
  })

  it('review-on-update: same ref after ack → silent (no approval needed)', async () => {
    const source = join(tmpRoot, 'source')
    await mkdir(source, { recursive: true })
    let approvalCount = 0
    const approve = async () => {
      approvalCount++
      return true
    }
    // Mount once (first-load → approval fired)
    await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [{ ...baseConfig, vendor: 'all', trust: 'review-on-update' }],
      loaders: { claude: fakeLoader('claude', claudeSkillDir) },
      ensureRepo: okRepo(source),
      resolveRef: async () => 'sha-1',
      requestApproval: approve,
    })
    const firstCount = approvalCount
    // Remount same ref → no approval fired
    await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [{ ...baseConfig, vendor: 'all', trust: 'review-on-update' }],
      loaders: { claude: fakeLoader('claude', claudeSkillDir) },
      ensureRepo: okRepo(source),
      resolveRef: async () => 'sha-1',
      requestApproval: approve,
    })
    expect(approvalCount).toBe(firstCount) // no new approval
  })

  it('repo error → skip (not throw)', async () => {
    const result = await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [{ ...baseConfig, trust: 'pinned', pinCommit: 'a'.repeat(40) }],
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
      configs: [{ ...baseConfig, trust: 'pinned', pinCommit: 'a'.repeat(40) }],
      loaders: { claude: fakeLoader('claude', claudeSkillDir) },
      ensureRepo: okRepo(source),
      resolveRef: async () => 'sha-1',
      requestApproval: approve,
    })
    expect(gitignoreCount).toBe(1)
    // Second mount: gitignore already acked → no new gitignore approval
    await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [{ ...baseConfig, id: 's2', trust: 'pinned', pinCommit: 'b'.repeat(40) }],
      loaders: { claude: fakeLoader('claude', claudeSkillDir) },
      ensureRepo: okRepo(source),
      resolveRef: async () => 'sha-2',
      requestApproval: approve,
    })
    expect(gitignoreCount).toBe(1) // no new gitignore approval
  })

  it('consumableKeys returned for cache-hit and mounted', async () => {
    const source = join(tmpRoot, 'source')
    await mkdir(source, { recursive: true })
    const r1 = await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [{ ...baseConfig, trust: 'pinned', pinCommit: 'a'.repeat(40) }],
      loaders: { claude: fakeLoader('claude', claudeSkillDir) },
      ensureRepo: okRepo(source),
      resolveRef: async () => 'sha-1',
      requestApproval: async () => true,
    })
    expect(r1.consumableKeys).toHaveLength(1)
    // Second call: cache hit → also returned
    const r2 = await ensureLinksForLaunch({
      projectDir: tmpRoot,
      configs: [{ ...baseConfig, trust: 'pinned', pinCommit: 'a'.repeat(40) }],
      loaders: { claude: fakeLoader('claude', claudeSkillDir) },
      ensureRepo: okRepo(source),
      resolveRef: async () => 'sha-1',
      requestApproval: async () => true,
    })
    expect(r2.consumableKeys).toHaveLength(1)
  })
})

describe('scanOrphans', () => {
  let origConfigDir: string | undefined
  beforeEach(() => {
    origConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'orphans-' + Math.random())
    resetStateCacheForTests()
  })
  afterEach(() => {
    if (origConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = origConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    resetStateCacheForTests()
  })

  it('returns empty when no links exist', () => {
    expect(scanOrphans()).toEqual([])
  })

  it('finds unreviewed unconsumed mounts', () => {
    setSkillLink(skillLinkKey('/p', 'claude', 's1'), {
      id: 's1',
      projectDir: '/p',
      vendor: 'claude',
      linkPath: '/p/.claude/skills/_c3_s1',
      target: '/cache/s1',
      ref: 'sha-1',
      trust: 'unreviewed',
      createdAt: 1,
    })
    const orphans = scanOrphans()
    expect(orphans).toHaveLength(1)
    expect(orphans[0].id).toBe('s1')
  })

  it('does NOT flag consumed unreviewed mounts', () => {
    setSkillLink(skillLinkKey('/p', 'claude', 's1'), {
      id: 's1',
      projectDir: '/p',
      vendor: 'claude',
      linkPath: '/p/.claude/skills/_c3_s1',
      target: '/cache/s1',
      ref: 'sha-1',
      trust: 'unreviewed',
      createdAt: 1,
      consumedAt: 2,
    })
    expect(scanOrphans()).toEqual([])
  })

  it('does NOT flag pinned mounts as orphans', () => {
    setSkillLink(skillLinkKey('/p', 'claude', 's1'), {
      id: 's1',
      projectDir: '/p',
      vendor: 'claude',
      linkPath: '/p/.claude/skills/_c3_s1',
      target: '/cache/s1',
      ref: 'sha-1',
      trust: 'pinned',
      createdAt: 1,
    })
    expect(scanOrphans()).toEqual([])
  })
})

describe('markMountsConsumed', () => {
  let origConfigDir: string | undefined
  beforeEach(() => {
    origConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'consumed-' + Math.random())
    resetStateCacheForTests()
  })
  afterEach(() => {
    if (origConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = origConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    resetStateCacheForTests()
  })

  it('sets consumedAt on the link record', () => {
    const key = skillLinkKey('/p', 'claude', 's1')
    setSkillLink(key, {
      id: 's1',
      projectDir: '/p',
      vendor: 'claude',
      linkPath: '/p/.claude/skills/_c3_s1',
      target: '/cache/s1',
      ref: 'sha-1',
      trust: 'unreviewed',
      createdAt: 1,
    })
    markMountsConsumed([key], () => 42)
    const orphans = scanOrphans()
    expect(orphans).toHaveLength(0) // consumed → no longer orphan
  })
})
