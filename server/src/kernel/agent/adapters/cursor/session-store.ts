/**
 * Cursor {@link SessionStore} — a reader of the SDK's own local agent store.
 *
 * The SDK persists every agent it creates under its state root (SQLite by
 * default, keyed by workspace), and exposes it through `Agent.list`,
 * `Agent.messages.list` and `Agent.listRuns`. c3 reads that store rather than
 * Cursor's private chat database: the SDK's is a published API with a stable
 * shape, the IDE's is an internal format that carries no compatibility promise
 * and would rot on the next release.
 *
 * A session's transcript is spread across two SDK surfaces, and `read` joins
 * them: `Agent.messages.list` carries the prompt side (one entry per run), and
 * each run's `conversation()` carries the reply side — assistant text, thinking
 * and tool calls. The two interleave one-to-one in run order, so a replayed
 * history keeps the same prompt → reply shape as the live stream.
 *
 * The consequence is stated honestly in the capability ledger as `list`/`read` =
 * `'partial'`: this store holds exactly the agents created through the SDK, and
 * nothing the user ran in the Cursor IDE or the `cursor-agent` CLI. **Recovery
 * never comes from here** — resume replays Cursor's own context through
 * `Agent.resume`, so what this reader shows only changes what the console
 * displays, never what the model remembers.
 *
 * `rename`/`delete` are absent by design (`'none'` in the ledger): the SDK
 * exposes neither for local agents, and c3 must not pretend to mutate a store it
 * does not own.
 */
import type {
  CanonicalMessage,
  CanonicalToolResult,
  SessionListOptions,
  SessionStore,
  SessionSummary,
} from '../types.js'
import { loadCursorSdk } from './sdk-resolve.js'

/** One agent as the SDK's local store lists it (the fields c3 consumes). */
export interface CursorStoredAgent {
  agentId: string
  name?: string
  summary?: string
  lastModified?: number
  status?: string
}

/** One stored message. `message` is the SDK's own payload, read defensively. */
export interface CursorStoredMessage {
  type?: string
  uuid?: string
  agent_id?: string
  message?: unknown
}

/** One step of a run's conversation — the SDK's reply-side unit. */
export interface CursorConversationStep {
  type?: string
  message?: unknown
}

/**
 * Read seam over the SDK's local store. Injected so tests (and a c3 running
 * without the SDK's native runtime available) can exercise the store without
 * touching disk.
 */
export interface CursorSessionSource {
  list(cwd: string): Promise<CursorStoredAgent[]>
  messages(agentId: string, cwd: string): Promise<CursorStoredMessage[]>
  /** Each run's conversation steps, in run order. `messages.list` carries only
   * the prompt side, so this is where the reply side comes from. */
  conversations(agentId: string, cwd: string): Promise<CursorConversationStep[][]>
}

/**
 * The default source — the SDK's local-runtime store, loaded lazily through the
 * shared resolution boundary so that merely constructing the adapter never pulls
 * the SDK's native runtime into the process, and the store reads the same copy the
 * driver runs.
 */
const sdkSource: CursorSessionSource = {
  async list(cwd) {
    const { Agent } = await loadCursorSdk()
    const result = await Agent.list({ runtime: 'local', cwd })
    return result.items.map((item) => ({
      agentId: item.agentId,
      name: item.name,
      summary: item.summary,
      lastModified: item.lastModified,
      status: item.status,
    }))
  },
  async messages(agentId, cwd) {
    const { Agent } = await loadCursorSdk()
    return (await Agent.messages.list(agentId, { runtime: 'local', cwd })) as CursorStoredMessage[]
  },
  async conversations(agentId, cwd) {
    const { Agent } = await loadCursorSdk()
    const runs = await Agent.listRuns(agentId, { runtime: 'local', cwd })
    const out: CursorConversationStep[][] = []
    for (const run of runs.items ?? []) {
      // The SDK's `Run.conversation()` is reached structurally (ADR-0009 keeps
      // SDK types out of the kernel); a run without it — a terminal shape the
      // SDK itself may drop — simply contributes no reply side.
      const handle = run as { conversation?: () => Promise<unknown> }
      if (typeof handle.conversation !== 'function') continue
      const turns = (await handle.conversation()) as Array<{
        turn?: { steps?: unknown }
      }> | null
      const steps: CursorConversationStep[] = []
      for (const turn of turns ?? []) {
        const inner = turn?.turn?.steps
        if (Array.isArray(inner)) steps.push(...(inner as CursorConversationStep[]))
      }
      if (steps.length > 0) out.push(steps)
    }
    return out
  },
}

/**
 * Pull the display text out of a stored message payload. The SDK has shipped
 * more than one message shape — a plain `{ text }`, a `{ content: [...] }` block
 * list in the run stream, and the current oneof-wrapped
 * `{ turn: { case: 'agentConversationTurn', value: { userMessage | assistantMessage } } }` —
 * so all three are read and neither is assumed; an unrecognised payload yields
 * empty text rather than a stringified blob.
 */
function storedText(message: unknown): string {
  if (typeof message === 'string') return message
  if (!message || typeof message !== 'object') return ''
  const record = message as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
  // Newer SDK versions wrap a stored message in a protobuf oneof: the field
  // `turn` names the message kind via `case`, and the payload sits on `value`.
  const turn = record.turn
  if (turn && typeof turn === 'object') {
    const wrapper = turn as { case?: unknown; value?: unknown }
    if (
      wrapper.case === 'agentConversationTurn' &&
      wrapper.value &&
      typeof wrapper.value === 'object'
    ) {
      const value = wrapper.value as Record<string, unknown>
      for (const side of [value.userMessage, value.assistantMessage]) {
        if (
          side &&
          typeof side === 'object' &&
          typeof (side as { text?: unknown }).text === 'string'
        ) {
          return (side as { text: string }).text
        }
      }
    }
  }
  const content = record.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .filter((text) => text.length > 0)
    .join('')
}

