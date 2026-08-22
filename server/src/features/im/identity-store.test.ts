/**
 * Identity binding store — challenge lifecycle, uniqueness, revoke, group scope,
 * and policy-epoch coupling.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseConfigDb, useConfigDb } from '../../kernel/config/config-fixture.js'
import { readPolicyEpoch } from '../../kernel/config/policy-epoch.js'
import {
  acknowledgeOutbound,
  createRobot,
  ensureRobotSchema,
  resetRobotStoreForTests,
  setRobotEnabled,
} from './robot-store.js'
import {
  accountNamespaceOf,
  cancelChallenge,
  consumeChallenge,
  createChallenge,
  ensureIdentitySchema,
  getActiveBindingForSender,
  getMyActiveBinding,
  getMyPendingChallenge,
  listIdentityAudit,
  resetIdentityStoreForTests,
  revokeMyBinding,
  setGroupWorkspaceScopes,
  setIdentityStoreClockForTests,
} from './identity-store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-im-id-'))
  useConfigDb(dir)
  resetRobotStoreForTests()
  resetIdentityStoreForTests()
  expect(ensureRobotSchema()).toBe(true)
  expect(ensureIdentitySchema()).toBe(true)
})

afterEach(() => {
  setIdentityStoreClockForTests(null)
  resetIdentityStoreForTests()
  resetRobotStoreForTests()
  releaseConfigDb()
  rmSync(dir, { recursive: true, force: true })
})

function readyRobot(): string {
  const r = createRobot({
    name: 'helper',
    platform: 'feishu',
    appId: 'cli_app',
    appSecret: 'secret',
    vendor: 'claude',
    agentId: 'default',
  })
  acknowledgeOutbound(r.id)
  setRobotEnabled(r.id, true)
  return r.id
}

describe('identity challenge + bind', () => {
  it('creates a challenge with plaintext once; pending replaces prior', () => {
    const robotId = readyRobot()
    const a = createChallenge('alice', robotId)
    expect(a.token.length).toBeGreaterThanOrEqual(20)
    expect(a.accountNamespace).toBe('feishu:cli_app')
    const pending = getMyPendingChallenge('alice')
    expect(pending?.challengeId).toBe(a.challengeId)

    const b = createChallenge('alice', robotId)
    expect(b.challengeId).not.toBe(a.challengeId)
    expect(getMyPendingChallenge('alice')?.challengeId).toBe(b.challengeId)

    const fail = consumeChallenge({
      robotId,
      accountNamespace: a.accountNamespace,
      senderId: 'ou_1',
      token: a.token,
    })
    expect(fail.ok).toBe(false)
  })

  it('consumes in one shot and bumps policy epoch', () => {
    const robotId = readyRobot()
    const before = readPolicyEpoch()
    const ch = createChallenge('alice', robotId)
    const ok = consumeChallenge({
      robotId,
      accountNamespace: ch.accountNamespace,
      senderId: 'ou_1',
      token: ch.token,
    })
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.binding.subject).toBe('local')
    expect(readPolicyEpoch()).toBeGreaterThan(before)
    expect(getActiveBindingForSender(ch.accountNamespace, 'ou_1')?.id).toBe(ok.binding.id)

    const replay = consumeChallenge({
      robotId,
      accountNamespace: ch.accountNamespace,
      senderId: 'ou_1',
      token: ch.token,
    })
    expect(replay.ok).toBe(false)
    expect(listIdentityAudit().some((e) => e.eventType === 'challenge_consume_failed')).toBe(true)
  })

  it('rejects second sender uniqueness conflict without revealing which side', () => {
    const robotId = readyRobot()
    const ch1 = createChallenge('alice', robotId)
    expect(
      consumeChallenge({
        robotId,
        accountNamespace: ch1.accountNamespace,
        senderId: 'ou_1',
        token: ch1.token,
      }).ok,
    ).toBe(true)

    const ch2 = createChallenge('bob', robotId)
    const conflict = consumeChallenge({
      robotId,
      accountNamespace: ch2.accountNamespace,
      senderId: 'ou_2',
      token: ch2.token,
    })
    expect(conflict.ok).toBe(false)
    expect(getActiveBindingForSender(ch2.accountNamespace, 'ou_2')).toBeNull()
    expect(
      listIdentityAudit().some(
        (e) => e.eventType === 'challenge_consume_failed' && e.reasonCode === 'uniqueness_conflict',
      ),
    ).toBe(true)
  })

  it('expires pending after TTL', () => {
    const robotId = readyRobot()
    let t = 1_000_000
    setIdentityStoreClockForTests(() => t)
    const ch = createChallenge('alice', robotId)
    t += 11 * 60 * 1000
    const fail = consumeChallenge({
      robotId,
      accountNamespace: ch.accountNamespace,
      senderId: 'ou_1',
      token: ch.token,
    })
    expect(fail.ok).toBe(false)
  })

  it('cancel clears pending', () => {
    const robotId = readyRobot()
    const ch = createChallenge('alice', robotId)
    cancelChallenge('alice', ch.challengeId)
    expect(getMyPendingChallenge('alice')).toBeNull()
  })

  it('revoke bumps epoch and clears active', () => {
    const robotId = readyRobot()
    const ch = createChallenge('alice', robotId)
    const bound = consumeChallenge({
      robotId,
      accountNamespace: ch.accountNamespace,
      senderId: 'ou_1',
      token: ch.token,
    })
    expect(bound.ok).toBe(true)
    if (!bound.ok) return
    const before = readPolicyEpoch()
    revokeMyBinding('alice', bound.binding.id)
    expect(readPolicyEpoch()).toBeGreaterThan(before)
    expect(getMyActiveBinding('alice')).toBeNull()
    expect(getActiveBindingForSender(ch.accountNamespace, 'ou_1')).toBeNull()
  })
})

describe('group workspace scopes', () => {
  it('replaces whole set and bumps epoch', () => {
    const before = readPolicyEpoch()
    const grants = setGroupWorkspaceScopes('admin', 'feishu', 'cli_app', 'oc_g', [
      'ws-b',
      'ws-a',
      'ws-a',
    ])
    expect(grants.map((g) => g.workspaceName)).toEqual(['ws-a', 'ws-b'])
    expect(readPolicyEpoch()).toBeGreaterThan(before)
  })
})

describe('accountNamespaceOf', () => {
  it('joins platform and appId', () => {
    expect(accountNamespaceOf('feishu', 'cli_x')).toBe('feishu:cli_x')
  })
})
