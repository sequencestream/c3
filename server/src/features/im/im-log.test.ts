import { describe, expect, it } from 'vitest'
import {
  formatImChallengeConsume,
  formatImChallengeCreated,
  formatImConnected,
  formatImInbound,
  formatImOutbound,
  imSenderDigest,
} from './im-log.js'

const robot = { id: 'r1', name: 'ops-bot', platform: 'feishu' as const }

describe('im-log', () => {
  it('digests sender ids stably without echoing them', () => {
    const a = imSenderDigest('ou_user_abc')
    expect(a).toHaveLength(16)
    expect(a).toBe(imSenderDigest('ou_user_abc'))
    expect(a).not.toBe(imSenderDigest('ou_other'))
  })

  it('formats connection lines with state', () => {
    expect(formatImConnected(robot, { state: 'connected', reconnectAttempts: 0 })).toBe(
      '[im] connected robot=ops-bot id=r1 platform=feishu state=connected reconnects=0',
    )
  })

  it('formats inbound without message body or raw sender', () => {
    const line = formatImInbound({
      robot,
      message: {
        messageId: 'om_abcdefghijklmnopqrstuvwxyz',
        chatId: 'oc_1',
        chatType: 'p2p',
        senderId: 'ou_secret_sender',
        text: 'abcdefghijklmnopqrstuv',
        mentionedBot: false,
        createdAt: 1,
      },
    })
    expect(line).toContain('[im] inbound')
    expect(line).toContain('chat=p2p')
    expect(line).toContain('tokenish=yes')
    expect(line).toContain(`sender=${imSenderDigest('ou_secret_sender')}`)
    expect(line).not.toContain('ou_secret_sender')
    expect(line).not.toContain('abcdefghijklmnopqrstuv')
  })

  it('formats outbound refuse without body text', () => {
    expect(
      formatImOutbound({
        robot,
        category: 'binding_notice',
        chatType: 'p2p',
        noticeKey: 'binding.tokenUnusable',
        ok: false,
        reason: 'send_failed',
      }),
    ).toBe(
      '[im] outbound robot=ops-bot id=r1 platform=feishu category=binding_notice notice=binding.tokenUnusable chat=p2p refused reason=send_failed',
    )
  })

  it('formats challenge create/consume without tokens', () => {
    expect(
      formatImChallengeCreated({
        robotId: 'r1',
        subject: 'alice',
        accountNamespace: 'feishu:app',
        challengeId: '11111111-2222-3333-4444-555555555555',
        expiresAt: Date.now() + 60_000,
      }),
    ).toMatch(/^\[im\] challenge_created subject=alice ns=feishu:app robotId=r1 challenge=/)
    expect(
      formatImChallengeConsume({
        robotId: 'r1',
        accountNamespace: 'feishu:app',
        senderId: 'ou_x',
        ok: false,
        reason: 'invalid_or_mismatch',
      }),
    ).toContain('result=failed reason=invalid_or_mismatch')
  })
})