/** The title c3 shows for a stored agent, preferring its own summary. */
function title(agent: CursorStoredAgent): string {
  return agent.summary?.trim() || agent.name?.trim() || agent.agentId
}

export class CursorSessionStore implements SessionStore {
  constructor(private readonly source: CursorSessionSource = sdkSource) {}

  async list(opts: SessionListOptions): Promise<SessionSummary[]> {
    const agents = await this.source.list(opts.cwd)
    return agents.map((agent) => ({
      sessionId: agent.agentId,
      title: title(agent),
      vendorExtra: {
        ...(agent.status ? { status: agent.status } : {}),
        ...(agent.lastModified !== undefined ? { lastModified: agent.lastModified } : {}),
      },
    }))
  }

  async read(sessionId: string, opts: SessionListOptions): Promise<CanonicalMessage[]> {
    const [stored, conversations] = await Promise.all([
      this.source.messages(sessionId, opts.cwd),
      this.source.conversations(sessionId, opts.cwd),
    ])
    const out: CanonicalMessage[] = []
    // `messages.list` keeps one prompt per run and `conversations` keeps that
    // run's reply steps, so the two interleave one-to-one in run order — the
    // only ordering that keeps a multi-turn session's prompts in front of the
    // replies they produced.
    const turns = Math.max(stored.length, conversations.length)
    for (let turn = 0; turn < turns; turn++) {
      const entry = stored[turn]
      if (entry) {
        const text = storedText(entry.message)
        if (text) {
          // The store keeps only the two conversational roles; a payload that
          // names neither is read as assistant output, which is what the console
          // renders for anything the model produced.
          const role = entry.type === 'user' ? 'user' : 'assistant'
          out.push({
            vendor: 'cursor',
            sessionId,
            role,
            blocks: [{ type: 'text', text, id: entry.uuid ?? `${sessionId}-${turn}` }],
            ts: 0,
          })
        }
      }
      const steps = conversations[turn]
      if (steps) out.push(...stepsToMessages(steps, sessionId))
    }
    return out
  }
}

/**
 * Flatten a run's conversation steps into canonical messages. The SDK's
 * `conversation()` steps are the reply-side mirror of `messages.list`'s prompts:
 * `assistantMessage` / `thinkingMessage` become text / thinking blocks, and
 * `toolCall` becomes a `tool_use` block with its embedded result.
 */
function stepsToMessages(
  steps: readonly CursorConversationStep[],
  sessionId: string,
): CanonicalMessage[] {
  const out: CanonicalMessage[] = []
  for (const [index, step] of steps.entries()) {
    if (!step || typeof step !== 'object') continue
    if (step.type === 'assistantMessage') {
      const text = stepText(step.message)
      if (!text) continue
      out.push({
        vendor: 'cursor',
        sessionId,
        role: 'assistant',
        blocks: [{ type: 'text', text, id: `${sessionId}-step-${index}` }],
        ts: 0,
      })
    } else if (step.type === 'thinkingMessage') {
      const text = stepText(step.message)
      if (!text) continue
      out.push({
        vendor: 'cursor',
        sessionId,
        role: 'assistant',
        blocks: [{ type: 'thinking', thinking: text, id: `${sessionId}-think-${index}` }],
        ts: 0,
      })
    } else if (step.type === 'toolCall') {
      const message = toolCallToMessage(step.message, sessionId, index)
      if (message) out.push(message)
    }
  }
  return out
}

/** The text carried by an assistant/thinking step's `message`. */
function stepText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  return typeof (message as { text?: unknown }).text === 'string'
    ? (message as { text: string }).text
    : ''
}

/** One tool call step → a canonical `tool_use` block with its embedded result. */
function toolCallToMessage(
  message: unknown,
  sessionId: string,
  index: number,
): CanonicalMessage | null {
  if (!message || typeof message !== 'object') return null
  const call = message as { type?: unknown; args?: unknown; result?: unknown }
  const name = typeof call.type === 'string' ? call.type : 'unknown'
  const raw = call.result
  // The SDK wraps the outcome as `{ status, value }`; anything without a
  // `status: 'error'` is read as a success.
  const isError = !!(
    raw &&
    typeof raw === 'object' &&
    (raw as { status?: unknown }).status === 'error'
  )
  const result = toolResult(raw, isError)
  return {
    vendor: 'cursor',
    sessionId,
    role: 'assistant',
    blocks: [
      {
        type: 'tool_use',
        id: `${sessionId}-tool-${index}`,
        name,
        input: call.args ?? {},
        ...(result ? { result } : {}),
      },
    ],
    ts: 0,
  }
}

/**
 * Collapse a native tool result into the canonical flat display string without
 * `JSON.stringify` (ADR-0009 R2). Prefers the text-bearing field a result
 * actually carries (`content`/`text`/`message`/`output`/`stdout`, then `value`),
 * recursing through nested shapes; the readable rendering is what the transcript
 * shows, never a serialized blob.
 */
function toolResult(raw: unknown, isError: boolean): CanonicalToolResult | undefined {
  if (raw === undefined || raw === null) {
    return isError ? { content: '', isError: true } : undefined
  }
  if (typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    if ('error' in record) return { content: flattenToText(record.error), isError: true }
    if ('success' in record) return { content: flattenToText(record.success), isError }
    if ('value' in record) return { content: flattenToText(record.value), isError }
  }
  return { content: flattenToText(raw), isError }
}

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
