# automations — Design

Implements the [spec](automations-spec.md). A self-contained domain module with its own store, scheduler loop,
and execution dispatcher.

## Responsibility split

| Concern               | Responsibility                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------ |
| Store (CRUD + SQLite) | Workspace-validated CRUD for automations + execution logs                                  |
| Scheduler engine      | Fixed-interval tick loop; queries due automations by their next-run instant                |
| Execution dispatcher  | Spawns a command process or an LLM agent session; writes the execution log                 |
| Write queue           | _(planned)_ Per-connection pending-change queue; confirm/discard lifecycle — not yet impl. |
| WS handling           | Routes automation-related WebSocket events to the store/scheduler                          |
| Workspace archiving   | Listens for workspace removal; pauses all automations under that workspace                 |

## Data model (SQLite)

Two tables in the project-level SQLite database (same database as
[intent-management](../intent-management/intent-management-design.md) and
[session-registry](../../core/session-registry/session-registry-design.md)):

### `automations` (implemented schema)

```sql
CREATE TABLE automations (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,                           -- 'command' | 'llm'
    config          TEXT NOT NULL DEFAULT '{}',              -- JSON string
    workspace_path  TEXT NOT NULL,                           -- resolved absolute path
    trigger_type        TEXT NOT NULL DEFAULT 'cron',         -- 'cron' | 'event' (v5, 2026-06-08)
    cron_expression     TEXT NOT NULL,                        -- '' for event triggers
    next_run_at         INTEGER,                              -- Unix ms; null for event triggers
    event_topic         TEXT,                                 -- 'run:started' | 'run:settled' | 'pr:operation' | null
    event_reason_filter TEXT,                                 -- JSON RunEndReason[] | null (run:settled)
    event_pr_filter     TEXT,                                 -- JSON {operations?,results?} | null (pr:operation, v8 2026-06-20)
    status          TEXT NOT NULL,                           -- 'active' | 'paused' | 'error'
    mcp_mode        TEXT NOT NULL,                           -- 'read-only' | 'sandboxed' | 'full-access'
    tool_allowlist  TEXT NOT NULL DEFAULT '[]',
    tool_denylist   TEXT NOT NULL DEFAULT '[]',
    created_at      INTEGER NOT NULL,                        -- Unix ms
    updated_at      INTEGER NOT NULL                         -- Unix ms
);
CREATE INDEX idx_sch_workspace ON automations(workspace_path);
```

Design notes:

- `workspace_path` is the resolved absolute path (not UUID), matching the workspace registry key.
- Timing is **cron-driven**: a cron expression plus a computed next-run instant (Unix ms). The
  scheduler polls for active rows whose next-run instant is at or before now. After each execution,
  the next-run instant is recomputed from the cron expression.
- **Time zone:** cron fields are interpreted in the **system-wide IANA time zone** (the configured
  system timezone, see [system-config](../../system-config/)), not in UTC. The next-run computation
  takes the zone and maps the wall-clock cron to an absolute instant, handling daylight-saving
  transitions (spring-forward gap times are skipped; fall-back fold times take the earlier offset).
  Both server call sites (create/update and the post-run recompute) pass the configured zone; the web
  preview passes the same zone so its next/upcoming-run display matches the scheduled instant. The
  default zone is the **server's local time zone** — an invalid/unset value falls back to it. Omitting
  the zone (or specifying UTC) keeps the historical UTC computation, unchanged. **Behaviour change:**
  this replaces the previous UTC-only interpretation. On upgrade, existing automations' actual trigger
  moments shift from UTC to the server-local (or configured) zone — e.g. `0 11 * * *` moves from 11:00
  UTC to 11:00 local. This is intentional (it aligns cron with what the user sees) and requires no
  migration: the next-run instant is recomputed on the next create/update/run.
- **Trigger type (v5, 2026-06-08):** the trigger type selects `cron` (timing via the cron expression
  and next-run instant) or `event` (a kernel run-lifecycle event). Event rows keep an empty cron
  expression, a null next-run instant, and set the event topic (plus an optional event reason filter,
  a JSON list of terminal reasons). The due-automation query only returns cron rows (event rows have a
  null next-run instant). The v5 migration adds the three columns idempotently by inspecting the
  existing column set (the shared global schema-version counter is untrusted, same as the v2–v4
  migrations), defaulting legacy rows to `cron` (SCH-R17).
- **Internal one-shot agent recovery (2026-06-15-002):** no schema migration is required. The
  recovery flow stores a normal `command` row whose config marks it an agent-quota-recovery action,
  names the disabled agent, and records the absolute reset instant; the next-run instant is set to
  that reset instant. The dispatcher recognises this config and re-enables the agent instead of
  spawning a shell; the scheduler then sets the status to `paused` and clears the next-run instant,
  making the row one-shot.
