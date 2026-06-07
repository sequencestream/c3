/**
 * OpenCode's {@link TaskStore} — the neutral task face of the OpenCode vendor
 * (ADR-0011 amendment). Like Codex (and unlike Claude's imperative tool surface),
 * OpenCode's task concept is OBSERVE-ONLY: the agent owns its `todo` list and c3
 * watches it. Two feeds, both honoured here:
 *  - REST full-fetch via {@link init} — `GET /session/{id}/todo` returns the current
 *    `Todo[]`, the snapshot the store seeds its cache from.
 *  - Live updates via {@link handleTodoUpdated} — the `todo.updated` event
 *    (`EventTodoUpdated { sessionID, todos }`) re-emits the full list as it changes.
 *
 * The live feed is FED by the driver's single event pump (the same dispatch that
 * routes `permission.*` into {@link import('./approval.js').OpencodeApprovalBridge}),
 * not by a second `event.subscribe()` — one stream, many consumers, no duplicate
 * connection or its own jitter-recovery to maintain. Tests call `init`/`handleTodoUpdated`
 * directly against a mock client, so the store is unit-testable with no OpenCode server.
 *
 * `list()`/`get()` serve the cache; `onUpdate()` is the push channel; `create()`/
 * `update()` reject — OpenCode's server owns the todo write-path and c3 has no
 * external author seam (ADR-0011 honesty rule: present ≠ fabricate).
 *
 * ADR-0009 boundary: the SDK `Todo`/`OpencodeClient` types are imported here (inside
 * `adapters/opencode/`); only neutral {@link TaskData} leaves.
 */
import type { OpencodeClient, Todo } from '@opencode-ai/sdk'
import type { Disposer, TaskData, TaskStatus, TaskStore } from '../types.js'

/** Rejection message for the unsupported write methods (OpenCode todo list is agent-driven). */
const OBSERVE_ONLY =
  'OpencodeTaskStore is observe-only: the todo list is agent-driven (todo.updated events), not externally writable'

/** Caller-resolved context the store needs to reach the right session's todo list. */
export interface OpencodeTaskStoreOptions {
  /** The workspace directory, threaded into the REST query (OpenCode keys by dir). */
  directory?: string
}

/**
 * Normalise OpenCode's free-string `status` to the neutral {@link TaskStatus}.
 * `cancelled` has no neutral analogue — it folds to `completed` (the task is no
 * longer active) with the raw value preserved in `vendorExtra.rawStatus`; an
 * unknown value is the conservative `pending` (likewise raw-preserved).
 */
function normalizeStatus(raw: string): { status: TaskStatus; rawStatus?: string } {
  switch (raw) {
    case 'pending':
    case 'in_progress':
    case 'completed':
      return { status: raw }
    case 'cancelled':
      return { status: 'completed', rawStatus: 'cancelled' }
    default:
      return { status: 'pending', rawStatus: raw }
  }
}

/** Map one OpenCode {@link Todo} to neutral {@link TaskData}; priority + raw status ride vendorExtra. */
function todoToTask(todo: Todo): TaskData {
  const { status, rawStatus } = normalizeStatus(todo.status)
  const vendorExtra: Record<string, unknown> = { priority: todo.priority }
  if (rawStatus) vendorExtra.rawStatus = rawStatus
  return { id: todo.id, subject: todo.content, status, vendorExtra }
}

export class OpencodeTaskStore implements TaskStore {
  /** The latest todo snapshot, keyed by the OpenCode-assigned todo id. */
  private readonly cache = new Map<string, TaskData>()
  private readonly handlers = new Set<(task: TaskData) => void>()

  constructor(
    private readonly getClient: () => OpencodeClient,
    private readonly sessionId: string,
    private readonly opts: OpencodeTaskStoreOptions = {},
  ) {}

  /**
   * Seed the cache from the REST full-fetch (`GET /session/{id}/todo`). Tolerant of
   * a missing/empty body (`res.data` undefined ⇒ empty list). Safe to call once at
   * wire-up before the live feed takes over; a parse-free path, so it cannot throw
   * on shape drift — it simply yields no tasks.
   */
  async init(): Promise<void> {
    const res = await this.getClient().session.todo({
      path: { id: this.sessionId },
      query: { ...(this.opts.directory ? { directory: this.opts.directory } : {}) },
    })
    this.replace(res.data ?? [])
  }

  /**
   * Absorb one `todo.updated` event. Ignored when it targets another session (the
   * driver shares one event stream across sessions). Each event carries the FULL
   * list, so the cache is replaced wholesale and changes are pushed.
   */
  handleTodoUpdated(props: { sessionID: string; todos: Todo[] }): void {
    if (props.sessionID !== this.sessionId) return
    this.replace(props.todos)
  }

  /** Replace the cache with a fresh snapshot; fire `onUpdate` for new/changed tasks only. */
  private replace(todos: Todo[]): void {
    const next = todos.map(todoToTask)
    const changed = next.filter((task) => {
      const prev = this.cache.get(task.id)
      return !prev || prev.subject !== task.subject || prev.status !== task.status
    })
    this.cache.clear()
    for (const task of next) this.cache.set(task.id, task)
    for (const task of changed) this.emit(task)
  }

  private emit(task: TaskData): void {
    for (const handler of this.handlers) handler(task)
  }

  /** The current todo snapshot from the cache. */
  list(): Promise<TaskData[]> {
    return Promise.resolve([...this.cache.values()])
  }

  /** One task by id, or `undefined` when not in the current snapshot. */
  get(taskId: string): Promise<TaskData | undefined> {
    return Promise.resolve(this.cache.get(taskId))
  }

  /** Subscribe to per-task change pushes. Returns a disposer. */
  onUpdate(handler: (task: TaskData) => void): Disposer {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  /** Unsupported — OpenCode's todo list is agent-driven (see file head). */
  create(_list: string, _subject: string): Promise<TaskData> {
    return Promise.reject(new Error(OBSERVE_ONLY))
  }

  /** Unsupported — OpenCode's todo list is agent-driven (see file head). */
  update(_taskId: string, _patch: Partial<TaskData>): Promise<TaskData> {
    return Promise.reject(new Error(OBSERVE_ONLY))
  }
}
