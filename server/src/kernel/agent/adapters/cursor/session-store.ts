/**
 * Cursor {@link SessionStore} — a reader of Cursor's own on-disk chat store.
 *
 * Chats live under `<cursor home>/chats/<workspace hash>/<chat id>/`, where the
 * hash is the md5 of the workspace's real path. Each directory holds `meta.json`
 * — title, cwd and timestamps, everything a listing needs — and `store.db`, the
 * transcript. Listing therefore reads only small JSON files, and never opens a
 * database.
 *
 * Because this is the store the CLI and the Cursor IDE both write, a session
 * started anywhere shows up here: `list` and `read` cover the workspace's whole
 * history rather than the subset c3 happened to create.
 *
 * Nothing here is recovery: resume replays Cursor's own context by chat id, so a
 * transcript this reader cannot decode changes what the console displays and
 * never what the model remembers. Every step fails soft for that reason.
 *
 * `rename`/`delete` are absent by design (`'none'` in the ledger): this is the
 * user's own IDE data, and c3 does not mutate a store it does not own.
 *
 * @module
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hostCursorHome } from '../../../config/workspace-path.js'
import type {
  CanonicalBlock,
  CanonicalMessage,
  CanonicalToolResult,
  SessionListOptions,
  SessionStore,
  SessionSummary,
} from '../types.js'
import { readCursorStoreMessages, type CursorStoredMessage } from './store-db.js'

/** How far back a listing looks. Older chats stay resumable, just unlisted. */
const MAX_LIST_AGE_MS = 90 * 24 * 60 * 60 * 1000

/** The facts `meta.json` carries about one chat. */
export interface CursorChatMeta {
  readonly chatId: string
  readonly dir: string
  readonly cwd: string
  readonly title: string
  readonly updatedAtMs: number
}

/**
 * Read seam over the on-disk store. Injected so tests can exercise listing and
 * replay against a scripted store without laying out a chat directory tree.
 */
export interface CursorSessionSource {
  chats(cwd: string): CursorChatMeta[]
  transcript(meta: CursorChatMeta): CursorStoredMessage[]
}

/** The chats root — one directory per workspace hash. */
export function cursorChatsRoot(home = hostCursorHome()): string {
  return join(home, 'chats')
}

/**
 * The directory name Cursor derives for a workspace: the md5 of its real path.
 * Not a security boundary — a layout convention, and the reason a listing can go
 * straight to one directory instead of scanning every workspace's chats.
 */
export function cursorWorkspaceHash(cwd: string): string {
  return createHash('md5').update(realPath(cwd)).digest('hex')
}

/** The canonical form of a path, or the path itself when it cannot be resolved. */
function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Parse one chat directory's `meta.json`, or `null` when it is not readable. */
function readChatMeta(dir: string, chatId: string): CursorChatMeta | null {
  try {
    const raw = readFileSync(join(dir, 'meta.json'), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    const cwd = typeof record.cwd === 'string' ? record.cwd : null
    if (!cwd) return null
    const updatedAtMs =
      typeof record.updatedAtMs === 'number'
        ? record.updatedAtMs
        : typeof record.createdAtMs === 'number'
          ? record.createdAtMs
          : statSync(dir).mtimeMs
    const title = typeof record.title === 'string' && record.title.trim() ? record.title : chatId
    return { chatId, dir, cwd, title, updatedAtMs }
  } catch {
    return null
  }
}

/** Every chat directly under one workspace-hash directory. */
function readWorkspaceChats(hashDir: string): CursorChatMeta[] {
  const out: CursorChatMeta[] = []
  let entries: string[]
  try {
    entries = readdirSync(hashDir)
  } catch {
    return out
  }
  for (const chatId of entries) {
    const meta = readChatMeta(join(hashDir, chatId), chatId)
    if (meta) out.push(meta)
  }
  return out
}

/**
 * The default source: the host chat store.
 *
 * The hash is a fast path, not the truth. A chat whose recorded `cwd` matches is
 * this workspace's regardless of which directory it sits in, so a store written
 * under a different canonicalization of the same path is still found — at the
 * cost of a wider scan, bounded by age.
 */
const diskSource: CursorSessionSource = {
  chats(cwd) {
    const root = cursorChatsRoot()
    if (!existsSync(root)) return []
    const target = realPath(cwd)
    const direct = join(root, cursorWorkspaceHash(cwd))
    if (existsSync(direct)) {
      const hit = readWorkspaceChats(direct).filter((meta) => realPath(meta.cwd) === target)
      if (hit.length > 0) return hit
    }
    const cutoff = Date.now() - MAX_LIST_AGE_MS
    const out: CursorChatMeta[] = []
    let hashDirs: string[]
    try {
      hashDirs = readdirSync(root)
    } catch {
      return out
    }
    for (const hash of hashDirs) {
      for (const meta of readWorkspaceChats(join(root, hash))) {
        if (meta.updatedAtMs < cutoff) continue
        if (realPath(meta.cwd) !== target) continue
        out.push(meta)
      }
    }
    return out
  },
  transcript(meta) {
    return readCursorStoreMessages(join(meta.dir, 'store.db'))
  },
}

export class CursorSessionStore implements SessionStore {
  constructor(private readonly source: CursorSessionSource = diskSource) {}

  async list(opts: SessionListOptions): Promise<SessionSummary[]> {
    return this.source
      .chats(opts.cwd)
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
      .map((meta) => ({
        sessionId: meta.chatId,
        title: meta.title,
        vendorExtra: { lastModified: meta.updatedAtMs, cwd: meta.cwd },
      }))
  }

  async read(sessionId: string, opts: SessionListOptions): Promise<CanonicalMessage[]> {
    const meta = this.source.chats(opts.cwd).find((chat) => chat.chatId === sessionId)
    if (!meta) return []
    const stored = this.source.transcript(meta)
    // Results are recorded as their own messages, so they are indexed up front
    // and filled into the calls they answer — the same one-block-carries-its-
    // result shape the live stream produces.
    const results = collectToolResults(stored)
    const out: CanonicalMessage[] = []
    for (const [index, message] of stored.entries()) {
      const canonical = storedToCanonical(message, sessionId, index, results)
      if (canonical) out.push(canonical)
    }
    return out
  }
}

/** Index every stored tool result by the call id it answers. */
function collectToolResults(
  stored: readonly CursorStoredMessage[],
): Map<string, CanonicalToolResult> {
  const out = new Map<string, CanonicalToolResult>()
  for (const message of stored) {
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue
    for (const item of message.content) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      if (record.type !== 'tool-result' || typeof record.toolCallId !== 'string') continue
      const isError = record.isError === true
      out.set(record.toolCallId, {
        content: flattenToText(record.result ?? record.output),
        isError,
      })
    }
  }
  return out
}