- The stored `type` maps to the spec's task type but uses `'llm'` instead of `'llm_prompt'` for brevity.
- The config column is a JSON blob validated at the application layer. There is no check constraint —
  validation is type-dependent and happens at create/update time.
- There is no foreign-key constraint on the workspace path — workspace existence is checked at the
  application layer when creating automations. When a workspace is removed, its automations are **paused**
  (not cascaded) by the workspace-archiving step per SCH-R1.

### `automation_execution_logs` (implemented schema)

```sql
CREATE TABLE automation_execution_logs (
    id              TEXT PRIMARY KEY,
    automation_id     TEXT NOT NULL,
    started_at      INTEGER NOT NULL,                       -- Unix ms
    finished_at     INTEGER,                                -- Unix ms; nullable
    exit_code       INTEGER,                                -- nullable (command type only)
    output          TEXT NOT NULL DEFAULT '',                -- captured stdout or LLM response
    error_message   TEXT,                                   -- nullable
    status          TEXT NOT NULL DEFAULT 'running'          -- 'running' | 'success' | 'failed' | 'cancelled'
);
CREATE INDEX idx_sch_exec_automation ON automation_execution_logs(automation_id);
```

Design notes:

- Cascade delete — when a automation is deleted, its logs are cascade-removed (performed at the
  application layer within a transaction, not via a database foreign key, since the schema uses simple
  text columns).
- The output column stores full command stdout+stderr, or aggregated LLM text. For LLM prompts
  exceeding 1 MB the output is truncated.
- The status follows the forward chain: `running → success | failed | cancelled`. A log never
  transitions backward (enforced at the application layer — in v1 a log starts as `running` and
  is finalised to a terminal state).
- No trigger column — in v1 everything is cron-triggered. A manual trigger ("run now") dispatches
  through the same execution path.

## Store design

The store provides workspace-scoped CRUD for automations and execution logs, using the shared SQLite
database under the c3 home. Key capabilities used by the scheduler and dispatcher:

| Capability                | Purpose                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------- |
| Fetch due automations     | Return active rows whose next-run instant is set and at or before a given instant  |
| Fetch event automations   | Return active `event` automations subscribed to a run-lifecycle topic (2026-06-08) |
| Update next-run instant   | Persist the recomputed next-run instant after execution                            |
| Pause all for a workspace | Set every automation under a workspace to `paused`                                 |
| Append execution log      | Create an execution-log entry in the `running` state                               |
| Update execution log      | Update an execution log's status/output/error after execution                      |
| List execution logs       | All execution logs for a automation, most-recently-started first                   |

## Scheduler engine

The scheduler runs a fixed-interval tick loop to query and dispatch due automations. Its responsibilities:

- **Start** the tick loop (10 s interval).
- **Stop** gracefully, awaiting in-flight executions (30 s max).
- **Run now** — manual trigger: dispatch immediately, bypassing the tick.
- **Dispatch event automations** — on a run-lifecycle bus event, dispatch the event-subscribed
  automations for that topic (2026-06-08).
- **Cancel** an in-flight execution, or cancel all in-flight executions for a workspace.

It tracks in-flight executions in an in-memory map keyed by automation id (one promise per automation),
which both enforces serial execution and bounds graceful shutdown.

### Tick loop

Every 10 s: query due automations → for each, create a log → dispatch → track in-flight.

1. Query for due automations — active rows whose next-run instant is at or before now.
2. Filter out automations already in-flight (serial execution per automation).
3. For each due automation: append a log entry, then dispatch. The dispatch is tracked in the in-flight
   map and removed when it settles.
4. Internal agent-recovery rows are paused and have their next-run instant cleared after execution,
   instead of being re-armed from their cron expression.
5. All errors in the tick are caught and logged — the tick loop never silently stops.

### Grace window for stale triggers

When the server restarts, some automations' next-run instant may be in the past:

- Within 5 minutes of now → execute normally.
- Beyond 5 minutes → retain `active` status, record a `failed` execution log noting a missed trigger
  window, and recompute `next_run_at` from now. The missed occurrence is not replayed and the
  recurring automation continues at its next cron occurrence.
- Internal agent-recovery rows are exempt from the missed-trigger error path; a late server restart
  should still re-enable the agent rather than strand it disabled.

### Manual trigger (run now)

