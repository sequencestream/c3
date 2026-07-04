# automations — Models

Entity definitions. Business-semantic types; physical wiring in [automations-design.md](automations-design.md).
Wire shapes are defined once in the [shared protocol](../../../shared/api-conventions/websocket-protocol.md).

## Automation

A time-bound task: a shell command or LLM prompt that fires at a configured time.

| Attribute                | Type                                                             | Description                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                     | text (UUID)                                                      | Unique identifier for the automation                                                                                                                                                                                                                                                                                                                                                                   |
| `workspaceId`            | text (UUID)                                                      | FK → session-registry workspace; immutable after creation (SCH-R1)                                                                                                                                                                                                                                                                                                                                     |
| `name`                   | text                                                             | Human-readable display name. **Auto-generated server-side** from the task content on create (client name stripped). On **update** the client may supply a manual title: a non-empty value is stored sticky (`nameSource='user'`, auto-naming never overrides it); an empty value reverts to an auto-derived name (SCH-R19).                                                                            |
| `taskType`               | enum `command \| llm_prompt`                                     | Type of task to execute; immutable after creation (SCH-R2)                                                                                                                                                                                                                                                                                                                                             |
| `taskConfig`             | JSON (typed per taskType)                                        | Task configuration: `command` ⇒ `{ command: string }`; `llm_prompt` ⇒ `{ prompt: string, mode?: PermissionMode }`                                                                                                                                                                                                                                                                                      |
| `vendor`                 | vendor id                                                        | Persisted vendor scope for the task's tool manifest, execution policy, and adapter route.                                                                                                                                                                                                                                                                                                              |
| `agentId`                | text \| null                                                     | Explicit enabled Agent selected for an LLM task. Its vendor must equal the Automation vendor; null only for command tasks and legacy tasks awaiting repair.                                                                                                                                                                                                                                            |
| `maxWallClockMs`         | integer \| null                                                  | Maximum wall-clock duration for one execution in milliseconds. Null uses the task-type default: 30 seconds for command and 60 seconds for LLM. Explicit values are whole milliseconds from 1 second through 24 hours.                                                                                                                                                                                  |
| `triggerType`            | enum `cron \| event`                                             | How the automation fires (SCH-R17). Defaults to `cron` for rows migrated before this field existed (2026-06-08).                                                                                                                                                                                                                                                                                       |
| `triggerAt`              | timestamp \| null                                                | One-shot trigger time (exactly one timing field is set, SCH-R3)                                                                                                                                                                                                                                                                                                                                        |
| `cronExpression`         | text \| null                                                     | Cron expression for `cron` triggers; interpreted in the system IANA time zone (`SystemSettings.timezone`, SCH-R3a), not UTC. Empty string for `event` triggers.                                                                                                                                                                                                                                        |
| `eventTopic`             | enum `run:started \| run:settled \| pr:operation` \| null        | For `event` triggers: the topic subscribed to on the kernel bus — a run lifecycle topic or the `pr:operation` event (model-published or server-side, SCH-R17, 2026-06-20). Null for `cron`.                                                                                                                                                                                                            |
| `eventReasonFilter`      | `RunEndReason[]` \| null                                         | For `run:settled` event triggers: fire only on these terminal reasons; null/`[]` = any (SCH-R18). Ignored for `run:started` / `pr:operation`.                                                                                                                                                                                                                                                          |
| `eventPrFilter`          | `{ operations?, results? }` \| null                              | For `pr:operation` event triggers: fire only when the event's `operation` ∈ `operations` AND `result` ∈ `results`; an empty/absent dimension = any (SCH-R22). Null for cron / run-lifecycle. `operations` ⊆ `create\|review\|merge\|close\|comment`; `results` ⊆ `success\|failure\|error` (2026-06-20, 2026-07-02 扩展 error).                                                                        |
| `eventSessionKindFilter` | `SessionKind[]` \| null                                          | For run-lifecycle event triggers (`run:started` / `run:settled`): the explicit, **non-empty** set of SessionKind origins that may fire it (SCH-R18, 2026-07-04, replaces the hardcoded `['work']` whitelist). Required — a create/update with a missing/empty value is rejected (`automation.missingSessionKindFilter`). Null for cron / pr / intent. Legacy run-lifecycle rows migrate to `['work']`. |
| `eventMetadataFilter`    | `{ conditions: {key,value}[], combinator: 'AND'\|'OR' }` \| null | For run-lifecycle event triggers: metadata condition filter (SCH-R25). Null/empty conditions = match any. `AND` = every condition equals the event's `metadata[key]` exactly; `OR` = at least one. Null for cron / pr / intent.                                                                                                                                                                        |
| `metadata`               | `Record<string,string>`                                          | Free-form key/value annotations (SCH-R25, 2026-07-04). No preset keys / schema; sanitized (trimmed, empty dropped, ≤32 entries, key ≤64 / value ≤256 chars). Only the scheduler's own run events for this automation carry it into the event payload. Defaults to `{}`.                                                                                                                                |
| `state`                  | enum `active \| paused \| archived`                              | Current lifecycle state (SCH-R5)                                                                                                                                                                                                                                                                                                                                                                       |
| `executionIdentity`      | enum `read-only \| sandboxed \| full-access`                     | Identity persona at execution time (SCH-R4)                                                                                                                                                                                                                                                                                                                                                            |
| `lastExecutedAt`         | timestamp \| null                                                | When the last execution started; null if never executed                                                                                                                                                                                                                                                                                                                                                |
| `createdBy`              | text                                                             | Creator identifier (user session id)                                                                                                                                                                                                                                                                                                                                                                   |
| `createdAt`              | timestamp                                                        | Creation time                                                                                                                                                                                                                                                                                                                                                                                          |
| `updatedAt`              | timestamp                                                        | Last modification time                                                                                                                                                                                                                                                                                                                                                                                 |

