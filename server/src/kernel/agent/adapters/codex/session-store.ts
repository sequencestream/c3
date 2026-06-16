/**
 * Codex's {@link SessionStore} (2026-06-08). Reads session metadata directly from
 * the on-disk JSONL files under `~/.codex/sessions/YYYY/MM/DD/`. The
 * `@openai/codex-sdk` exposes **no listing or reading API**, but the Codex CLI writes
 * session transcripts to the filesystem when c3 runs `codex exec`, so this store reads
 * them back for listing and title derivation.
 *
 * Title is derived from the first user `input_text` in the transcript (matching
 * how the CLI sidebar derives it from the first prompt). `rename`/`delete` are
 * absent (Codex exposes neither operation).
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type {
  CanonicalBlock,
  CanonicalMessage,
  SessionListOptions,
  SessionStore,
  SessionSummary,
} from '../types.js'
import type { CanonicalRole } from '@ccc/shared/protocol'

export class CodexSessionStore implements SessionStore {
  /**
   * Enumerate sessions for a workspace by scanning the on-disk JSONL files
   * under `~/.codex/sessions/`. Each session file has a `session_meta` event on
   * the first line that carries the native id and cwd. The title is derived from
   * the first user `input_text` in the transcript.
   *
   * Only sessions whose `cwd` matches `opts.cwd` are returned. If no user prompt
   * is found (e.g. a freshly-created session before its first turn), the title
   * defaults to `'New session'`.
   *
   * Performance: the scan walks recent date directories (last N days) and reads
   * only the first few kilobytes of each file to extract the session_meta and
   * first user prompt. Session files beyond `MAX_LIST_DAYS` are not enumerated.
   */
  async list(opts: SessionListOptions): Promise<SessionSummary[]> {
    const sessionsDir = path.join(os.homedir(), '.codex', 'sessions')
    if (!existsSync(sessionsDir)) {
      return []
    }
    const results: SessionSummary[] = []
    const now = new Date()
    const MAX_LIST_DAYS = 90

    // Walk YYYY/MM/DD directories up to MAX_LIST_DAYS ago.
    const cutoff = new Date(now.getTime() - MAX_LIST_DAYS * 86400 * 1000)
    for (const yearDir of readdirSync(sessionsDir)) {
      const yearN = Number(yearDir)
      if (!Number.isInteger(yearN)) continue
      if (yearN < cutoff.getFullYear()) continue
      if (yearN > now.getFullYear() + 1) continue
      const yearPath = path.join(sessionsDir, yearDir)
      if (!existsSync(yearPath)) continue

      for (const monthDir of readdirSync(yearPath)) {
        const monthN = Number(monthDir)
        if (!Number.isInteger(monthN) || monthN < 1 || monthN > 12) continue
        if (yearN === cutoff.getFullYear() && monthN < cutoff.getMonth() + 1) continue
        if (yearN === now.getFullYear() && monthN > now.getMonth() + 1) continue
        const monthPath = path.join(yearPath, monthDir)
        if (!existsSync(monthPath)) continue

        for (const dayDir of readdirSync(monthPath)) {
          const dayN = Number(dayDir)
          if (!Number.isInteger(dayN) || dayN < 1 || dayN > 31) continue
          if (
            yearN === cutoff.getFullYear() &&
            monthN === cutoff.getMonth() + 1 &&
            dayN < cutoff.getDate()
          )
            continue
          if (yearN === now.getFullYear() && monthN === now.getMonth() + 1 && dayN > now.getDate())
            continue
          const dayPath = path.join(monthPath, dayDir)
          if (!existsSync(dayPath)) continue

          for (const file of readdirSync(dayPath)) {
            if (!file.endsWith('.jsonl')) continue
            const filepath = path.join(dayPath, file)
            const summary = this.readSessionFile(filepath, opts.cwd)
            if (summary) {
              results.push(summary)
            }
          }
        }
      }
    }
    return results
  }

  /**
   * Read one session JSONL file and return a SessionSummary if it belongs to the
   * requested workspace. Reads only the first SCAN_CHUNK_BYTES to find
   * the session_meta and first user prompt — this is typically < ¼ of one file
   * system block for most sessions.
   */
  private readSessionFile(filepath: string, workspacePath: string): SessionSummary | null {
    try {
      const SCAN_CHUNK_BYTES = 262_144 // 256 KB
      const content = readFileSync(filepath, { encoding: 'utf-8', flag: 'r' })
      // Truncate for scanning performance; the session_meta is always the first
      // line, and the first user prompt comes soon after.
      const chunk =
        content.length > SCAN_CHUNK_BYTES
          ? content.slice(0, content.indexOf('\n', SCAN_CHUNK_BYTES - 200) + 1) ||
            content.slice(0, SCAN_CHUNK_BYTES)
          : content

      const lines = chunk.split('\n')
      if (lines.length === 0) return null

      // First line = session_meta
      let meta: Record<string, unknown>
      try {
        meta = JSON.parse(lines[0])
      } catch {
        return null
      }
      if (meta.type !== 'session_meta') return null
      const payload = meta.payload as Record<string, unknown> | undefined
      if (!payload) return null
      const sessionId = typeof payload.id === 'string' ? payload.id : null
      const cwd = typeof payload.cwd === 'string' ? payload.cwd : null
      if (!sessionId || !cwd) return null
      if (cwd !== workspacePath) return null

      // Scan remaining lines for the first user input_text
      const st = statSync(filepath)
      const title = this.extractTitle(lines, content)
      return {
        sessionId,
        title,
        vendorExtra: { lastModified: st.mtimeMs, cwd },
      }
    } catch {
      return null
    }
  }

  /**
   * Scan JSONL lines for the first user-authored text to use as the title.
   * Handles TWO Codex on-disk formats (2026-06-09):
   *
   * 1. `event_msg` with `payload.type === 'user_message'` — the Codex SDK's
   *    NATIVE format for a human user's prompt (written when c3 dispatches
   *    a work-session prompt via `runStreamed`). The text lives in
   *    `payload.message`. This is the ONLY source of the user's actual input
   *    for interactive Codex sessions; without it, every session would show
   *    "New session" forever.
   *
   * 2. `response_item` with `payload.role === 'user'` and
   *    `content[].type === 'input_text'` — the Claude SDK's JSONL format
   *    (carried over when c3 prescribes system-generated context blocks
   *    like environment overrides). Used only as a FALLBACK.
   *
   * The scan runs in TWO passes, not line order. Format 2 system-context lines
   * (the AGENTS.md instructions blob, XML-tagged environment/user-instruction
   * wrappers) are written to disk BEFORE the user's actual prompt, so a single
   * "first match wins" loop picks the AGENTS.md blob as the title (the bug this
   * guards against). Pass 1 therefore scans ALL lines for the native
   * `user_message` (format 1) first; only when none exists does pass 2 fall back
   * to a format-2 line, and even then it skips recognisable injected context.
   */
  private extractTitle(lines: string[], _fullContent: string): string {
    const limit = Math.min(lines.length, 2000)

    // Pass 1: the codex-native user_message (format 1) — the actual human prompt.
    for (let i = 1; i < limit; i++) {
      const line = lines[i].trim()
      if (!line) continue
      const obj = tryParseJson(line)
      if (!obj || obj.type !== 'event_msg') continue
      const pl = obj.payload as Record<string, unknown> | undefined
      if (pl?.type === 'user_message' && typeof pl.message === 'string') {
        const text = pl.message.trim()
        if (text) return text.slice(0, 120)
      }
    }

    // Pass 2 (fallback): the first non-injected response_item/role=user text.
    for (let i = 1; i < limit; i++) {
      const line = lines[i].trim()
      if (!line) continue
      const obj = tryParseJson(line)
      if (!obj || obj.type !== 'response_item') continue
      const pl = obj.payload as Record<string, unknown> | undefined
      if (!pl || pl.role !== 'user') continue
      const content = pl.content as unknown[]
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const b = block as Record<string, unknown>
        if (b.type === 'input_text' && typeof b.text === 'string') {
          const text = b.text.trim()
          if (text && !isInjectedContext(text)) return text.slice(0, 120)
        }
      }
    }
    return 'New session'
  }

  async read(sessionId: string, opts: SessionListOptions): Promise<CanonicalMessage[]> {
    const filepath = this.findSessionFile(sessionId, opts.cwd)
    if (!filepath) return []
    try {
      return this.readSessionHistoryFile(filepath, sessionId)
    } catch {
      return []
    }
  }

  private findSessionFile(sessionId: string, workspacePath: string): string | null {
    const sessionsDir = path.join(os.homedir(), '.codex', 'sessions')
    if (!existsSync(sessionsDir)) return null
    const now = new Date()
    const MAX_READ_DAYS = 365
    const cutoff = new Date(now.getTime() - MAX_READ_DAYS * 86400 * 1000)
    for (const yearDir of readdirSync(sessionsDir)) {
      const yearN = Number(yearDir)
      if (!Number.isInteger(yearN)) continue
      if (yearN < cutoff.getFullYear()) continue
      if (yearN > now.getFullYear() + 1) continue
      const yearPath = path.join(sessionsDir, yearDir)
      if (!existsSync(yearPath)) continue
      for (const monthDir of readdirSync(yearPath)) {
        const monthN = Number(monthDir)
        if (!Number.isInteger(monthN) || monthN < 1 || monthN > 12) continue
        if (yearN === cutoff.getFullYear() && monthN < cutoff.getMonth() + 1) continue
        if (yearN === now.getFullYear() && monthN > now.getMonth() + 1) continue
        const monthPath = path.join(yearPath, monthDir)
        if (!existsSync(monthPath)) continue
        for (const dayDir of readdirSync(monthPath)) {
          const dayN = Number(dayDir)
          if (!Number.isInteger(dayN) || dayN < 1 || dayN > 31) continue
          if (
            yearN === cutoff.getFullYear() &&
            monthN === cutoff.getMonth() + 1 &&
            dayN < cutoff.getDate()
          )
            continue
          if (yearN === now.getFullYear() && monthN === now.getMonth() + 1 && dayN > now.getDate())
            continue
          const dayPath = path.join(monthPath, dayDir)
          if (!existsSync(dayPath)) continue
          for (const file of readdirSync(dayPath)) {
            if (!file.endsWith('.jsonl')) continue
            const filepath = path.join(dayPath, file)
            const summary = this.readSessionFile(filepath, workspacePath)
            if (summary?.sessionId === sessionId) return filepath
          }
        }
      }
    }
    return null
  }

  /**
   * Replay a codex session JSONL into canonical messages, de-duplicating the two
   * on-disk encodings of the same text.
   *
   * Codex rollout files persist every human/agent text message TWICE: once as a
   * native `event_msg` (`user_message`/`agent_message`) and once as the canonical
   * `response_item` (`role: user|assistant`) transcript entry — the very same
   * string in both. Converting both made every message render twice. The
   * `response_item` entries are the authoritative transcript (stable ids, and
   * interleaved with `reasoning`/tool items in turn order), so an `event_msg`
   * text frame is dropped whenever its text already appears as a `response_item`
   * message. An `event_msg` is kept only when no matching `response_item` exists
   * (defensive: a prompt that lives solely in the native event still surfaces).
   */
  private readSessionHistoryFile(filepath: string, sessionId: string): CanonicalMessage[] {
    const content = readFileSync(filepath, { encoding: 'utf-8', flag: 'r' })
    const objs: Record<string, unknown>[] = []
    for (const line of content.split('\n')) {
      const obj = tryParseJson(line.trim())
      if (obj) objs.push(obj)
    }

    // Pre-scan the response_item text messages that will be emitted, so an
    // event_msg duplicate of any of them can be skipped below.
    const responseItemTexts = new Set<string>()
    // Tool results live on their OWN `*_output` lines, paired to the call by
    // `call_id`. Pre-index them so a `function_call`/`custom_tool_call` can carry
    // its output inline (matching the live driver, where one item holds both).
    const toolOutputs = new Map<string, string>()
    for (const obj of objs) {
      if (obj.type !== 'response_item') continue
      const pl = recordOf(obj.payload)
      if (!pl) continue
      if (pl.type === 'function_call_output' || pl.type === 'custom_tool_call_output') {
        const callId = typeof pl.call_id === 'string' ? pl.call_id : null
        if (callId) toolOutputs.set(callId, coerceOutput(pl.output))
        continue
      }
      const role = pl.role === 'user' || pl.role === 'assistant' ? pl.role : null
      if (!role) continue
      const text = textFromContent(pl.content)
      if (text && !(role === 'user' && isInjectedContext(text))) {
        responseItemTexts.add(dedupKey(role, text))
      }
    }

    const out: CanonicalMessage[] = []
    let seq = 0
    for (const obj of objs) {
      const ts = seq++
      if (isDuplicateEventText(obj, responseItemTexts)) continue
      const msg = lineToCanonical(obj, sessionId, ts, toolOutputs)
      if (msg) out.push(msg)
    }
    return out
  }
}

