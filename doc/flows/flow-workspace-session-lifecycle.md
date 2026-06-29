# Flow — Workspace & Session Lifecycle

**Scenario.** The user manages the sidebar: registers a project directory, creates a new session,
selects an existing one (replaying its history), renames or deletes it. The first run of a new
session binds it to a real SDK id and freezes its vendor for life.

**Domains.** web-console · session-registry · agent-session · agent-config.

This flow produces the **viewed session** that [prompt → gated run](flow-prompt-to-gated-run.md)
consumes. It is pure registry/binding work — it never drives `query()` and never stops a run.

## Flow graph

```mermaid
flowchart TD
    AW[add_workspace] --> REG[register + re-sort sidebar]
    REG --> LS[list sessions — unified cross-vendor timeline]
    CS[create_session] --> PEND[Pending Session<br/>pending: id · default mode]
    PEND --> UP[first user_prompt]
    UP --> BIND[bind real id · freeze vendor<br/>session_started]
    SEL[select_session] --> REPLAY[replay baseline + live buffer]
    DEL[delete_session] --> STOP[stop run · remove transcript]
    RW[remove_workspace] --> ARCH[stop bg runs · keep transcripts]
```

## Add a workspace

1. **web-console → session-registry.** `add_workspace { path }`. A non-directory is rejected with
   `error`, changing nothing (`SR-R1`).
2. The workspace is registered, the sidebar re-sorts by `lastAccessed` descending (`SR-R2`, this
   one is now most-recent), and its session list is returned (`workspaces`, `sessions`).
3. Sessions are listed from the `session_metadata` projection, newest-first, one unified
   cross-vendor timeline deduped by `c3_id` (`SR-R4`, `SR-R12`). The session page requests a
   `sessionKind` slice (work / intent / spec / discussion / schedule / tool) and reads running
   counts from the same projection plus domain liveness where needed; work, intent, spec, and
   schedule are live in this phase, while discussion / tool remain placeholder tabs. Spec rows carry
   `ownerKind='intent'` / `ownerId=<intent.id>` and jump back to the intent detail's spec-session
   tab; schedule rows carry `ownerKind='schedule'` / `ownerId=<schedule.id>` and jump back to the
   schedules page. Each row carries its owning `vendor` tag, `state`, `sessionKind`, and
   optional `ownerKind`/`ownerId` for client-side jump-back. The list is **cursor-paginated** by `last_modified` (`SR-R14`): the
   first reply is the newest page; "load more" pulls the next older page via a `{lastModified,
sessionId}` keyset cursor; the periodic refresh re-fetches only the displayed range
   (`last_modified >= since`). The reply's `page.kind` tells the client how to merge it
   (`first`/`older`/`window`/`live`).

## Create → bind a session

1. **web-console → session-registry.** `create_session` (optionally `{ agentId }`) makes a
   **Pending Session** the viewed session: empty history, a `pending:` id, the per-vendor default
   mode (`SR-R6`, `AC-R8`). An `agentId` is recorded as the session's **intent** (`AC-R18`,
   `AC-R6`); absent ⇒ Auto (resolves `defaultAgentId` at run time). It is not on disk and stops no
   other run.
2. **First `user_prompt`** starts the run ([prompt → gated run](flow-prompt-to-gated-run.md)).
3. **agent-session → session-registry → agent-config.** The run's `init` binds the `pending:` id to
   the real SDK `sessionId` (`SR-R7`, `AS-R10`): the registry persists the mode under the real id,
   the runtime re-keys, and the pending **intent becomes a fact** whose **vendor is frozen**
   (`AC-R16`). `session_started` is emitted; the projection is stamped with the bind time so the
   row sorts to the **top** (`SR-R13`). The projection writes `session_kind='work'` and `bound=1`
   after bind; manual sessions keep owner null, while intent-started development sessions are
   back-linked with `owner_kind='intent'` and the intent id. A pending session that never runs
   remains a work-only `bound=0` placeholder, reaped after 7 days (`AC-R17`).

## Select / view a session

1. **web-console → session-registry.** `select_session` makes it the viewed session and replays its
   full record: `session_selected.history` (on-disk baseline) + the runtime's live buffer tail for
   any in-flight/background turn (`SR-R8`). It reports the stored mode and authoritative runtime
   `status` so the composer locks immediately (`SR-R8`). It stops no run (`AS-R8`).
2. **Codex local replay.** A tracked Codex session (`read: 'full'`) replays its local JSONL
   baseline from `~/.codex/sessions/` plus the runtime live buffer tail (`SR-R8`). Unknown Codex
   JSONL event shapes are skipped rather than making session selection fail.
3. **Selecting another session** unsubscribes the old view and subscribes the new; the old run keeps
   running in the background (`SR-R8`, `AS-R8`).

## Rename / delete / remove

- **rename_session** updates the title only. The server pushes **no** session list back
  (`SR-R14`): the acting client updates the row's title optimistically; other clients pick it up
  on their next `since` refresh.
- **delete_session** stops the session's run, removes the transcript via the SDK, drops its mode
  entry, and clears it if it was viewed/last-active (`SR-R9`). It also pushes **no** list
  (`SR-R14`, to avoid clobbering a loaded-more window); the acting client drops the row
  optimistically.
- **remove_workspace** unregisters the directory and stops any background runs under it, but
  **never** deletes on-disk transcripts (`SR-R10`); a viewed session in it is cleared.

## Branches & exceptions (anti-scenarios)

- **Per-session mode isolation.** Changing mode on session A must never change B's (`SR-R5`).
- **Switch / create never stops a run.** `select_session` / `create_session` must never stop
  another session's run (`SR-R6`/`SR-R8`, `AS-R8`).
- **Vendor is immutable once frozen.** Re-targeting a real session's agent succeeds only within the
  same vendor; a cross-vendor change is rejected (`AC-R17`) — its transcript lives only in that
  vendor's native store.
- **No permission state persisted.** Only workspace/session metadata is persisted; decisions and
  approvals never are (`SR-R11`, ADR-0004/0001).
- **Remove ≠ delete.** `remove_workspace` preserves on-disk sessions (`SR-R10`).
