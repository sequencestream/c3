/**
 * Task-list wire derivation (2026-06-07-009). The server-side half of the
 * independent `task_*` data path: instead of the client re-parsing
 * `tool_result.content` text, the server derives the dev session's task model and
 * pushes typed {@link import('@ccc/shared/protocol').ServerToClient} `task_list`
 * snapshots.
 *
 * Two derivation seams, both reusing the shared pure model (`applyTaskTool` —
 * single SoT in `@ccc/shared/task-model`):
 *
 *  1. **Live** — {@link observeTaskWire} is the `emit()` fan-out observer
 *     (registered at the composition root via `runs.setTaskObserver`). It watches
 *     the task-tool `tool_use`/`tool_result` events every run path already emits
 *     (Claude has no native task-push event, so the tool stream IS the source),
 *     correlates them by `toolUseId`, folds each completed call into a per-session
 *     model, and `emit()`s a `task_list` snapshot when it changes. Because the
 *     snapshot flows through `emit()` it lands in `rt.buffer`, so a reconnecting
 *     viewer replays it for free (no special-casing). Recursion is safe: the
 *     emitted `task_list` is not a task tool, so re-entry is a no-op.
 *
 *  2. **Cold replay** — {@link deriveTasksFromHistory} rebuilds the model from a
 *     session's on-disk baseline transcript (sent as `session_selected.history`),
 *     which predates this process and carries no `task_list` events. The session
 *     handler sends the derived snapshot right after `session_selected`, before the
 *     live buffer tail overrides it.
 *
 * Per-session state is keyed by the {@link SessionRuntime} object (a WeakMap), so
 * it survives a pending→real id rebind (`bindPending` keeps the same object) and
 * is GC'd with the runtime — no manual teardown.
 */
import type { ServerToClient, TranscriptItem } from '@ccc/shared/protocol'
import {
  applyTaskTool,
  emptyTaskModel,
  isTaskTool,
  type TaskListModel,
} from '@ccc/shared/task-model'
import { emit, type SessionRuntime } from '../../runs.js'

/** Per-session derivation state: the current model + un-correlated task tool_uses. */
interface TaskTracker {
  model: TaskListModel
  /** task `tool_use`s awaiting their `tool_result`, keyed by toolUseId. */
  pending: Map<string, { toolName: string; input: unknown }>
}

const trackers = new WeakMap<SessionRuntime, TaskTracker>()

function trackerFor(rt: SessionRuntime): TaskTracker {
  let t = trackers.get(rt)
  if (!t) {
    t = { model: emptyTaskModel(), pending: new Map() }
    trackers.set(rt, t)
  }
  return t
}

/**
 * `emit()` observer: derive the task model from the task-tool stream and push a
 * `task_list` snapshot on change. A no-op for non-task events (and for the
 * `task_list` it re-emits, so it never recurses meaningfully).
 */
export function observeTaskWire(rt: SessionRuntime, event: ServerToClient): void {
  if (event.type === 'tool_use') {
    if (!isTaskTool(event.toolName)) return
    trackerFor(rt).pending.set(event.toolUseId, { toolName: event.toolName, input: event.input })
    return
  }
  if (event.type === 'tool_result') {
    const t = trackers.get(rt)
    if (!t) return
    const p = t.pending.get(event.toolUseId)
    if (!p) return
    t.pending.delete(event.toolUseId)
    const next = applyTaskTool(t.model, p.toolName, p.input, {
      content: event.content,
      isError: event.isError,
    })
    // applyTaskTool returns the same object when nothing changed — skip the emit.
    if (next === t.model) return
    t.model = next
    emit(rt.sessionId, { type: 'task_list', tasks: next.tasks })
  }
}

/**
 * Rebuild the task model from a baseline transcript (cold replay). Correlates
 * task `tool_use`/`tool_result` by `toolUseId` exactly as the live observer does.
 * Pure — does not touch the live per-session state.
 */
export function deriveTasksFromHistory(history: readonly TranscriptItem[]): TaskListModel {
  let model = emptyTaskModel()
  const pending = new Map<string, { toolName: string; input: unknown }>()
  for (const item of history) {
    if (item.kind === 'tool_use') {
      if (isTaskTool(item.toolName)) {
        pending.set(item.toolUseId, { toolName: item.toolName, input: item.input })
      }
    } else if (item.kind === 'tool_result') {
      const p = pending.get(item.toolUseId)
      if (!p) continue
      pending.delete(item.toolUseId)
      model = applyTaskTool(model, p.toolName, p.input, {
        content: item.content,
        isError: item.isError,
      })
    }
  }
  return model
}
