/**
 * Feishu's inbound message shape → the neutral {@link ImInboundMessage}.
 *
 * Kept as a pure function so the parsing rules — which mention markup to strip,
 * which id counts as the thread, what makes a message uninteresting — are
 * testable without a live connection.
 *
 * Only text messages are handled. Anything else (images, files, cards, system
 * notices) returns null: a robot that cannot see the content has nothing useful
 * to answer, and guessing would produce a reply to a message the user never
 * really asked.
 */
import type { ImInboundMessage } from '../../types.js'

/** The `event` body of `im.message.receive_v1`, narrowed to what is read here. */
export interface FeishuMessageEvent {
  sender?: {
    sender_id?: { open_id?: string; union_id?: string; user_id?: string }
    sender_type?: string
  }
  message?: {
    message_id?: string
    root_id?: string
    parent_id?: string
    thread_id?: string
    create_time?: string
    chat_id?: string
    chat_type?: string
    message_type?: string
    /** JSON string; for `text` it is `{"text":"…"}`. */
    content?: string
    mentions?: { key?: string; id?: { open_id?: string }; name?: string }[]
  }
}

export type FeishuInboundSkipReason =
  'missing_ids' | 'non_user_sender' | 'non_text' | 'bad_content' | 'empty_body' | 'blank_sender'

export type FeishuInboundParse =
  | { ok: true; message: ImInboundMessage }
  | {
      ok: false
      reason: FeishuInboundSkipReason
      messageType?: string
      chatType?: string
    }

/**
 * Remove Feishu's mention placeholders (`@_user_1`) and collapse the whitespace
 * they leave behind, so the model receives the sentence a human would read.
 */
function stripMentions(text: string, keys: string[]): string {
  let out = text
  for (const key of keys) {
    if (key) out = out.split(key).join(' ')
  }
  return out.replace(/\s+/g, ' ').trim()
}

function chatTypeOf(raw: string | undefined): 'p2p' | 'group' {
  return raw === 'p2p' ? 'p2p' : 'group'
}

/**
 * Parse one Feishu receive event into a neutral inbound message, or explain why
 * it was dropped (for diagnostic logs — never includes body text).
 */
export function parseFeishuInbound(
  event: FeishuMessageEvent,
  botOpenId: string | null,
): FeishuInboundParse {
  const msg = event.message
  if (!msg?.message_id || !msg.chat_id) {
    return { ok: false, reason: 'missing_ids', messageType: msg?.message_type }
  }
  const chatType = chatTypeOf(msg.chat_type)
  // A bot must not answer another bot — two robots in one chat would otherwise
  // keep each other talking.
  if (event.sender?.sender_type && event.sender.sender_type !== 'user') {
    return {
      ok: false,
      reason: 'non_user_sender',
      messageType: msg.message_type,
      chatType,
    }
  }
  if (msg.message_type !== 'text') {
    return {
      ok: false,
      reason: 'non_text',
      messageType: msg.message_type,
      chatType,
    }
  }

  let text = ''
  try {
    const parsed: unknown = JSON.parse(msg.content ?? '{}')
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { text?: unknown }).text === 'string'
    ) {
      text = (parsed as { text: string }).text
    }
  } catch {
    return { ok: false, reason: 'bad_content', messageType: msg.message_type, chatType }
  }

  const mentions = msg.mentions ?? []
  const body = stripMentions(
    text,
    mentions.map((m) => m.key ?? ''),
  )
  if (!body) {
    return { ok: false, reason: 'empty_body', messageType: msg.message_type, chatType }
  }

  // Missing/blank senderId is not an accepted message: no reply, audit, or Conversation.
  const senderId = event.sender?.sender_id?.open_id?.trim() ?? ''
  if (!senderId) {
    return { ok: false, reason: 'blank_sender', messageType: msg.message_type, chatType }
  }

  return {
    ok: true,
    message: {
      messageId: msg.message_id,
      chatId: msg.chat_id,
      chatType,
      senderId,
      text: body,
      mentionedBot: botOpenId !== null && mentions.some((m) => m.id?.open_id === botOpenId),
      // Feishu sets `thread_id` only inside a topic, and `root_id` only on a reply.
      // Both are passed through; deciding between them is the neutral layer's job.
      ...(msg.thread_id ? { threadId: msg.thread_id } : {}),
      ...(msg.root_id ? { rootId: msg.root_id } : {}),
      createdAt: Number(msg.create_time ?? '') || Date.now(),
    },
  }
}

export function normalizeFeishuMessage(
  event: FeishuMessageEvent,
  botOpenId: string | null,
): ImInboundMessage | null {
  const parsed = parseFeishuInbound(event, botOpenId)
  return parsed.ok ? parsed.message : null
}