/**
 * Whether `obj` is an `event_msg` user/agent text frame whose text already
 * appears as a `response_item` transcript entry (the duplicate to drop).
 */
function isDuplicateEventText(
  obj: Record<string, unknown>,
  responseItemTexts: Set<string>,
): boolean {
  if (obj.type !== 'event_msg') return false
  const pl = recordOf(obj.payload)
  const role =
    pl?.type === 'user_message' ? 'user' : pl?.type === 'agent_message' ? 'assistant' : null
  if (!role || typeof pl?.message !== 'string') return false
  const text = pl.message.trim()
  return text !== '' && responseItemTexts.has(dedupKey(role, text))
}

/** Stable key for matching the same text message across its two encodings. */
function dedupKey(role: string, text: string): string {
  return `${role}\n${text.trim()}`
}

function lineToCanonical(
  obj: Record<string, unknown>,
  sessionId: string,
  seq: number,
  toolOutputs: Map<string, string>,
): CanonicalMessage | null {
  const payload = recordOf(obj.payload)
  if (!payload) return null
  if (obj.type === 'event_msg') return eventMessageToCanonical(payload, sessionId, seq)
  if (obj.type === 'response_item')
    return responseItemToCanonical(payload, sessionId, seq, toolOutputs)
  return null
}

function eventMessageToCanonical(
  payload: Record<string, unknown>,
  sessionId: string,
  seq: number,
): CanonicalMessage | null {
  if (payload.type === 'user_message' && typeof payload.message === 'string') {
    const text = payload.message.trim()
    if (!text) return null
    return canonicalText('user', sessionId, `user-${seq}`, text, seq)
  }
  if (payload.type === 'agent_message' && typeof payload.message === 'string') {
    const text = payload.message.trim()
    if (!text) return null
    return canonicalText('assistant', sessionId, `assistant-${seq}`, text, seq)
  }
  return null
}

