/**
 * Codex's {@link TaskStore} — the neutral task face of the Codex vendor (ADR-0011
 * amendment). Codex's task concept is NOT an imperative tool surface like Claude's
 * (TaskCreate/TaskList/…); it is the agent's running `todo_list` THREAD ITEM —
 * `TodoListItem { id, items: TodoItem[] }`, where every frame carries the FULL
 * current plan (a snapshot, not a delta) and `item.started`/`item.updated`/
 * `item.completed` re-emit it as the plan evolves. The driver translates that item
 * to `null` for the canonical message stream (ADR-0013 D-D: not promoted); this
 * store is where it lands instead.
 *
 * So this is an OBSERVE-ONLY store: c3 watches the agent's plan, it does not author
 * it. `list()`/`get()` serve the in-memory snapshot; `onUpdate()` is the live push
 * channel; `create()`/`update()` reject — Codex exposes no external write path into
 * the agent's todo list, and faking one would lie about the contract (ADR-0011's
 * honesty rule: a method present must not fabricate a capability the vendor lacks).
 *
 * The feed seam is {@link ingest}: the driver calls it for each `todo_list` item it
 * sees. This mirrors how {@link import('./approval.js').CodexApprovalBridge} and
 * Driver-path task bridges are fed by the driver's dispatch rather than opening a second
 * stream — one event pump, many consumers. Tests drive `ingest` directly, so the
 * store is unit-testable with no `codex` process (mirrors the injected-seam pattern
 * the {@link import('../claude/task-store.js').ClaudeTaskStore} uses for its executor).
 *
 * ADR-0009 boundary: the SDK `TodoListItem` type is imported here (inside
 * `adapters/codex/`) and consumed; only neutral {@link TaskData} leaves.
 */
import type { TodoListItem } from '@openai/codex-sdk'
import type { Disposer, TaskData, TaskStore } from '../types.js'

/** Rejection message for the unsupported write methods (Codex todo list is agent-driven). */
const OBSERVE_ONLY =
  'CodexTaskStore is observe-only: the todo list is agent-driven (todo_list thread item), not externally writable'

/**
 * Map one Codex {@link TodoListItem} frame to neutral {@link TaskData}[]. A
 * `TodoItem` has NO id of its own, so a stable id is synthesised from the list
 * item id + the item's position (`<listId>#<index>`) — stable across frames as
 * long as the plan's ordering holds, which is the only correlation Codex offers.
 */
function itemToTasks(item: TodoListItem): TaskData[] {
  return item.items.map((todo, index) => ({
    id: `${item.id}#${index}`,
    subject: todo.text,
    status: todo.completed ? 'completed' : 'pending',
  }))
}

export class CodexTaskStore implements TaskStore {
  /** The latest todo-list snapshot, keyed by synthesised task id. */
  private readonly cache = new Map<string, TaskData>()
  private readonly handlers = new Set<(task: TaskData) => void>()

  /**
   * Absorb one `todo_list` thread-item frame. Each frame is a FULL snapshot, so the
   * cache is replaced wholesale; `onUpdate` then fires for every task that is new or
   * whose subject/status changed versus the prior snapshot ("推送变化", not "推送全量").
   */
  ingest(item: TodoListItem): void {
    const next = itemToTasks(item)
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

  /** The current todo-list snapshot, extracted from the cache. */
  list(): Promise<TaskData[]> {
    return Promise.resolve([...this.cache.values()])
  }

  /** One task by synthesised id, or `undefined` when not in the current snapshot. */
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

  /** Unsupported — Codex's todo list is agent-driven (see file head). */
  create(_list: string, _subject: string): Promise<TaskData> {
    return Promise.reject(new Error(OBSERVE_ONLY))
  }

  /** Unsupported — Codex's todo list is agent-driven (see file head). */
  update(_taskId: string, _patch: Partial<TaskData>): Promise<TaskData> {
    return Promise.reject(new Error(OBSERVE_ONLY))
  }
}
