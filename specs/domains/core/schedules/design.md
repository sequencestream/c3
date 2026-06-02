# schedules — Design

Implements the [spec](spec.md). Lives in `server/src/schedules/` — a self-contained module with
its own store, scheduler loop, and execution dispatcher.

## Module split

| Concern               | File / Area                              | Notes                                                                                      |
| --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| Store (CRUD + SQLite) | `server/src/schedules/store.ts`          | Workspace-validated CRUD for schedules + execution logs                                    |
| Scheduler engine      | `server/src/schedules/scheduler.ts`      | Fixed-interval tick loop; queries due schedules by `next_run_at`                           |
| Execution dispatcher  | `server/src/schedules/dispatcher.ts`     | Spawns command process or LLM agent session; writes execution log                          |
| Write queue           | `server/src/schedules/queue.ts`          | _(planned)_ Per-connection pending change queue; confirm/discard lifecycle — not yet impl. |
| WS handler            | `server/src/server.ts` (schedule events) | Route schedule-related WS events to the store/scheduler                                    |
| Workspace archiving   | `server/src/schedules/archiver.ts`       | Listens for workspace removal; pauses all schedules under that workspace                   |

## Data model (SQLite)

Two tables in the project-level SQLite database (same database as
[requirement-management](../requirement-management/design.md) and
[session-registry](../../core/session-registry/design.md)):

### `schedules` (implemented schema)

```sql
CREATE TABLE schedules (
    id              TEXT PRIMARY KEY,
    type            TEXT NOT NULL,                           -- 'command' | 'llm'
    config          TEXT NOT NULL DEFAULT '{}',              -- JSON string
    workspace_path  TEXT NOT NULL,                           -- resolved absolute path
    cron_expression TEXT NOT NULL,
    next_run_at     INTEGER,                                -- Unix ms timestamp; null if not scheduled
    status          TEXT NOT NULL,                           -- 'active' | 'paused' | 'error'
    mcp_mode        TEXT NOT NULL,                           -- 'read-only' | 'sandboxed' | 'full-access'
    tool_allowlist  TEXT NOT NULL DEFAULT '[]',
    tool_denylist   TEXT NOT NULL DEFAULT '[]',
    created_at      INTEGER NOT NULL,                        -- Unix ms
    updated_at      INTEGER NOT NULL                         -- Unix ms
);
CREATE INDEX idx_sch_workspace ON schedules(workspace_path);
```

Design notes:

- `workspace_path` is the resolved absolute path (not UUID), matching the workspace registry key.
- Timing is **cron-driven**: `cron_expression` + computed `next_run_at` (Unix ms). The scheduler
  polls `SELECT * FROM schedules WHERE status='active' AND next_run_at <= ?`. After each execution,
  `next_run_at` is recomputed from the cron expression.
- `type` maps to the spec's `task_type` but uses `'llm'` instead of `'llm_prompt'` for brevity.
- `config` is a JSON blob validated at the application layer. There is no check constraint —
  validation is type-dependent and happens at create/update time.
- There is no FK constraint on `workspace_path` — workspace existence is checked at the application
  layer when creating schedules. When a workspace is removed, its schedules are **paused**
  (not cascaded) by `archiver.ts` per SCH-R1.

### `schedule_execution_logs` (implemented schema)

```sql
CREATE TABLE schedule_execution_logs (
    id              TEXT PRIMARY KEY,
    schedule_id     TEXT NOT NULL,
    started_at      INTEGER NOT NULL,                       -- Unix ms
    finished_at     INTEGER,                                -- Unix ms; nullable
    exit_code       INTEGER,                                -- nullable (command type only)
    output          TEXT NOT NULL DEFAULT '',                -- captured stdout or LLM response
    error_message   TEXT,                                   -- nullable
    status          TEXT NOT NULL DEFAULT 'running'          -- 'running' | 'success' | 'failed' | 'cancelled'
);
CREATE INDEX idx_sch_exec_schedule ON schedule_execution_logs(schedule_id);
```

Design notes:

- `ON DELETE CASCADE` — when a schedule is deleted, its logs are cascade-removed (performed at the
  application layer within a transaction, not via SQL FK, since the DDL uses simple `TEXT` columns).
- `output` stores full command stdout+stderr, or aggregated LLM text. For LLM prompts exceeding
  1 MB the output is truncated.
- `status` follows the forward chain: `running → success | failed | cancelled`. A log never
  transitions backward (enforced at the application layer — in v1 a log starts as `running` and
  is finalized to a terminal state).
- No `trigger` column — in v1 everything is cron-triggered. A manual trigger (`run_now`) dispatches
  through the same execution path.

## Store design (`store.ts`)

The store provides workspace-scoped CRUD for schedules and execution logs, using the shared SQLite
database (`~/.c3/c3.db`). Key functions used by the scheduler and dispatcher:

