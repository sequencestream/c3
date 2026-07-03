# Flow — Automation Execution

**Scenario.** A automation's trigger fires — a cron wall-clock match or a subscribed run-lifecycle
event — and c3 executes its task (a shell command or an LLM prompt) in the bound workspace's
context under the automation's execution identity, recording the outcome in an execution log.

**Domains.** automations · session-registry · agent-session (+ kernel event bus, ADR-0018).

Automations are **workspace-scoped**: a automation runs with its workspace's `cwd`, settings, sessions,
and agent config — like a user-initiated run from that workspace. The execution runs under the
**automation's own** execution identity, not the creating user's (`SCH-R*` boundary). Writes flow
through a confirmation queue _before_ they take effect.

## Flow graph

```mermaid
flowchart TD
    W[automation_create / update] --> Q[per-connection pending queue]
    Q --> CF[confirm_queue → persist]
    CF --> SCHED[active automation]
    SCHED --> TRIG{trigger}
    TRIG -- cron tick --> DISP[dispatch & track]
    TRIG -- run lifecycle event --> DISP
    DISP --> ID{execution identity}
    ID --> CMD[command → headless shell]
    ID --> LLM[llm_prompt → agent session]
    CMD --> LOG[(execution log)]
    LLM --> LOG
    LLM --> SM[(session_metadata projection)]
```

## Write path — propose → confirm

1. **web-console → automations.** Any mutation (`automation_create` / `automation_update` /
   `automation_pause` / `automation_resume`) is captured as a **pending change** in the per-connection
   write queue and is **not** yet persisted or scheduled (`SCH-R6`, `SCH-R15`).
2. **Confirm.** `automation_confirm_queue` commits all pending changes atomically (`SCH-R6`). The
   queue is ephemeral — a refresh/reconnect loses it (`SCH-R15`).
3. **Exception.** `automation_archive` / `automation_delete` bypass the queue — immediate on a
   single-prompt confirmation (`SCH-R6`, `SCH-R14`); delete cascades the logs (hard delete).
4. **Validation.** A automation must reference an existing workspace at create time (`SCH-R1`); task
   type is immutable `command | llm_prompt` (`SCH-R2`); an `event` trigger without an `eventTopic`
   is rejected (`SCH-R17`).

## Trigger path

A automation's trigger is one of two (`SCH-R17`):

- **`cron`.** The 10 s tick loop matches `cronExpression` in the **system IANA time zone**
  (`SystemSettings.timezone`, DST-aware, `SCH-R3a`), then recomputes `nextRunAt`. Only `active`
  automations are evaluated (`SCH-R5`).
- **`event`.** A `run:started` / `run:settled`, `pr:operation`, or `intent:lifecycle` kernel-bus event (published by the relevant domain on
  every run, ADR-0018) fires the automation when **all** hold: the event's `sessionKind` is `work`
  (internal intent/discussion runs never fire user automations), the workspace matches, and — for
  `run:settled` — the terminal `reason` passes the optional `eventReasonFilter` (`SCH-R18`). Event
  automations carry no `cronExpression`/`nextRunAt` and are never tick-evaluated (`SCH-R17`).

Both reuse the **same** dispatch-and-track → execute path, three-tier execution identity, and write
queue (`SCH-R17`).

Intent lifecycle subscriptions match only the same workspace and, when configured, the selected
phase. The payload contains a stable intent identity, title, module, phase, and resulting status.
These events are process-local, best-effort, non-persistent, and never replayed. A automation run does
not modify an intent and cannot publish another intent lifecycle event.

## Execution path

1. **Workspace check.** If the workspace was removed between create and trigger, the execution fails
   immediately with `workspace_removed` (`SCH-R8`); its `pending` log is set `failed` (`SCH-R10`).
2. **Serial per automation.** At most one execution in-flight per automation; a trigger firing while the
   previous run is still going is **skipped, not queued** — this also throttles event storms
   (`SCH-R7`, `SCH-R18`).
3. **`command` ⇒ headless shell.** A shell process spawns in the workspace `cwd`; stdout+stderr are
   captured; exit 0 ⇒ `success`, non-zero ⇒ `failed` (`SCH-R12`). No permission prompts.
4. **`llm_prompt` ⇒ agent session.** A fresh agent session starts via agent-session with the
   workspace context; the prompt is the first user turn. The agent `sessionId` is captured from the
   first SDK event and persisted on the log immediately (so the transcript stays reachable even if
   the run later fails). At the same point c3 fail-soft upserts `session_metadata` with
   `session_kind='automation'`, `owner_kind='automation'`, `owner_id=<automation.id>`, so the sessions
   page automation tab can show the still-running execution. The run streams into the log; terminal
   `complete`/`error` maps to `success`/`failed` (`SCH-R13`). Vendor routing resolves the first enabled agent of
5. **Execution identity governs permissions (`SCH-R9`).** `read-only` ⇒ `plan`-equivalent, any write
   tool denied; `sandboxed` ⇒ a curated allowlist, off-list tools denied silently; `full-access` ⇒
   the workspace session's mode, all tools auto-allowed. **No `permission_request` ever reaches the
   browser for a automation run** — prompts are resolved entirely server-side.

## Log & read path

- Execution logs are **append-only** once `startedAt` is set, advancing `pending → running →
success | failed | cancelled` (`SCH-R10`). A `automations` broadcast on completion re-fetches the
  selected automation's history so finished runs appear without a manual refresh.
- The three-column view (automation list → execution-history list → execution detail) shows config,
  log rows, and a tabbed detail. The **Session** tab (llm only) replays the execution's transcript
  read-only through the shared chat-message renderer via `get_execution_transcript` (`SCH-R16`);
  a sessionless/command execution shows no Session tab and returns an empty replay, never an error.
- The sessions page `automation` tab reads those LLM execution sessions from `session_metadata`,
  not by assembling rows from `automation_execution_logs`. Running automation-session counts use
  running execution logs with non-null `session_id`; command executions and LLM failures before a
  real agent session id do not create session-page rows.

## Branches & exceptions (anti-scenarios)

- **Confirm before effect.** A trigger time or command change must never take effect before the user
  confirms the queue — an accidental save must not cause a 3 AM run (`SCH-R6`).
- **Workspace deletion archives, never deletes silently.** Removing the workspace archives its
  automations (logs preserved) and cancels in-flight executions (`SCH-R1`, `SCH-R8`).
- **No concurrent execution per automation.** A second trigger during an in-flight run never starts a
  second concurrent execution (`SCH-R7`).
- **Archive/delete are final.** An archived automation can only be deleted, never reactivated
  (`SCH-R14`); event/cron fields are mutually exclusive (`SCH-R17`).
