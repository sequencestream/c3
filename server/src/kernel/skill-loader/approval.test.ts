/**
 * Unit tests for the pre-launch skill-load `.gitignore` gate (mount layer 2/3).
 * External skills mount silently now, so the only gate is the one-time `.gitignore`
 * append ack plus the request→resolve transport.
 *
 * Covers:
 * - needsGitignoreAck / recordGitignoreAck: one-time ack semantics
 * - requestSkillApproval / resolveSkillApproval: transport (request→resolve→resolved)
 *
 * From repo root: `rtk proxy npx vitest run skill-loader/approval.test.ts`
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  needsGitignoreAck,
  recordGitignoreAck,
  requestSkillApproval,
  resolveSkillApproval,
  cancelAllSkillApprovals,
  setSkillApprovalSend,
  pendingSkillApprovalCount,
} from './approval.js'
import { resetStateCacheForTests } from '../../state.js'

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
      kind: 'gitignore',
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
