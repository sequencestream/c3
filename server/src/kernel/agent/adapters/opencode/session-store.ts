/**
 * OpenCode's {@link SessionStore} (ADR-0013, 2026-06-06-003). Where Claude reads
 * JSONL off disk, OpenCode's transcript lives behind its REST server: `session.list`
 * enumerates sessions for a workspace and `session.messages` returns the stored
 * `{ info, parts }` rows, which {@link messageToCanonical} normalizes. Read-only —
 * the native server stays the source of truth (the {@link SessionAccessor} wraps
 * this without ever copying transcripts).
 *
 * ADR-0009: imports `@opencode-ai/sdk` (inside `adapters/opencode/`); only neutral
 * {@link SessionSummary}/{@link CanonicalMessage} shapes leave.
 */
import type { OpencodeClient } from '@opencode-ai/sdk'
import type {
  CanonicalMessage,
  SessionListOptions,
  SessionStore,
  SessionSummary,
} from '../types.js'
import { messageToCanonical } from './translate.js'

export class OpencodeSessionStore implements SessionStore {
  constructor(private readonly getClient: () => OpencodeClient) {}

  async list(opts: SessionListOptions): Promise<SessionSummary[]> {
    const res = await this.getClient().session.list({ query: { directory: opts.cwd } })
    const sessions = res.data ?? []
    return sessions.map((s) => ({
      sessionId: s.id,
      title: s.title,
      vendorExtra: { directory: s.directory, time: s.time, version: s.version },
    }))
  }

  async read(sessionId: string, opts: SessionListOptions): Promise<CanonicalMessage[]> {
    const res = await this.getClient().session.messages({
      path: { id: sessionId },
      query: { directory: opts.cwd },
    })
    const rows = res.data ?? []
    return rows.map((row) => messageToCanonical(row.info, row.parts))
  }
}