- The `automation_run_now` WebSocket event invokes the scheduler's run-now path for the target automation.
- Validates: the automation must exist, be `active` or `paused` (not `archived`), and not already
  in-flight. This one-off manual execution does not change `status`; a paused automation remains
  paused and its `next_run_at` is not recomputed.
- Creates an execution log and dispatches immediately (outside the tick loop).
- The execution result is broadcast to refresh the UI.

### Event-triggered dispatch (2026-06-08, extended 2026-06-20)

The event-dispatch path is wired to the kernel event bus in the composition root, subscribing to
`run:started` / `run:settled` (run-lifecycle) and `pr:operation` (model-published or server-side). On each event:

1. **Run-lifecycle topics only:** if the event's run kind is not a user `session` run → return
   (internal comm runs never fire user automations, SCH-R18). `pr:operation` carries no run kind and
   skips this gate (SCH-R22).
2. Fetch active `event` automations for this topic.
3. Keep those whose workspace matches (both sides resolved), then apply the topic filter: for
   `run:settled`, the event reason filter (null/empty = any); for `pr:operation`, the PR filter — the
   event's `operation` ∈ `eventPrFilter.operations` AND `result` ∈ `eventPrFilter.results`, each
   empty/null dimension = any (SCH-R22).
4. Skip any automation already in-flight (SCH-R7 serial execution = event-storm throttle).
5. Survivors run through the **same** dispatch-and-track → execute path as cron runs (so the
   three-tier MCP security + write-approval queue apply unchanged). The post-run re-arm skips the
   next-run recompute for `event` automations (they have no cron).

The run-lifecycle publish points live in the run path. The `pr:operation` publish point has two
sources: the `publish_pr_event` MCP tool (c3 provides it to every work session so the model can
publish a vendor-neutral event after performing a PR operation with its own tools), and the
server-side PR creation paths (dev-cleanup / automation / manual create_pr) which publish a
`create`/`success` event after successfully creating a PR on the model's behalf. See
automations-spec.md § Triggers → PR operation events (SCH-R22 / SCH-R23).

The `pr:operation` bus event has a **second, independent** resident consumer registered in
`run-domain-subscriptions.ts` (NOT this dispatch path): on `operation=update` + `result=success`
carrying `association.intentId`, the intent domain resets a rejected/failed/closed intent's `prStatus`
back to `reviewing`. It lives outside `dispatchEventTriggers` on purpose — the ledger state machine must
recover even when no automation is configured, the Automation store is unavailable, or the automation is
skipped by the in-flight gate. The two are separate side-effects of the same event; neither blocks the
other.

## Execution dispatcher

The dispatcher provides two execution paths, chosen by automation type. Each takes the automation, the
execution-log id, and a callback to update the log, and runs to a terminal state.

### Command execution

1. Read the command string from the automation's JSON config.
2. Spawn a headless shell process in the automation's workspace directory.
3. Accumulate stdout + stderr into the output buffer.
4. Configurable hard timeout through the automation-level `maxWallClockMs` field (default 30 s):
   - On timeout → kill the process → record `failed` noting a timeout.
5. On process exit: exit code 0 → `success`; non-zero → `failed` noting the non-zero exit code.
6. On a process-creation failure → `failed` with the error message.
7. Support a config max-retries field (default 0): on non-zero exit or timeout, retry up to N times.
   All retries share the same log entry and the same `maxWallClockMs` deadline — only the final attempt's result is recorded.

### Internal agent recovery execution

Before normal command dispatch, the dispatcher checks whether the config marks the row an
agent-quota-recovery action. Such a row is system-owned: it never spawns a shell and ignores the user
command config. The dispatcher re-enables the named agent through the agent-config module, writes a
success/failure execution log, and returns. The scheduler's post-run branch detects the same config,
marks the automation `paused`, and clears the next-run instant, so the row is retained for audit but
cannot repeat.

### LLM prompt execution

1. Read the prompt text from the automation's JSON config.
2. Resolve the agent by the automation's vendor — the first enabled agent of that vendor, falling back
   to the default agent. Execution routes through the shared SDK query path; dedicated adapter driver
   paths are a future entry.
3. Launch a lightweight agent session via the SDK query path:
   - Working directory = the automation's workspace (inherits the workspace's project instructions, env
     vars, settings).
   - Permission mode = default (so the per-tool permission callback fires for permission control).
   - Tools available based on the automation's execution identity:
     - `full-access`: all tools auto-allowed (bypass-permissions).
     - `sandboxed`: only the read-only tool set (read/grep/glob/list/web-fetch/web-search) is allowed;
       write tools are denied.
     - `read-only`: all tools denied.
   - Wall-clock timeout through the automation-level `maxWallClockMs` field (default 60 s).
