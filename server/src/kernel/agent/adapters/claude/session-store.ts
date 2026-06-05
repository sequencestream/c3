/**
 * Claude's {@link SessionStore} — the dirtiest coupling (direct JSONL transcript
 * reads under `~/.claude/projects/`) locked behind the neutral interface
 * (ADR-0011). It delegates to the existing `sessions.ts` wrappers (which already
 * narrow the SDK's introspection API) and maps their c3-wire shapes
 * (`SessionInfo` / `TranscriptItem`) into the canonical model. No SDK type and
 * no JSONL detail escapes through `read`/`list` — only {@link CanonicalMessage}.
 */
import type {
  CanonicalMessage,
  SessionListOptions,
  SessionStore,
  SessionSummary,
} from '../types.js'
import {
  listWorkspaceSessions,
  loadHistory,
  removeSession,
  renameWorkspaceSession,
} from '../../../../sessions.js'
import { transcriptToCanonical } from './translate.js'

export class ClaudeSessionStore implements SessionStore {
  async list(opts: SessionListOptions): Promise<SessionSummary[]> {
    const sessions = await listWorkspaceSessions(opts.cwd)
    return sessions.map((s) => ({
      sessionId: s.sessionId,
      title: s.title,
      // Claude-specific extras the neutral caller may ignore (mode lives here, not
      // at the top level — neutral sessions have no Claude PermissionMode).
      vendorExtra: {
        lastModified: s.lastModified,
        mode: s.mode,
        isToolSession: s.isToolSession,
      },
    }))
  }

  async read(sessionId: string, opts: SessionListOptions): Promise<CanonicalMessage[]> {
    const items = await loadHistory(opts.cwd, sessionId)
    return transcriptToCanonical(items, sessionId)
  }

  async rename(sessionId: string, name: string, opts: SessionListOptions): Promise<void> {
    await renameWorkspaceSession(opts.cwd, sessionId, name)
  }

  async delete(sessionId: string, opts: SessionListOptions): Promise<void> {
    await removeSession(opts.cwd, sessionId)
  }
}
