/**
 * What the robot actually receives from a Feishu chat. The rules pinned here are
 * the ones that decide whether a message is answered at all, and what the model
 * ends up reading.
 */
import { describe, expect, it } from 'vitest'
import { normalizeFeishuMessage, parseFeishuInbound, type FeishuMessageEvent } from './normalize.js'

const BOT = 'ou_bot'

function event(
  over: Partial<FeishuMessageEvent['message']> = {},
  sender = 'user',
): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: sender },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'group',
      message_type: 'text',
      create_time: '1700000000000',
      content: JSON.stringify({ text: 'hello' }),
      ...over,
    },
  }
}

describe('normalizeFeishuMessage', () => {
  it('normalizes a plain group message', () => {
    expect(normalizeFeishuMessage(event(), BOT)).toMatchObject({
      messageId: 'om_1',
      chatId: 'oc_1',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'hello',
      mentionedBot: false,
    })
  })

  it('strips mention markup so the model reads the sentence a human reads', () => {
    const m = normalizeFeishuMessage(
      event({
        content: JSON.stringify({ text: '@_user_1  帮我看看构建状态' }),
        mentions: [{ key: '@_user_1', id: { open_id: BOT }, name: 'c3' }],
      }),
      BOT,
    )
    expect(m?.text).toBe('帮我看看构建状态')
    expect(m?.mentionedBot).toBe(true)
  })

  it('does not report a mention when someone else was mentioned', () => {
    const m = normalizeFeishuMessage(
      event({
        content: JSON.stringify({ text: '@_user_1 看看' }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_someone' } }],
      }),
      BOT,
    )
    expect(m?.mentionedBot).toBe(false)
    expect(m?.text).toBe('看看')
  })

  it('cannot report a mention when the bot identity is unknown', () => {
    const m = normalizeFeishuMessage(
      event({ mentions: [{ key: '@_user_1', id: { open_id: BOT } }] }),
      null,
    )
    expect(m?.mentionedBot).toBe(false)
  })

  it('passes topic and reply ids through untouched, deciding nothing', () => {
    const m = normalizeFeishuMessage(event({ thread_id: 'omt_1', root_id: 'om_root' }), BOT)
    expect(m).toMatchObject({ threadId: 'omt_1', rootId: 'om_root' })
  })

  it('ignores non-text messages rather than answering something it cannot read', () => {
    for (const type of ['image', 'file', 'interactive', 'audio']) {
      expect(normalizeFeishuMessage(event({ message_type: type }), BOT)).toBeNull()
      expect(parseFeishuInbound(event({ message_type: type }), BOT)).toMatchObject({
        ok: false,
        reason: 'non_text',
        messageType: type,
      })
    }
  })

  it('ignores messages from other bots, so two robots cannot talk to each other', () => {
    expect(normalizeFeishuMessage(event({}, 'app'), BOT)).toBeNull()
  })

  it('ignores a message whose body is only a mention', () => {
    const m = normalizeFeishuMessage(
      event({
        content: JSON.stringify({ text: '@_user_1' }),
        mentions: [{ key: '@_user_1', id: { open_id: BOT } }],
      }),
      BOT,
    )
    expect(m).toBeNull()
  })

  it('ignores malformed content instead of guessing', () => {
    expect(normalizeFeishuMessage(event({ content: 'not json' }), BOT)).toBeNull()
    expect(normalizeFeishuMessage(event({ content: JSON.stringify({ x: 1 }) }), BOT)).toBeNull()
  })

  it('ignores an event with no message or chat id', () => {
    expect(normalizeFeishuMessage({}, BOT)).toBeNull()
    expect(normalizeFeishuMessage(event({ chat_id: undefined }), BOT)).toBeNull()
  })

  it('ignores a message with blank or missing senderId — never an accepted message', () => {
    const blank: FeishuMessageEvent = {
      sender: { sender_id: { open_id: '   ' }, sender_type: 'user' },
      message: event().message,
    }
    expect(normalizeFeishuMessage(blank, BOT)).toBeNull()
    const missing: FeishuMessageEvent = {
      sender: { sender_type: 'user' },
      message: event().message,
    }
    expect(normalizeFeishuMessage(missing, BOT)).toBeNull()
  })

  it('marks a direct message as p2p', () => {
    expect(normalizeFeishuMessage(event({ chat_type: 'p2p' }), BOT)?.chatType).toBe('p2p')
  })
})
