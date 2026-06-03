# schedules — Models

Entity definitions. Business-semantic types; physical wiring in [design.md](design.md).
Wire shapes are defined once in the [shared protocol](../../../shared/api-conventions/websocket-protocol.md).

## Schedule

A time-bound task: a shell command or LLM prompt that fires at a configured time.

| Attribute           | Type                                         | Description                                                                                                        |
| ------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`                | text (UUID)                                  | Unique identifier for the schedule                                                                                 |
| `workspaceId`       | text (UUID)                                  | FK → session-registry workspace; immutable after creation (SCH-R1)                                                 |
| `name`              | text                                         | Human-readable display name, **auto-generated server-side** from the task content on create; never client-supplied |
| `taskType`          | enum `command \| llm_prompt`                 | Type of task to execute; immutable after creation (SCH-R2)                                                         |
| `taskConfig`        | JSON (typed per taskType)                    | Task configuration: `command` ⇒ `{ command: string }`; `llm_prompt` ⇒ `{ prompt: string, mode?: PermissionMode }`  |
| `triggerAt`         | timestamp \| null                            | One-shot trigger time (exactly one timing field is set, SCH-R3)                                                    |
| `cronExpression`    | text \| null                                 | Cron expression for recurring schedules (v1-excluded, always null in v1)                                           |
| `state`             | enum `active \| paused \| archived`          | Current lifecycle state (SCH-R5)                                                                                   |
| `executionIdentity` | enum `read-only \| sandboxed \| full-access` | Identity persona at execution time (SCH-R4)                                                                        |
| `lastExecutedAt`    | timestamp \| null                            | When the last execution started; null if never executed                                                            |
| `createdBy`         | text                                         | Creator identifier (user session id)                                                                               |
| `createdAt`         | timestamp                                    | Creation time                                                                                                      |
| `updatedAt`         | timestamp                                    | Last modification time                                                                                             |

Relationships: belongs to exactly one Workspace (by `workspaceId`). Has zero or more ExecutionLogs.
The workspace deletion cascades to **archiving** the schedule (not deleting it — SCH-R1).

### taskConfig shapes

**`command` type:**

```json
{
  "command": "pnpm build && pnpm test"
}
```

**`llm_prompt` type:**

```json
{
  "prompt": "Run a security audit on the codebase",
  "mode": "default"
}
```

`mode` in `llm_prompt` overrides the workspace session's default mode for this execution. When
omitted, the workspace session's mode is used (subject to `executionIdentity` constraints).

## ExecutionLog

The record of a single execution of a schedule.

| Attribute      | Type                                                        | Description                                                              |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `id`           | text (UUID)                                                 | Unique identifier for this execution                                     |
| `scheduleId`   | text (UUID)                                                 | FK → Schedule; identifies which schedule produced this execution         |
| `status`       | enum `pending \| running \| success \| failed \| cancelled` | Current execution status (forward-only, SCH-R10)                         |
| `trigger`      | enum `scheduled \| manual`                                  | How this execution was triggered: by the scheduler or user action        |
| `scheduledAt`  | timestamp                                                   | When the schedule was supposed to trigger                                |
| `startedAt`    | timestamp \| null                                           | When execution actually started; null while `pending`                    |
| `completedAt`  | timestamp \| null                                           | When execution reached a terminal state; null while active               |
| `output`       | text \| JSON \| null                                        | Execution output: stdout for command, message stream for llm_prompt      |
| `errorMessage` | text \| null                                                | Error detail when status is `failed`                                     |
| `exitCode`     | integer \| null                                             | Shell exit code (command type only); null while pending/running          |
| `durationMs`   | integer \| null                                             | Wall-clock duration from startedAt to completedAt; null before terminal  |
| `sessionId`    | text \| null                                                | Agent session id (llm_prompt type only); null if execution never started |

Relationships: belongs to exactly one Schedule (by `scheduleId`). Deleted when the parent schedule
is deleted (cascade). Append-only once `startedAt` is set.

## Pending Change

A mutation awaiting user confirmation in the write queue (SCH-R6, SCH-R15).

| Attribute    | Type                                             | Description                                                                      |
| ------------ | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `id`         | text (UUID)                                      | Unique identifier for this pending change                                        |
| `type`       | enum `create \| update_field \| pause \| resume` | Kind of mutation (archive/delete are immediate, not queued)                      |
| `scheduleId` | text (UUID) \| null                              | Target schedule id; null for `create` types                                      |
| `payload`    | JSON                                             | The proposed change payload (full ScheduleFields for create; partial for update) |
| `createdAt`  | timestamp                                        | When the change was proposed                                                     |

Relationships: owned by a single WebSocket connection; not persisted. Replaced or discarded by the
owner before confirmation.

## Domain type values

### `state`

```typescript
type ScheduleState = 'active' | 'paused' | 'archived'
```

### `taskType`

```typescript
type ScheduleTaskType = 'command' | 'llm_prompt'
```

### `executionIdentity`

```typescript
type ExecutionIdentity = 'read-only' | 'sandboxed' | 'full-access'
```

### `executionStatus`

```typescript
type ExecutionStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled'
```

### `pendingChangeType`

```typescript
type PendingChangeType = 'create' | 'update_field' | 'pause' | 'resume'
```

### `trigger`

```typescript
type ScheduleTrigger = 'scheduled' | 'manual'
```