/**
 * Flatten a stored result to the display string a transcript shows, without
 * `JSON.stringify`. Prefers the text-bearing field a result actually carries,
 * recursing through the nested shapes tools use.
 */
function flattenToText(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (depth > 4) return ''
  if (Array.isArray(value)) {
    return value
      .map((item) => flattenToText(item, depth + 1))
      .filter((text) => text.length > 0)
      .join('\n')
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    for (const key of ['content', 'text', 'message', 'output', 'stdout']) {
      if (record[key] !== undefined) return flattenToText(record[key], depth + 1)
    }
    return Object.values(record)
      .map((item) => flattenToText(item, depth + 1))
      .filter((text) => text.length > 0)
      .join('\n')
  }
  return ''
}

/**
 * Context the harness injects into the user turn — environment facts and file
 * attachments, not anything a human typed. It is dropped for the same reason the
 * system prompt is: a transcript that opens with a wall of machine-generated
 * environment text buries the actual conversation.
 */
function isInjectedContext(text: string): boolean {
  const head = text.trimStart()
  return (
    head.startsWith('<user_info>') ||
    head.startsWith('<environment_details>') ||
    head.startsWith('<attached_files>')
  )
}

/**
 * One stored message → one canonical envelope.
 *
 * The store's `system` role is the harness prompt, not conversation, and its
 * `tool` role carries results that belong on the call they answer — both are
 * dropped here, and the results are re-attached where the call is translated.
 */
function storedToCanonical(
  stored: CursorStoredMessage,
  sessionId: string,
  index: number,
  results: ReadonlyMap<string, CanonicalToolResult>,
): CanonicalMessage | null {
  if (stored.role === 'system' || stored.role === 'tool') return null
  const role = stored.role === 'user' ? 'user' : 'assistant'
  const blocks = contentToBlocks(stored.content, sessionId, index, results)
  if (blocks.length === 0) return null
  return {
    vendor: 'cursor',
    sessionId,
    role,
    blocks,
    ts: 0,
    // Every tool call in a stored transcript already ran: the permission decision
    // was made when the turn launched, so there is no per-call ruling to record.
    ...(blocks.some((block) => block.type === 'tool_use') ? { preApproved: true } : {}),
  }
}

/** A stored message's content → canonical blocks. */
function contentToBlocks(
  content: unknown,
  sessionId: string,
  index: number,
  results: ReadonlyMap<string, CanonicalToolResult>,
): CanonicalBlock[] {
  if (typeof content === 'string') {
    return content.trim() && !isInjectedContext(content)
      ? [{ type: 'text', text: content, id: `${sessionId}-${index}` }]
      : []
  }
  if (!Array.isArray(content)) return []
  const out: CanonicalBlock[] = []
  for (const [part, item] of content.entries()) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = `${sessionId}-${index}-${part}`
    const text = typeof record.text === 'string' ? record.text : ''
    switch (record.type) {
      case 'text':
        if (text.trim() && !isInjectedContext(text)) out.push({ type: 'text', text, id })
        break
      case 'reasoning':
        if (text.trim()) out.push({ type: 'thinking', thinking: text, id })
        break
      case 'tool-call': {
        // The native call id is what a result was recorded against, so keeping it
        // is what lets the two be matched.
        const callId = typeof record.toolCallId === 'string' ? record.toolCallId : id
        const result = results.get(callId)
        out.push({
          type: 'tool_use',
          id: callId,
          name: typeof record.toolName === 'string' ? record.toolName : 'unknown',
          input: record.args ?? {},
          ...(result ? { result } : {}),
        })
        break
      }
      default:
        break
    }
  }
  return out
}
