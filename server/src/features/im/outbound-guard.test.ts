/**
 * Content screening and the sole controlled send entry. Behavioural proofs go
 * through a fake rawSend so nothing reaches a real platform here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import { renderRobotMessage } from './robot-message-registry.js'
import {
  screenOutbound,
  sendGuarded,
  sendGuardedBroadcast,
  type RawImSend,
} from './outbound-guard.js'
import {
  acknowledgeOutbound,
  createRobot,
  resetRobotStoreForTests,
  setRobotEnabled,
  updateRobot,
  type CreateRobotInput,
} from './robot-store.js'

const MAX = 4000
const CTX = { personalLocale: 'zh' as const, robotLocale: 'zh' as const }

let home: string

const robotInput = (over: Partial<CreateRobotInput> = {}): CreateRobotInput => ({
  name: 'helper',
  platform: 'feishu',
  appId: 'cli_app',
  appSecret: 'secret',
  vendor: 'claude',
  agentId: 'agent-1',
  ...over,
})

function enabledRobot(): string {
  const robot = createRobot(robotInput())
  acknowledgeOutbound(robot.id)
  setRobotEnabled(robot.id, true)
  return robot.id
}

function rawRecorder(): {
  sent: { chatId: string; text: string; replyTo?: string }[]
  rawSend: RawImSend
} {
  const sent: { chatId: string; text: string; replyTo?: string }[] = []
  return {
    sent,
    rawSend: (chatId, out) => {
      sent.push({ chatId, text: out.text, ...(out.replyTo ? { replyTo: out.replyTo } : {}) })
      return Promise.resolve({ messageId: `out-${sent.length}` })
    },
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-im-guard-'))
  process.env.C3_DB_PATH = join(home, 'c3.db')
  process.env.C3_DIR = home
  resetDbForTests()
  resetRobotStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  resetRobotStoreForTests()
  rmSync(home, { recursive: true, force: true })
})

describe('screenOutbound — refuses credential shapes', () => {
  it('refuses well-known token formats', () => {
    for (const text of [
      'the key is ghp_abcdefghijklmnopqrstuvwxyz012345',
      'Authorization: Bearer abcdefghijklmnopqrstuvwx',
      'use sk-ant-abcdefghijklmnopqrstuvwx',
      'AKIAIOSFODNN7EXAMPLE is the id',
      '-----BEGIN RSA PRIVATE KEY-----',
      'api_key = 9f8e7d6c5b4a3f2e1d0c',
    ]) {
      expect(screenOutbound(text, MAX)).toEqual({ ok: false, reason: 'credential' })
    }
  })

  it('never echoes what it matched', () => {
    const verdict = screenOutbound('token: 9f8e7d6c5b4a3f2e1d0c', MAX)
    expect(JSON.stringify(verdict)).not.toContain('9f8e7d6c5b4a3f2e1d0c')
  })
})

describe('screenOutbound — lets real answers through', () => {
  it('delivers an answer containing a code block', () => {
    const text = 'Use this:\n```ts\nconst x = 1\n```'
    expect(screenOutbound(text, MAX)).toEqual({ ok: true, text })
  })
})

describe('screenOutbound — truncation is visible', () => {
  it('appends a cut notice when trimming', () => {
    const long = 'x'.repeat(500)
    const verdict = screenOutbound(long, 80)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.text.length).toBeLessThanOrEqual(80)
      expect(verdict.text).toContain('截断')
    }
  })
})

describe('sendGuarded — readiness and target', () => {
  it('refuses when the robot is disabled', async () => {
    const robot = createRobot(robotInput())
    acknowledgeOutbound(robot.id)
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: robot.id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: { category: 'final_answer', text: 'hello' },
      maxOutboundChars: MAX,
      renderContext: CTX,
      rawSend,
    })
    expect(result).toMatchObject({ ok: false, reason: 'disabled', outboundChars: 0 })
    expect(sent).toEqual([])
  })

  it('refuses when outbound ack was cleared after enable', async () => {
    const id = enabledRobot()
    // Store refuses enable-without-ack; clear the ack under the table to prove
    // the guard re-reads live state rather than trusting the inbound snapshot.
    getDb()!.run(
      'UPDATE im_robots SET outbound_ack_at = NULL, outbound_ack_hash = NULL WHERE id = ?',
      id,
    )
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: {
        category: 'fixed_notice',
        message: { key: 'runtime.busy', params: {} },
      },
      maxOutboundChars: MAX,
      renderContext: CTX,
      rawSend,
    })
    expect(result).toMatchObject({
      ok: false,
      reason: 'outbound_not_acknowledged',
      outboundChars: 0,
    })
    expect(sent).toEqual([])
  })

  it('refuses a group that left the allowlist', async () => {
    const id = enabledRobot()
    updateRobot(id, { chatAllowlist: ['oc_allowed'] })
    acknowledgeOutbound(id)
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_other', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: { category: 'final_answer', text: 'hello' },
      maxOutboundChars: MAX,
      renderContext: CTX,
      rawSend,
    })
    expect(result).toMatchObject({ ok: false, reason: 'chat_not_allowed' })
    expect(sent).toEqual([])
  })

  it('refuses a DM after the allowlist tightens', async () => {
    const id = enabledRobot()
    updateRobot(id, { dmMode: 'allowlist', dmAllowlist: ['ou_ok'] })
    acknowledgeOutbound(id)
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_dm', chatType: 'p2p', senderId: 'ou_other', replyTo: 'm1' },
      content: { category: 'final_answer', text: 'hello' },
      maxOutboundChars: MAX,
      renderContext: CTX,
      rawSend,
    })
    expect(result).toMatchObject({ ok: false, reason: 'dm_not_allowed' })
    expect(sent).toEqual([])
  })
})

describe('sendGuarded — content categories', () => {
  it('sends a normal final answer through rawSend once, without a replyTo quote', async () => {
    const id = enabledRobot()
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u' },
      content: { category: 'final_answer', text: 'the build is green' },
      maxOutboundChars: MAX,
      renderContext: CTX,
      rawSend,
    })
    expect(result).toMatchObject({
      ok: true,
      text: 'the build is green',
      outboundChars: 'the build is green'.length,
    })
    // Default target carries no replyTo, so rawSend receives a direct-send payload.
    expect(sent).toEqual([{ chatId: 'oc_1', text: 'the build is green' }])
    expect(sent[0]?.replyTo).toBeUndefined()
  })

  it('passes replyTo through when the target explicitly sets it', async () => {
    const id = enabledRobot()
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: { category: 'final_answer', text: 'hello' },
      maxOutboundChars: MAX,
      renderContext: CTX,
      rawSend,
    })
    expect(result.ok).toBe(true)
    expect(sent).toEqual([{ chatId: 'oc_1', text: 'hello', replyTo: 'm1' }])
  })

  it('swaps a credential-shaped answer for the intercept notice without echoing the secret', async () => {
    const id = enabledRobot()
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz012345'
    const expected = renderRobotMessage(
      { key: 'runtime.guardRefused', params: { nav: { kind: 'webEntry' } } },
      CTX,
    )
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: { category: 'final_answer', text: `the key is ${secret}` },
      maxOutboundChars: MAX,
      renderContext: CTX,
      rawSend,
    })
    expect(result).toMatchObject({
      ok: false,
      reason: 'credential',
      outboundChars: expected.length,
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toBe(expected)
    expect(JSON.stringify(sent)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('sends each runtime fixed notice without credential scanning', async () => {
    const id = enabledRobot()
    const runtimeKeys = [
      'runtime.timeout',
      'runtime.blocked',
      'runtime.error',
      'runtime.busy',
      'runtime.storeUnavailable',
      'runtime.inputRejectedCredential',
    ] as const
    for (const key of runtimeKeys) {
      const expected = renderRobotMessage(
        {
          key,
          params:
            key === 'runtime.blocked' || key === 'runtime.error'
              ? { nav: { kind: 'webEntry' } }
              : {},
        },
        CTX,
      )
      const { sent, rawSend } = rawRecorder()
      const result = await sendGuarded({
        robotId: id,
        target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u' },
        content: {
          category: 'fixed_notice',
          message: {
            key,
            params:
              key === 'runtime.blocked' || key === 'runtime.error'
                ? { nav: { kind: 'webEntry' } }
                : {},
          },
        },
        maxOutboundChars: MAX,
        renderContext: CTX,
        rawSend,
      })
      expect(result.ok).toBe(true)
      expect(sent).toEqual([{ chatId: 'oc_1', text: expected }])
    }
  })

  it('refuses binding notices forged as fixed_notice at runtime', async () => {
    const id = enabledRobot()
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: {
        category: 'fixed_notice',
        message: { key: 'binding.success', params: {} },
      },
      maxOutboundChars: MAX,
      renderContext: CTX,
      rawSend,
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid_notice', outboundChars: 0 })
    expect(sent).toEqual([])
  })

  it('refuses broadcast keys on fixed_notice path', async () => {
    const id = enabledRobot()
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: {
        category: 'fixed_notice',
        message: { key: 'broadcast.automationPaused', params: { title: 'x' } },
      },
      maxOutboundChars: MAX,
      renderContext: CTX,
      rawSend,
    })
    expect(result).toMatchObject({ ok: false, reason: 'invalid_notice', outboundChars: 0 })
    expect(sent).toEqual([])
  })

  it('delivers binding notices only through binding_notice with origin constraints', async () => {
    const id = enabledRobot()
    const target = {
      chatId: 'ou_user',
      chatType: 'p2p' as const,
      senderId: 'ou_user',
    }
    const expected = renderRobotMessage({ key: 'binding.success', params: {} }, CTX)
    const { sent, rawSend } = rawRecorder()
    const ok = await sendGuarded({
      robotId: id,
      target,
      content: {
        category: 'binding_notice',
        message: { key: 'binding.success', params: {} },
        origin: target,
      },
      maxOutboundChars: MAX,
      renderContext: CTX,
      rawSend,
    })
    expect(ok.ok).toBe(true)
    expect(sent[0]?.text).toBe(expected)
  })

  it('refuses binding notices retargeted to another chat or sender', async () => {
    const id = enabledRobot()
    const origin = {
      chatId: 'ou_user',
      chatType: 'p2p' as const,
      senderId: 'ou_user',
    }
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'ou_other', chatType: 'p2p', senderId: 'ou_other' },
      content: {
        category: 'binding_notice',
        message: { key: 'binding.success', params: {} },
        origin,
      },
      maxOutboundChars: MAX,
      renderContext: CTX,
      rawSend,
    })
    expect(result).toMatchObject({ ok: false, reason: 'binding_target_mismatch' })
    expect(sent).toEqual([])
  })

  it('refuses bind_success in a group even as binding_notice', async () => {
    const id = enabledRobot()
    const target = { chatId: 'oc_1', chatType: 'group' as const, senderId: 'ou_u', replyTo: 'm1' }
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target,
      content: {
        category: 'binding_notice',
        message: { key: 'binding.success', params: {} },
        origin: target,
      },
      maxOutboundChars: MAX,
      renderContext: CTX,
      rawSend,
    })
    expect(result).toMatchObject({ ok: false, reason: 'binding_not_p2p' })
    expect(sent).toEqual([])
  })

  it('truncates a long fixed notice to the platform limit', async () => {
    const id = enabledRobot()
    const { sent, rawSend } = rawRecorder()
    const full = renderRobotMessage(
      { key: 'runtime.blocked', params: { nav: { kind: 'webEntry' } } },
      CTX,
    )
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: {
        category: 'fixed_notice',
        message: { key: 'runtime.blocked', params: { nav: { kind: 'webEntry' } } },
      },
      maxOutboundChars: 12,
      renderContext: CTX,
      rawSend,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text.length).toBeLessThanOrEqual(12)
      expect(result.outboundChars).toBe(result.text.length)
      expect(full.length).toBeGreaterThan(12)
    }
    expect(sent[0]?.text.length).toBeLessThanOrEqual(12)
  })

  it('truncates a long final answer with an explicit cut notice', async () => {
    const id = enabledRobot()
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: { category: 'final_answer', text: 'x'.repeat(500) },
      maxOutboundChars: 80,
      renderContext: CTX,
      rawSend,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text.length).toBeLessThanOrEqual(80)
      expect(result.text).toContain('截断')
    }
    expect(sent[0]?.text).toContain('截断')
  })

  it('records a sanitized send_failed when the platform rejects', async () => {
    const id = enabledRobot()
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz012345'
    const rawSend: RawImSend = () => Promise.reject(new Error(`request failed: token=${secret}`))
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: { category: 'final_answer', text: 'hello' },
      maxOutboundChars: MAX,
      renderContext: CTX,
      rawSend,
    })
    expect(result).toMatchObject({ ok: false, reason: 'send_failed', outboundChars: 0 })
    if (!result.ok) {
      expect(result.error).toContain('request failed')
      expect(result.error).toContain('[redacted]')
      expect(result.error).not.toContain(secret)
      expect(JSON.stringify(result)).not.toContain(secret)
    }
  })

  it('invokes rawSend at most once per guarded attempt', async () => {
    const id = enabledRobot()
    const rawSend = vi.fn<RawImSend>().mockResolvedValue({ messageId: 'out-1' })
    await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: { category: 'final_answer', text: 'hello' },
      maxOutboundChars: MAX,
      renderContext: CTX,
      rawSend,
    })
    expect(rawSend).toHaveBeenCalledTimes(1)
  })
})

describe('sendGuardedBroadcast — same guard pipeline', () => {
  it('refuses when outbound config hash is stale after L0 config change', async () => {
    const id = enabledRobot()
    updateRobot(id, { broadcastEventTypes: ['intent_parked'] })
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuardedBroadcast({
      robotId: id,
      target: { kind: 'p2p_dm', chatId: 'ou_u', senderId: 'ou_u', fullTemplate: true },
      kind: 'intent_parked',
      fields: {
        eventType: 'intent_parked',
        objectType: 'intent',
        objectId: 'i1',
        objectTitle: 'hello',
      },
      idempotencyKey: 'k1',
      objectWorkspace: 'ws',
      maxOutboundChars: MAX,
      rawSend,
    })
    expect(result).toMatchObject({ ok: false, reason: 'outbound_config_stale' })
    expect(sent).toEqual([])
  })

  it('delivers broadcast through rawSend when config is re-acknowledged', async () => {
    const id = enabledRobot()
    updateRobot(id, {
      broadcastEventTypes: ['intent_parked'],
      broadcastToBoundUsers: true,
      dmMode: 'open',
    })
    acknowledgeOutbound(id)
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuardedBroadcast({
      robotId: id,
      target: { kind: 'p2p_dm', chatId: 'ou_u', senderId: 'ou_u', fullTemplate: true },
      kind: 'intent_parked',
      fields: {
        eventType: 'intent_parked',
        objectType: 'intent',
        objectId: 'i1',
        objectTitle: 'hello',
      },
      idempotencyKey: 'k1',
      objectWorkspace: 'ws',
      maxOutboundChars: MAX,
      rawSend,
    })
    expect(result.ok).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.replyTo).toBeUndefined()
  })
})
