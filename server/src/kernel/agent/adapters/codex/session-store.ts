/**
 * Codex's {@link SessionStore} (2026-06-06-005). Unlike Claude (reads JSONL under
 * `~/.claude/projects/`) or OpenCode (reads via its REST server), the
 * `@openai/codex-sdk` exposes **no listing or reading API at all**: it only offers
 * `resumeThread(id)` to *continue* a thread, and persists threads on disk under
 * `~/.codex/sessions` in a format Phase 0 never observed (008 ran L1-static only —
 * Codex was unauthenticated, no live thread was ever written).
 *
 * Faithful-to-Phase-0 stance: the required `list`/`read` contract is honoured
 * (the methods exist and are callable — `assertNeutralAdapterShape` checks this),
 * but they return EMPTY rather than fabricate a transcript shape we never probed.
 * Reconstructing history means either an on-disk `~/.codex/sessions` reader (needs
 * the real, authenticated format) or a resume-and-replay — both are a later,
 * authenticated step (the same L2 work Phase 0 deferred). `rename`/`delete` are
 * absent (the SDK supports neither).
 *
 * Resume still works end-to-end without this: {@link import('../types.js').DriverStartOptions}
 * `resume` flows to `resumeThread`, so a known thread id can be continued; only the
 * *enumeration/back-read* of prior history is the gap documented here.
 */
import type {
  CanonicalMessage,
  SessionListOptions,
  SessionStore,
  SessionSummary,
} from '../types.js'

export class CodexSessionStore implements SessionStore {
  async list(_opts: SessionListOptions): Promise<SessionSummary[]> {
    // TODO(codex-l2): enumerate `~/.codex/sessions` once the on-disk format is
    // probed under auth. The SDK has no listing API; do not fake one.
    return []
  }

  async read(_sessionId: string, _opts: SessionListOptions): Promise<CanonicalMessage[]> {
    // TODO(codex-l2): back-read a thread (on-disk reader or resume-and-replay).
    return []
  }
}
