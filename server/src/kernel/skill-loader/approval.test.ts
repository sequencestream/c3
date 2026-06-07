/**
 * Unit tests for the pre-launch skill-load approval gates (mount layer 2/3).
 *
 * Covers:
 * - evaluateTrustGate: pinned/review-on-update/unreviewed × first-load/ref-change/same-ref
 * - recordTrustAck: only review-on-update writes reviewedRef
 * - needsGitignoreAck / recordGitignoreAck: one-time ack semantics
 * - requestSkillApproval / resolveSkillApproval: transport (request→resolve→resolved)
 * - SkillLoadCancelled: not tested here (covered by index.test.ts)
 *
 * From repo root: `rtk proxy npx vitest run skill-loader/approval.test.ts`
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join, resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { SkillRepoConfig, VendorId } from '@ccc/shared/protocol'
import {
  evaluateTrustGate,
  recordTrustAck,
  needsGitignoreAck,
  recordGitignoreAck,
  requestSkillApproval,
  resolveSkillApproval,
  cancelAllSkillApprovals,
  setSkillApprovalSend,
  pendingSkillApprovalCount,
} from './approval.js'
import { getSkillAck, resetStateCacheForTests } from '../../state.js'
import { skillLinkKey } from '../../state.js'

function cfg(overrides: Partial<SkillRepoConfig> = {}): SkillRepoConfig {
  return {
    id: 'my-skill',
    repo: 'https://github.com/test/repo',
    ref: 'main',
    trust: 'unreviewed',
    ...overrides,
  }
}

describe('evaluateTrustGate', () => {
  let projectDir: string
  let origConfigDir: string | undefined

  beforeEach(async () => {
    origConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'approval-gate-'))
    resetStateCacheForTests()
    projectDir = process.env.CLAUDE_CONFIG_DIR
  })
  afterEach(async () => {
    if (origConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = origConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    resetStateCacheForTests()
    await rm(projectDir, { recursive: true, force: true }).catch(() => {})
  })

  it('pinned: never needs approval (cat-file check is the gate)', () => {
    const result = evaluateTrustGate(
      projectDir,
      cfg({ trust: 'pinned', pinCommit: 'a'.repeat(40) }),
      'claude',
      'sha-1',
    )
    expect(result.needsApproval).toBe(false)
  })

  it('unreviewed: always needs approval', () => {
    const result = evaluateTrustGate(projectDir, cfg({ trust: 'unreviewed' }), 'claude', 'sha-1')
    expect(result.needsApproval).toBe(true)
    if (result.needsApproval) expect(result.reason).toBe('first-load')
  })

  it('review-on-update: first load needs approval', () => {
    const result = evaluateTrustGate(
      projectDir,
      cfg({ trust: 'review-on-update' }),
      'claude',
      'sha-1',
    )
    expect(result.needsApproval).toBe(true)
    if (result.needsApproval) expect(result.reason).toBe('first-load')
  })

  it('review-on-update: same ref after ack → silent', () => {
    recordTrustAck(projectDir, cfg({ trust: 'review-on-update' }), 'claude', 'sha-1')
    const result = evaluateTrustGate(
      projectDir,
      cfg({ trust: 'review-on-update' }),
      'claude',
      'sha-1',
    )
    expect(result.needsApproval).toBe(false)
  })

  it('review-on-update: changed ref after ack → needs approval', () => {
    recordTrustAck(projectDir, cfg({ trust: 'review-on-update' }), 'claude', 'sha-1')
    const result = evaluateTrustGate(
      projectDir,
      cfg({ trust: 'review-on-update' }),
      'claude',
      'sha-2',
    )
    expect(result.needsApproval).toBe(true)
    if (result.needsApproval) expect(result.reason).toBe('ref-change')
  })
})

describe('recordTrustAck', () => {
  let projectDir: string
  let origConfigDir: string | undefined

  beforeEach(async () => {
    origConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'approval-ack-'))
    resetStateCacheForTests()
    projectDir = process.env.CLAUDE_CONFIG_DIR
  })
  afterEach(async () => {
    if (origConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = origConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    resetStateCacheForTests()
    await rm(projectDir, { recursive: true, force: true }).catch(() => {})
  })

  it('review-on-update: records reviewedRef', () => {
    const config = cfg({ trust: 'review-on-update' })
    recordTrustAck(projectDir, config, 'claude', 'sha-42')
    const key = skillLinkKey(projectDir, 'claude', config.id)
    expect(getSkillAck(key)?.reviewedRef).toBe('sha-42')
  })

  it('unreviewed: does NOT record reviewedRef', () => {
    const config = cfg({ trust: 'unreviewed' })
    recordTrustAck(projectDir, config, 'claude', 'sha-42')
    const key = skillLinkKey(projectDir, 'claude', config.id)
    expect(getSkillAck(key)).toBeUndefined()
  })
})

describe('gitignore ack', () => {
  let projectDir: string
  let origConfigDir: string | undefined

  beforeEach(async () => {
    origConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = await mkdtemp(join(tmpdir(), 'approval-gitignore-'))
    resetStateCacheForTests()
    projectDir = process.env.CLAUDE_CONFIG_DIR
  })
  afterEach(async () => {
    if (origConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = origConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    resetStateCacheForTests()
    await rm(projectDir, { recursive: true, force: true }).catch(() => {})
  })

  it('initially needs ack', () => {
    expect(needsGitignoreAck(projectDir)).toBe(true)
  })

  it('after ack, no longer needs ack', () => {
    recordGitignoreAck(projectDir)
    expect(needsGitignoreAck(projectDir)).toBe(false)
  })
})

describe('transport (requestSkillApproval / resolveSkillApproval)', () => {
  let origConfigDir: string | undefined
  beforeEach(() => {
    origConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(tmpdir(), 'transport-' + Math.random())
    setSkillApprovalSend(() => {})
    resetStateCacheForTests()
  })
  afterEach(() => {
    if (origConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = origConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    cancelAllSkillApprovals()
    setSkillApprovalSend(() => {})
    resetStateCacheForTests()
  })

  it('resolves to true on approve', async () => {
    let capturedId = ''
    setSkillApprovalSend((msg) => {
      if (msg.type === 'skill_load_approval_request') capturedId = msg.requestId
    })
    const promise = requestSkillApproval({
      kind: 'trust',
      id: 's1',
      vendor: 'claude',
      repo: 'https://x',
      ref: 'main',
      detail: 'test',
    })
    expect(pendingSkillApprovalCount()).toBe(1)
    resolveSkillApproval(capturedId, 'approve')
    const result = await promise
    expect(result).toBe(true)
  })

  it('resolves to false on cancel', async () => {
    let capturedId = ''
    setSkillApprovalSend((msg) => {
      if (msg.type === 'skill_load_approval_request') capturedId = msg.requestId
    })
    const promise = requestSkillApproval({
      kind: 'gitignore',
      id: 's1',
      vendor: 'claude',
      repo: 'https://x',
      ref: 'main',
      detail: 'test',
    })
    resolveSkillApproval(capturedId, 'cancel')
    const result = await promise
    expect(result).toBe(false)
  })

  it('rejects unknown requestId gracefully', () => {
    expect(resolveSkillApproval('unknown', 'approve')).toBe(false)
  })
})