function responseItemToCanonical(
  payload: Record<string, unknown>,
  sessionId: string,
  seq: number,
  toolOutputs: Map<string, string>,
): CanonicalMessage | null {
  const role = payload.role === 'user' || payload.role === 'assistant' ? payload.role : null
  if (role) {
    const text = textFromContent(payload.content)
    if (!text || (role === 'user' && isInjectedContext(text))) return null
    return canonicalText(role, sessionId, blockId(payload, `${role}-${seq}`), text, seq)
  }
  const block = codexItemPayloadToBlock(payload, toolOutputs)
  if (!block) return null
  return {
    vendor: 'codex',
    sessionId,
    role: 'assistant',
    blocks: [block],
    ts: seq,
    ...(block.type === 'tool_use' ? { preApproved: true } : {}),
  }
}

function canonicalText(
  role: CanonicalRole,
  sessionId: string,
  id: string,
  text: string,
  seq: number,
): CanonicalMessage {
  return { vendor: 'codex', sessionId, role, blocks: [{ type: 'text', id, text }], ts: seq }
}

function codexItemPayloadToBlock(
  payload: Record<string, unknown>,
  toolOutputs: Map<string, string>,
): CanonicalBlock | null {
  const id = blockId(payload, `item-${String(payload.type ?? 'unknown')}`)
  // The actual on-disk tool-call shapes. `function_call` (`exec_command`, …) and
  // `custom_tool_call` (`apply_patch`, …) carry the call; the matching result was
  // pre-indexed by `call_id` from a sibling `*_output` line. Normalised to the
  // same block names the live driver emits (translate.ts) so history and live
  // render identically.
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    return toolCallBlock(payload, toolOutputs)
  }
  if (payload.type === 'agent_message' && typeof payload.text === 'string') {
    return { type: 'text', id, text: payload.text }
  }
  if (payload.type === 'reasoning') {
    const thinking = typeof payload.text === 'string' ? payload.text : reasoningSummary(payload)
    if (!thinking) return null
    return { type: 'thinking', id, thinking }
  }
  if (payload.type === 'error' && typeof payload.message === 'string') {
    return { type: 'text', id, text: payload.message, vendorExtra: { itemType: 'error' } }
  }
  if (payload.type === 'command_execution') {
    const status = typeof payload.status === 'string' ? payload.status : undefined
    const command = typeof payload.command === 'string' ? payload.command : ''
    const aggregated =
      typeof payload.aggregated_output === 'string' ? payload.aggregated_output : ''
    return {
      type: 'tool_use',
      id,
      name: 'shell',
      input: { command },
      ...(status && status !== 'in_progress'
        ? { result: { content: aggregated, isError: status === 'failed' } }
        : {}),
      vendorExtra: { status },
    }
  }
  if (payload.type === 'file_change') {
    const changes = Array.isArray(payload.changes) ? payload.changes : []
    const status = typeof payload.status === 'string' ? payload.status : undefined
    return {
      type: 'tool_use',
      id,
      name: 'apply_patch',
      input: { changes },
      result: {
        content: changes.map(formatChangeSummary).join('\n'),
        isError: status === 'failed',
      },
      vendorExtra: { status },
    }
  }
  if (payload.type === 'mcp_tool_call') {
    const server = typeof payload.server === 'string' ? payload.server : 'mcp'
    const tool = typeof payload.tool === 'string' ? payload.tool : 'tool'
    const result = mcpToolResult(payload)
    return {
      type: 'tool_use',
      id,
      name: `${server}/${tool}`,
      input: payload.arguments ?? {},
      ...(result ? { result } : {}),
      vendorExtra: { server, tool, status: payload.status },
    }
  }
  if (payload.type === 'web_search') {
    return {
      type: 'tool_use',
      id,
      name: 'web_search',
      input: { query: typeof payload.query === 'string' ? payload.query : '' },
      vendorExtra: { itemType: 'web_search' },
    }
  }
  return null
}