4. Accumulate assistant-text blocks into the output.
5. If the config carries an output schema (JSON Schema), validate the output:
   - If validation passes → `success`.
   - If validation fails → `failed` noting a schema-validation failure with detail.
6. No auto-retry (LLM execution may have side effects). Retry requires a manual re-run.
7. The agent session is ephemeral — no WebSocket viewer, not listed in the session sidebar.
   The session id is NOT persisted (no need for traceability in v1).

**Codex vendor path (`driver.start`).** A codex automation runs through the codex driver rather than the
shared SDK query path. Before starting, the dispatcher resolves the host `gh` keyring credential and,
when neither `GH_TOKEN` nor `GITHUB_TOKEN` is already set, injects `GH_TOKEN` into the driver
`envOverrides` so PR review/comment/merge shell commands authenticate inside the seatbelt sandbox (see
[codex-sdk-guide § GitHub CLI 凭据桥接](../../../architecture/codex-sdk-guide.md)). This is orthogonal to
network: the codex path does not pass `networkAccess`, so sandbox network stays governed by the
automation's `mode`/`toolAllowlist`. A resolved token with the network off is **not** an auth failure —
diagnostics distinguish a missing host token from sandbox network isolation and never reduce to "re-run
`gh auth login`". Probe failure is non-fatal and never blocks the execution.

## Write queue

_(Planned — not implemented in v1)_

See [automations-spec.md](automations-spec.md) § Write confirmation queue for the design. All automation mutations in v1 are
immediate (direct store operations + broadcast).

## Workspace archiving

Listens for workspace-removal events and pauses all automations belonging to that workspace. When a
workspace is removed from the registry, the archiving step:

1. Cancels any in-flight executions under that workspace.
2. Pauses all automations in that workspace.
3. Leaves the post-removal automation broadcast to the caller that handled the workspace removal.

## Integration with the server

### Init

After the store is ready (post-db init), start the scheduler and subscribe to the kernel event bus
for event-triggered automations (2026-06-08). When the automation store is available, the scheduler is
started and the event-dispatch path is subscribed to both `run:started` and `run:settled` for the
whole server run (process-lifetime subscriptions, no dispose).

### Workspace removal

The workspace-removal handler is extended to tear down its runtimes, run the archiving step (which
cancels in-flight executions and pauses the workspace's automations), remove the workspace, and then
broadcast the now-paused automations and refreshed statuses to the UI.

### Run now

The run-now handler validates the store is available, invokes the scheduler's run-now path for the
target automation, then broadcasts the workspace's automations to refresh the UI with the new execution
log.

### Server shutdown

On server close, stop the scheduler gracefully with a 30 s timeout for in-flight tasks.

## Technology choices

- **SQLite** for persistence — shares the existing project-level database. No additional runtime
  dependency.
- **A headless shell process** for command execution. Simple, well-understood, no external runner
  dependency.
- **Fixed-interval tick** (10 s) rather than an event-driven timer per automation. Avoids managing N
  timers and is simpler to reason about.
- **In-process dispatcher** — no job queue. All executions run in the server process.
- **The SDK query path** for LLM prompt execution — reuses the existing Agent SDK integration pattern.
- **Config as JSON** avoids schema-evolution complexity across two task types.

## Non-functional considerations

- **Latency:** Scheduler ticks are low-latency (DB query + in-memory filter). Execution latency is
  task-dependent and unbounded.
- **Reliability:** The scheduler loop is a single fixed-interval timer. If a tick's handler throws,
  the error is caught and logged; the interval continues.
- **Memory:** In-flight tracking uses an in-memory map keyed by automation id. With typical usage (tens
  of automations), memory is negligible.
- **Storage:** Execution logs grow indefinitely. A log retention policy is deferred to a future
  iteration.
- **Security:** Command automations run as the server process's user. LLM prompt automations use the
  automation's execution identity for tool-access control.

## Dependencies

| Dependency                        | Purpose                                       |
| --------------------------------- | --------------------------------------------- |
| A cron-parsing library            | Parse cron expressions, compute next-run time |
| The host's process-spawn facility | Execute command-type automations              |
| The Claude Agent SDK              | LLM prompt execution via the query path       |
| A cryptographic id generator      | Generate log ids                              |

## Config shapes (JSON)

### command type

```json
{
  "command": "echo hello",
  "maxRetries": 0
}
```

### llm type

```json
{
  "prompt": "分析当前目录结构并生成报告",
  "outputSchema": {
    "type": "object",
    "properties": {
      "files": { "type": "array", "items": { "type": "string" } }
    }
  }
}
```

Both are stored as the config-column JSON blob, validated at the application layer.
