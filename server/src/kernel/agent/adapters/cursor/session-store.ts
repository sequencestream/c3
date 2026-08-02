/**
 * Cursor {@link SessionStore} — a reader of the SDK's own local agent store.
 *
 * The SDK persists every agent it creates under its state root (SQLite by
 * default, keyed by workspace), and exposes it through `Agent.list` and
 * `Agent.messages.list`. c3 reads that store rather than Cursor's private chat
 * database: the SDK's is a published API with a stable shape, the IDE's is an
 * internal format that carries no compatibility promise and would rot on the
 * next release.
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
  CanonicalBlock,
  CanonicalMessage,
  SessionListOptions,
  SessionStore,
  SessionSummary,
} from '../types.js'

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

/**
 * Read seam over the SDK's local store. Injected so tests (and a c3 running
 * without the SDK's native runtime available) can exercise the store without
 * touching disk.
 */
export interface CursorSessionSource {
  list(cwd: string): Promise<CursorStoredAgent[]>
  messages(agentId: string, cwd: string): Promise<CursorStoredMessage[]>
}

/**
 * The default source — the SDK's local-runtime store. Imported lazily so that
 * merely constructing the adapter never pulls the SDK's native runtime into the
 * process, and a failure to load it degrades to an empty listing rather than
 * taking the session list down with it.
 */
const sdkSource: CursorSessionSource = {
  async list(cwd) {
    const { Agent } = await import('@cursor/sdk')
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
    const { Agent } = await import('@cursor/sdk')
    return (await Agent.messages.list(agentId, { runtime: 'local', cwd })) as CursorStoredMessage[]
  },
}

/**
 * Pull the display text out of a stored message payload. The SDK has shipped
 * more than one message shape (`{ text }` today, a `{ content: [...] }` block
 * list in the run stream), so both are read and neither is assumed — an
 * unrecognised payload yields empty text rather than a stringified blob.
 */
function storedText(message: unknown): string {
  if (typeof message === 'string') return message
  if (!message || typeof message !== 'object') return ''
  const record = message as Record<string, unknown>
  if (typeof record.text === 'string') return record.text
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
    const stored = await this.source.messages(sessionId, opts.cwd)
    const out: CanonicalMessage[] = []
    for (const [index, entry] of stored.entries()) {
      const text = storedText(entry.message)
      if (!text) continue
      // The store keeps only the two conversational roles; a payload that names
      // neither is read as assistant output, which is what the console renders
      // for anything the model produced.
      const role = entry.type === 'user' ? 'user' : 'assistant'
      const blocks: CanonicalBlock[] = [
        { type: 'text', text, id: entry.uuid ?? `${sessionId}-${index}` },
      ]
      out.push({ vendor: 'cursor', sessionId, role, blocks, ts: 0 })
    }
    return out
  }
}