/**
 * Convert an on-disk `function_call` / `custom_tool_call` payload into a
 * `tool_use` block, pairing its result from the pre-indexed `*_output` line.
 * Tool names are normalised to match the live driver: `exec_command` → `shell`,
 * `apply_patch` stays `apply_patch`; anything else passes through verbatim.
 */
function toolCallBlock(
  payload: Record<string, unknown>,
  toolOutputs: Map<string, string>,
): CanonicalBlock {
  const callId = typeof payload.call_id === 'string' ? payload.call_id : null
  const name = typeof payload.name === 'string' ? payload.name : 'tool'
  const id = callId ?? blockId(payload, `tool-${name}`)
  const status = typeof payload.status === 'string' ? payload.status : undefined
  const output = callId ? toolOutputs.get(callId) : undefined
  const result =
    output !== undefined ? { content: output, isError: status === 'failed' } : undefined
  const vendorExtra = status ? { status } : undefined

  if (name === 'exec_command' || name === 'shell' || name === 'local_shell') {
    const args = parseToolArgs(payload.arguments ?? payload.input)
    const cmd = args.cmd ?? args.command
    const command = typeof cmd === 'string' ? cmd : Array.isArray(cmd) ? cmd.join(' ') : ''
    return {
      type: 'tool_use',
      id,
      name: 'shell',
      input: { command },
      ...(result ? { result } : {}),
      ...(vendorExtra ? { vendorExtra } : {}),
    }
  }
  if (name === 'apply_patch') {
    const args = parseToolArgs(payload.arguments)
    const patch =
      typeof payload.input === 'string'
        ? payload.input
        : typeof args.input === 'string'
          ? args.input
          : typeof args.patch === 'string'
            ? args.patch
            : ''
    return {
      type: 'tool_use',
      id,
      name: 'apply_patch',
      input: { patch },
      ...(result ? { result } : {}),
      ...(vendorExtra ? { vendorExtra } : {}),
    }
  }
  const input =
    typeof payload.input === 'string' ? { input: payload.input } : parseToolArgs(payload.arguments)
  return {
    type: 'tool_use',
    id,
    name,
    input,
    ...(result ? { result } : {}),
    ...(vendorExtra ? { vendorExtra } : {}),
  }
}