Relationships: belongs to exactly one Workspace (by `workspaceId`). Has zero or more ExecutionLogs.
The workspace deletion cascades to **archiving** the automation (not deleting it — SCH-R1).

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

The record of a single execution of a automation.

| Attribute      | Type                                                        | Description                                                              |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `id`           | text (UUID)                                                 | Unique identifier for this execution                                     |
| `automationId` | text (UUID)                                                 | FK → Automation; identifies which automation produced this execution     |
| `status`       | enum `pending \| running \| success \| failed \| cancelled` | Current execution status (forward-only, SCH-R10)                         |
| `trigger`      | enum `scheduled \| manual`                                  | How this execution was triggered: by the scheduler or user action        |
| `scheduledAt`  | timestamp                                                   | When the automation was supposed to trigger                              |
| `startedAt`    | timestamp \| null                                           | When execution actually started; null while `pending`                    |
| `completedAt`  | timestamp \| null                                           | When execution reached a terminal state; null while active               |
| `output`       | text \| JSON \| null                                        | Execution output: stdout for command, message stream for llm_prompt      |
| `errorMessage` | text \| null                                                | Error detail when status is `failed`                                     |
| `exitCode`     | integer \| null                                             | Shell exit code (command type only); null while pending/running          |
| `durationMs`   | integer \| null                                             | Wall-clock duration from startedAt to completedAt; null before terminal  |
| `sessionId`    | text \| null                                                | Agent session id (llm_prompt type only); null if execution never started |

Relationships: belongs to exactly one Automation (by `automationId`). Deleted when the parent automation
is deleted (cascade). Append-only once `startedAt` is set.

## Pending Change

A mutation awaiting user confirmation in the write queue (SCH-R6, SCH-R15).

| Attribute      | Type                                             | Description                                                                        |
| -------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `id`           | text (UUID)                                      | Unique identifier for this pending change                                          |
| `type`         | enum `create \| update_field \| pause \| resume` | Kind of mutation (archive/delete are immediate, not queued)                        |
| `automationId` | text (UUID) \| null                              | Target automation id; null for `create` types                                      |
| `payload`      | JSON                                             | The proposed change payload (full AutomationFields for create; partial for update) |
| `createdAt`    | timestamp                                        | When the change was proposed                                                       |

Relationships: owned by a single WebSocket connection; not persisted. Replaced or discarded by the
owner before confirmation.

## Domain type values

The permitted values for each enumerated attribute:

- **state** — `active` | `paused` | `archived`
- **taskType** — `command` | `llm_prompt`
- **triggerType** (event trigger, 2026-06-08) — `cron` | `event`
  - event topic — `run:started` | `run:settled` (run-lifecycle) | `pr:operation` (model-published or server-side, 2026-06-20)
  - run end reason — `complete` | `error` | `aborted`
  - the kinds carried on `run:started` / `run:settled` are the **SessionKind** (business scenario —
    `work` | `intent` | `discussion` | `automation` | `consensus` | `tool` | `spec`; only `work` fires
    user automations) and the **RunKind** (execution form — `interactive` | `background` | `headless` |
    `internal`)
  - PR operation (`pr:operation`) — `create` | `review` | `merge` | `close` | `comment`
  - PR operation result — `success` | `failure` | `error`
- **executionIdentity** — `read-only` | `sandboxed` | `full-access`
- **executionStatus** — `pending` | `running` | `success` | `failed` | `cancelled`
- **pendingChangeType** — `create` | `update_field` | `pause` | `resume`
- **trigger** — `scheduled` | `manual`