| Function                         | Purpose                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `getDueSchedules(now)`           | Query `WHERE status='active' AND next_run_at <= ? AND next_run_at IS NOT NULL` |
| `updateNextRunAt(id, nextRunAt)` | Update `next_run_at` after execution                                           |
| `pauseAllForWorkspace(path)`     | Set all schedules under a workspace to `paused`                                |
| `appendExecutionLog(input)`      | Create an execution log entry with `status='running'`                          |
| `updateExecutionLog(id, patch)`  | Update execution log status/output/error after execution                       |
| `listExecutionLogs(scheduleId)`  | All execution logs for a schedule, most-recently-started first                 |

## Scheduler engine (`scheduler.ts`)

The scheduler runs a fixed-interval tick loop to query and dispatch due schedules.

```typescript
class ScheduleScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight: Map<string, Promise<void>> = new Map()

  /** Start the tick loop (10s interval). */
  start(): void
  /** Stop gracefully, awaiting in-flight executions (30s max). */
  stop(timeoutMs?: number): Promise<void>

  /** Manual trigger: dispatch immediately (bypasses tick). */
  async triggerRunNow(scheduleId: string): Promise<void>
  /** Cancel an in-flight execution. */
  cancelInFlight(scheduleId: string): void
  /** Cancel all in-flight executions for a workspace. */
  cancelAllForWorkspace(workspacePath: string): void
}
```

### Tick loop

```
[10s interval] → query due schedules → for each: create log → dispatch → track in-flight
```

1. Query `getDueSchedules(Date.now())` — returns schedules where `status='active'` and
   `next_run_at <= now`.
2. Filter out schedules already tracked in `inFlight` (serial execution per schedule).
3. For each due schedule: call `appendExecutionLog()` to create a log entry, then dispatch
   via the dispatcher. The promise is stored in `inFlight` and removed via `.finally()`.
4. All errors in the tick are caught and logged — the tick loop never silently stops.

### Grace window for stale triggers

When the server restarts, some schedules' `next_run_at` may be in the past:

- Within 5 minutes of `now` → execute normally.
- Beyond 5 minutes → set status to `error`, record a `failed` execution log with
  `error_message = 'missed_trigger_window'`.

### Manual trigger (run now)

- WS event `schedule_run_now { scheduleId }` invokes `scheduler.triggerRunNow(scheduleId)`.
- Validates: schedule must exist, be `active`, and not already in-flight.
- Creates execution log and dispatches immediately (outside the tick loop).
- The execution result is broadcast via `broadcastSchedules` to refresh the UI.

## Execution dispatcher (`dispatcher.ts`)

The dispatcher provides two execution paths dispatched by schedule type:

```typescript
export async function execute(
  schedule: Schedule,
  executionLogId: string,
  updateLog: (id: string, patch: UpdateLogInput) => void,
): Promise<void>
```

### Command execution (`executeCommand`)

```typescript
export async function executeCommand(
  schedule: Schedule,
  logId: string,
  updateLog: (id: string, patch: UpdateLogInput) => void,
): Promise<void>
```

1. Parse `config.command` (shell command string) from the schedule's JSON config.
2. Spawn `child_process.spawn(command, { cwd: workspacePath, shell: true })`.
3. Accumulate stdout + stderr into `output` buffer.
4. Configurable hard timeout (`config.timeout`, default 30s) via `AbortController`:
   - On timeout → kill process → record `failed` with `error: 'timeout'`.
5. On `exit` event: exit code 0 → `success`; non-zero → `failed` with `error: 'exit_code_N'`.
6. On `error` event (process not created) → `failed` with the error message.
7. Support `config.maxRetries` (default 0): on non-zero exit or timeout, retry up to N times.
   All retries share the same log entry — only the final attempt's result is recorded.

### LLM prompt execution (`executeLlmPrompt`)

```typescript
export async function executeLlmPrompt(
  schedule: Schedule,
  logId: string,
  updateLog: (id: string, patch: UpdateLogInput) => void,
): Promise<void>
```