/** Parse a tool-call `arguments` field (a JSON string or already an object). */
function parseToolArgs(raw: unknown): Record<string, unknown> {
  const direct = recordOf(raw)
  if (direct) return direct
  if (typeof raw === 'string') {
    const parsed = tryParseJson(raw)
    if (parsed) return parsed
  }
  return {}
}

/** Extract readable text from a `reasoning` item's `summary` array, if present. */
function reasoningSummary(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.summary)) return ''
  return payload.summary
    .map((part) => {
      const p = recordOf(part)
      return p && typeof p.text === 'string' ? p.text : ''
    })
    .join('')
    .trim()
}

/** Normalise a `*_output` payload's `output` field to a string. */
function coerceOutput(output: unknown): string {
  if (typeof output === 'string') return output
  const rec = recordOf(output)
  if (rec) {
    if (typeof rec.content === 'string') return rec.content
    if (Array.isArray(rec.content)) {
      return rec.content
        .map((item) => {
          const c = recordOf(item)
          return c && typeof c.text === 'string' ? c.text : ''
        })
        .join('')
    }
  }
  return ''
}

function mcpToolResult(
  payload: Record<string, unknown>,
): { content: string; isError: boolean } | null {
  const error = recordOf(payload.error)
  if (typeof error?.message === 'string') return { content: error.message, isError: true }
  const result = recordOf(payload.result)
  const content = Array.isArray(result?.content)
    ? result.content
        .map((item) => {
          const c = recordOf(item)
          if (c?.type === 'text' && typeof c.text === 'string') return c.text
          return c?.type ? `[${String(c.type)}]` : ''
        })
        .join('')
    : ''
  return content ? { content, isError: false } : null
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = recordOf(block)
      if (!b) return ''
      if (
        (b.type === 'input_text' || b.type === 'output_text' || b.type === 'text') &&
        typeof b.text === 'string'
      ) {
        return b.text
      }
      return ''
    })
    .join('')
    .trim()
}

function blockId(payload: Record<string, unknown>, fallback: string): string {
  return typeof payload.id === 'string' && payload.id ? payload.id : fallback
}

function formatChangeSummary(change: unknown): string {
  const c = recordOf(change)
  const kind = typeof c?.kind === 'string' ? c.kind : 'change'
  const p = typeof c?.path === 'string' ? c.path : ''
  return p ? `${kind} ${p}` : kind
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Whether a role=user text block is c3/codex-injected context rather than the
 * human's prompt. c3 prepends the AGENTS.md instructions blob and XML-tagged
 * environment / user-instruction wrappers as role=user lines; none of these may
 * become a session title. Kept deliberately narrow (known injected shapes only)
 * so a genuine prompt that merely starts with '#' is not misclassified.
 */
function isInjectedContext(text: string): boolean {
  return (
    /^#\s*AGENTS\.md\b/.test(text) ||
    text.includes('<INSTRUCTIONS>') ||
    text.includes('<environment_context>') ||
    text.includes('<user_instructions>')
  )
}

/** Safe JSON parse that returns null (not throws) on invalid input. */
function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(text)
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}
