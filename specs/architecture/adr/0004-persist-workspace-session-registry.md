# 0004 — c3 persists a workspace & session registry

- **Status:** accepted
- **Date:** 2026-05-29

## Context

c3 originally bound to one project directory (`--project`) and held all state per WebSocket
connection, in memory — "closing the socket discards state". The multi-workspace / multi-session
feature requires the sidebar to survive restarts: the set of workspaces the user added, their
recent-access order, each session's permission mode, and which session was last active.

The Agent SDK already persists the sessions themselves (transcripts under
`~/.claude/projects/<encoded-cwd>/<id>.jsonl`) and exposes `listSessions` / `getSessionMessages`
/ `renameSession` / `deleteSession`. What the SDK does **not** track is c3-specific metadata:
the workspace registry, per-session permission mode, and recent-access ordering.

## Options considered

- **Keep everything in memory (no persistence).** Pros: preserves the original invariant; less
  code. Cons: the sidebar, recent-access order, and per-session modes vanish on restart — the
  feature is not usable across sessions.
- **Store c3 metadata inside the SDK transcript store (e.g. tags).** Pros: one store. Cons:
  abuses tags; can't represent empty workspaces (no sessions yet) or workspace ordering; couples
  c3 state to SDK transcript internals.
- **Persist a small c3-owned JSON file; keep the SDK as the source of truth for sessions.**
  Pros: clean split — SDK owns sessions/history/titles, c3 owns only what the SDK can't; empty
  workspaces and ordering are representable. Cons: introduces persistence (breaks the original
  in-memory invariant); a second store to keep consistent.

## Decision

Persist a c3-owned registry at `${CLAUDE_CONFIG_DIR:-~/.claude}/c3/state.json` holding: the
workspace list (path, name, `lastAccessed`), `sessionModes` keyed by SDK session id, and
`activeSessionId`. The SDK remains the source of truth for session existence, history, and
titles. The file is written atomically (temp + rename) and any read/parse error falls back to
empty state so c3 still boots.

## Consequences

- **Easier:** the sidebar, recent-access order, and per-session mode survive restarts; the SDK
  is not duplicated.
- **Harder:** there are now two stores; c3 must tolerate session ids in `state.json` that no
  longer exist on disk (stale mode entries are harmless and lazily ignored).
- The architecture's "state is per-connection and in-memory; no persistence" rule is amended:
  **permission decisions remain in-memory and per-connection** (unchanged, ADR 0001/0002), but
  the **workspace/session registry is persisted** (this ADR).
- `settingSources: []` is unaffected — transcript storage and session APIs work regardless
  (see [`claude-agent-sdk-guide.md`](../claude-agent-sdk-guide.md) §4).

## Compliance

- The registry lives only in `server/src/state.ts`; session reads go through
  `server/src/sessions.ts`. No permission state is persisted.
- Reviewers reject any persistence of permission decisions or approvals.

## References

- `specs/domains/core/session-registry/spec.md`
- `specs/architecture/architecture.md` § cross-cutting conventions
- [ADR 0001](0001-c3-sole-permission-authority.md), [ADR 0003](0003-single-binary-via-bun-compile.md)