1. Parse `config.prompt` (LLM prompt text) from the schedule's JSON config.
2. Launch a lightweight agent session via SDK `query()`:
   - `cwd` = `schedule.workspacePath` (inherits workspace's CLAUDE.md, env vars, settings).
   - `permissionMode` = `'default'` (so `canUseTool` fires for permission control).
   - Tools available based on `schedule.mcpMode`:
     - `full-access`: all tools auto-allowed via `bypassPermissions`.
     - `sandboxed`: only Read/Grep/Glob/LS/WebFetch/WebSearch → allowed; write tools → denied.
     - `read-only`: all tools denied.
   - Wall-clock timeout (`config.maxWallClockMs`, default 60s) via `AbortSignal`.
3. Accumulate `assistant_text` blocks into `output`.
4. If `config.outputSchema` is present (JSON Schema), validate the output:
   - If validation passes → `success`.
   - If validation fails → `failed` with `error: 'schema_validation_failed: <detail>'`.
5. No auto-retry (LLM execution may have side effects). Retry requires manual re-run.
6. The agent session is ephemeral — no WebSocket viewer, not listed in session sidebar.
   Session id is NOT persisted (no need for traceability in v1).

## Write queue (`queue.ts`)

_(Planned — not implemented in v1)_

See [spec.md](spec.md) § Write confirmation queue for the design. All schedule mutations in v1 are
immediate (direct store operations + broadcast).

## Workspace archiving (`archiver.ts`)

Listens for workspace removal events and pauses all schedules belonging to that workspace.

```typescript
/** Called when a workspace is removed from the registry (from server.ts remove_workspace handler). */
export function onWorkspaceRemoved(workspacePath: string, scheduler: ScheduleScheduler): void {
  // 1. Cancel any in-flight executions under this workspace.
  scheduler.cancelAllForWorkspace(workspacePath)
  // 2. Pause all schedules in this workspace.
  store.pauseAllForWorkspace(workspacePath)
  // 3. Broadcast updated schedules for this workspace (archiver doesn't do this —
  //    the calling remove_workspace handler must call broadcastSchedules).
}
```

## Integration with server.ts

### Init

After the store is ready (post-db init), start the scheduler:

```typescript
const scheduler = new ScheduleScheduler()
if (isScheduleStoreAvailable()) scheduler.start()
```

### remove_workspace handler

The existing `remove_workspace` handler is extended:

```typescript
case 'remove_workspace': {
  const abs = resolve(msg.path)
  removeRuntimesForWorkspace(abs)
  // Pause all schedules under this workspace
  archiver.onWorkspaceRemoved(abs, scheduler)
  removeWorkspace(abs)
  sendWorkspaces(ws)
  broadcastSchedules(abs) // notify UI: schedules are now paused
  broadcastStatuses()
  return
}
```

### schedule_run_now handler

New WS event handling:

```typescript
case 'schedule_run_now': {
  if (!isScheduleStoreAvailable()) { /* error */ return }
  await scheduler.triggerRunNow(msg.scheduleId)
  // Broadcast to refresh UI with execution log
  const schedule = getSchedule(msg.scheduleId)
  if (schedule) broadcastSchedules(schedule.workspacePath)
  return
}
```

### Server shutdown

On server close, stop the scheduler gracefully:

```typescript
await scheduler.stop(30_000) // 30s timeout for in-flight tasks
```

## Technology choices

- **SQLite** for persistence — shares the existing project-level database. No additional runtime
  dependency.
- **`child_process.spawn`** with `shell: true` for command execution. Simple, well-understood, no
  external runner dependency.
- **Fixed-interval tick** (10s) rather than event-driven timer per schedule. Avoids managing N
  timers and is simpler to reason about.
- **In-process dispatcher** — no job queue. All executions run in the server process.
- **SDK `query()`** for LLM prompt execution — reuses the existing Agent SDK integration pattern.
- **`config` as JSON** avoids schema evolution complexity across two task types.

## Non-functional considerations

- **Latency:** Scheduler ticks are low-latency (DB query + in-memory filter). Execution latency is
  task-dependent and unbounded.
- **Reliability:** The scheduler loop is a single `setInterval`. If a tick's handler throws, the
  error is caught and logged; the interval continues.
- **Memory:** In-flight tracking uses a `Map<scheduleId, Promise>`. With typical usage (tens of
  schedules), memory is negligible.
- **Storage:** Execution logs grow indefinitely. A log retention policy is deferred to a future
  iteration.
- **Security:** Command schedules run with the server process's user. LLM prompt schedules use
  the schedule's `mcpMode` for tool access control.

## Dependencies

| Dependency                                  | Purpose                                       |
| ------------------------------------------- | --------------------------------------------- |
| `cron-parser` (npm, added)                  | Parse cron expressions, compute next run time |
| `child_process` (built-in)                  | Execute command-type schedules                |
| `@anthropic-ai/claude-agent-sdk` (existing) | LLM prompt execution via `query()`            |
| `node:crypto` (existing)                    | Generate log ids                              |

## Config shapes (JSON)

### command type

```json
{
  "command": "echo hello",
  "timeout": 30000,
  "maxRetries": 0
}
```

### llm type

```json
{
  "prompt": "分析当前目录结构并生成报告",
  "maxWallClockMs": 60000,
  "outputSchema": {
    "type": "object",
    "properties": {
      "files": { "type": "array", "items": { "type": "string" } }
    }
  }
}
```

Both are stored as the `config` column JSON blob, validated at the application layer.
