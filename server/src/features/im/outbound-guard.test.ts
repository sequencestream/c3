/**
 * Content screening and the sole controlled send entry. Behavioural proofs go
 * through a fake rawSend so nothing reaches a real platform here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests } from '../../kernel/infra/db.js'
import {
  BINDING_FIXED_NOTICES,
  FIXED_NOTICES,
  GENERAL_FIXED_NOTICES,
  screenOutbound,
  sendGuarded,
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

  it('delivers prose that merely names a credential', () => {
    const text = 'The token is injected from the environment; it is not in the repo.'
    expect(screenOutbound(text, MAX).ok).toBe(true)
  })

  it('trims surrounding whitespace', () => {
    expect(screenOutbound('  answer  ', MAX)).toEqual({ ok: true, text: 'answer' })
  })
})

describe('screenOutbound — truncation is visible', () => {
  it('keeps a long answer within the platform limit', () => {
    const verdict = screenOutbound('x'.repeat(500), 100)
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.text.length).toBeLessThanOrEqual(100)
  })

  it('tells the reader the answer was cut, rather than just stopping', () => {
    const verdict = screenOutbound('x'.repeat(500), 100)
    expect(verdict.ok && verdict.text).toContain('截断')
  })

  it('leaves an answer at exactly the limit untouched', () => {
    const text = 'y'.repeat(100)
    expect(screenOutbound(text, 100)).toEqual({ ok: true, text })
  })
})

describe('sendGuarded — readiness and target', () => {
  it('refuses when the robot was disabled after the turn started', async () => {
    const id = enabledRobot()
    setRobotEnabled(id, false)
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: { category: 'final_answer', text: 'hello' },
      maxOutboundChars: MAX,
      rawSend,
    })
    expect(result).toMatchObject({ ok: false, reason: 'disabled', outboundChars: 0 })
    expect(sent).toEqual([])
  })

  it('refuses when outbound acknowledgement was cleared while still enabled', async () => {
    const id = enabledRobot()
    // Store refuses enable-without-ack; clear the ack under the table to prove
    // the guard re-reads live state rather than trusting the inbound snapshot.
    getDb()!.run('UPDATE im_robots SET outbound_ack_at = NULL WHERE id = ?', id)
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: { category: 'fixed_notice', notice: 'busy' },
      maxOutboundChars: MAX,
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
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_other', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: { category: 'final_answer', text: 'hello' },
      maxOutboundChars: MAX,
      rawSend,
    })
    expect(result).toMatchObject({ ok: false, reason: 'chat_not_allowed' })
    expect(sent).toEqual([])
  })

  it('refuses a DM after the allowlist tightens', async () => {
    const id = enabledRobot()
    updateRobot(id, { dmMode: 'allowlist', dmAllowlist: ['ou_ok'] })
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_dm', chatType: 'p2p', senderId: 'ou_other', replyTo: 'm1' },
      content: { category: 'final_answer', text: 'hello' },
      maxOutboundChars: MAX,
      rawSend,
    })
    expect(result).toMatchObject({ ok: false, reason: 'dm_not_allowed' })
    expect(sent).toEqual([])
  })
})

describe('sendGuarded — content categories', () => {
  it('sends a normal final answer through rawSend once', async () => {
    const id = enabledRobot()
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: { category: 'final_answer', text: 'the build is green' },
      maxOutboundChars: MAX,
      rawSend,
    })
    expect(result).toMatchObject({
      ok: true,
      text: 'the build is green',
      outboundChars: 'the build is green'.length,
    })
    expect(sent).toEqual([{ chatId: 'oc_1', text: 'the build is green', replyTo: 'm1' }])
  })

  it('swaps a credential-shaped answer for the intercept notice without echoing the secret', async () => {
    const id = enabledRobot()
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz012345'
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: { category: 'final_answer', text: `the key is ${secret}` },
      maxOutboundChars: MAX,
      rawSend,
    })
    expect(result).toMatchObject({
      ok: false,
      reason: 'credential',
      outboundChars: FIXED_NOTICES.guard_refused.length,
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.text).toBe(FIXED_NOTICES.guard_refused)
    expect(JSON.stringify(sent)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('sends each general fixed notice without credential scanning', async () => {
    const id = enabledRobot()
    for (const notice of Object.keys(
      GENERAL_FIXED_NOTICES,
    ) as (keyof typeof GENERAL_FIXED_NOTICES)[]) {
      const { sent, rawSend } = rawRecorder()
      const result = await sendGuarded({
        robotId: id,
        target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
        content: { category: 'fixed_notice', notice },
        maxOutboundChars: MAX,
        rawSend,
      })
      expect(result.ok).toBe(true)
      expect(sent).toEqual([{ chatId: 'oc_1', text: FIXED_NOTICES[notice], replyTo: 'm1' }])
    }
  })

  it('refuses binding notices forged as fixed_notice at runtime', async () => {
    const id = enabledRobot()
    const { sent, rawSend } = rawRecorder()
    const forged = {
      category: 'fixed_notice',
      notice: 'bind_success',
    } as unknown as Parameters<typeof sendGuarded>[0]['content']
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: forged,
      maxOutboundChars: MAX,
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
      replyTo: 'm1',
    }
    const { sent, rawSend } = rawRecorder()
    const ok = await sendGuarded({
      robotId: id,
      target,
      content: {
        category: 'binding_notice',
        notice: 'bind_success',
        origin: target,
      },
      maxOutboundChars: MAX,
      rawSend,
    })
    expect(ok.ok).toBe(true)
    expect(sent[0]?.text).toBe(BINDING_FIXED_NOTICES.bind_success)
  })

  it('refuses binding notices retargeted to another chat or sender', async () => {
    const id = enabledRobot()
    const origin = {
      chatId: 'ou_user',
      chatType: 'p2p' as const,
      senderId: 'ou_user',
      replyTo: 'm1',
    }
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'ou_other', chatType: 'p2p', senderId: 'ou_other', replyTo: 'm2' },
      content: { category: 'binding_notice', notice: 'bind_success', origin },
      maxOutboundChars: MAX,
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
      content: { category: 'binding_notice', notice: 'bind_success', origin: target },
      maxOutboundChars: MAX,
      rawSend,
    })
    expect(result).toMatchObject({ ok: false, reason: 'binding_not_p2p' })
    expect(sent).toEqual([])
  })

  it('truncates a long fixed notice to the platform limit', async () => {
    const id = enabledRobot()
    const { sent, rawSend } = rawRecorder()
    const result = await sendGuarded({
      robotId: id,
      target: { chatId: 'oc_1', chatType: 'group', senderId: 'ou_u', replyTo: 'm1' },
      content: { category: 'fixed_notice', notice: 'blocked' },
      maxOutboundChars: 12,
      rawSend,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.text.length).toBeLessThanOrEqual(12)
      expect(result.outboundChars).toBe(result.text.length)
      expect(FIXED_NOTICES.blocked.length).toBeGreaterThan(12)
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
      rawSend,
    })
    expect(rawSend).toHaveBeenCalledTimes(1)
  })
})
