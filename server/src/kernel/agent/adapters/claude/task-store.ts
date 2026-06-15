/**
 * Claude's {@link TaskStore} — the neutral task-tool face of the Claude vendor
 * (ADR-0011 amendment). The Claude Agent SDK has no programmatic single-tool
 * entry point: its built-in TaskCreate / TaskList / TaskUpdate / TaskGet tools run
 * only when the model calls them inside a query. So this store is a SHADOW of the
 * SDK's task system — every method drives the matching SDK tool through an injected
 * {@link ClaudeTaskExecutor} (in production, `runTaskTool`), parses the text result
 * ({@link parseCreateResult} et al.), and folds it into an in-memory shadow map.
 *
 * The shadow is what makes the store robust against the SDK's thin outputs and the
 * unpinned text format: TaskUpdate returns only a confirmation (not the full task),
 * so the store merges the patch onto its shadow entry; a TaskList that fails to
 * parse keeps the shadow rather than wrongly clearing it (mirrors the web-side
 * `task-list.ts` "无法解析快照时保持现状" rule). Every parse degrades — an empty /
 * error output never throws, it falls back to the last good shadow state.
 *
 * The executor is injected so the store's logic is unit-testable with a mock
 * (no `claude` process); {@link createClaudeTaskExecutor} builds the real one,
 * delegating to `runTaskTool` in `kernel/agent/index.ts` — the SDK import stays
 * out of `adapters/` (ADR-0011 boundary), exactly as the driver delegates to
 * `runClaude`.
 *
 * `onUpdate` is deliberately absent: the SDK has no native task-push event (unlike
 * event-driven SDK task updates), and the interface declares it "present iff the
 * vendor supports push" — so Claude omits it rather than fake a poll behind it.
 */
import type { TaskData, TaskStatus, TaskStore } from '../types.js'
import type { TaskToolName, TaskToolOutput } from '../../index.js'
import { runTaskTool } from '../../index.js'
import {
  looksLikeEmptyList,
  parseCreateResult,
  parseGetResult,
  parseListResult,
  parseUpdateResult,
} from './task-parse.js'

/**
 * Drives one SDK task tool and returns its `tool_result`. The seam between the
 * pure store logic and the live SDK; mocked in tests, {@link
 * createClaudeTaskExecutor} in production.
 */
export type ClaudeTaskExecutor = (
  toolName: TaskToolName,
  input: Record<string, unknown>,
) => Promise<TaskToolOutput>

/** Session/run context a real executor needs to drive the SDK task tools. */
export interface ClaudeTaskExecutorOptions {
  /** Working directory for the executor's one-shot query. */
  cwd: string
  /** Aborts the underlying run. */
  signal: AbortSignal
  /** Model override. Omit ⇒ SDK default. */
  model?: string
  /** Child-process env overrides (the active agent's base URL / key). */
  envOverrides?: Record<string, string>
  /** Bind to an existing SDK session so the task list is that session's. */
  resume?: string
}

/**
 * Build the production executor: each call drives the named task tool via
 * `runTaskTool`, bound to the session/run context in `opts`. Keeps the SDK import
 * inside `kernel/agent/index.ts` (ADR-0011 boundary).
 */
export function createClaudeTaskExecutor(opts: ClaudeTaskExecutorOptions): ClaudeTaskExecutor {
  return (toolName, input) =>
    runTaskTool({
      toolName,
      input,
      cwd: opts.cwd,
      signal: opts.signal,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.envOverrides ? { envOverrides: opts.envOverrides } : {}),
      ...(opts.resume ? { resume: opts.resume } : {}),
    })
}

/** Map a neutral {@link TaskData} patch to the SDK's TaskUpdate input shape. */
function toUpdateInput(taskId: string, patch: Partial<TaskData>): Record<string, unknown> {
  const input: Record<string, unknown> = { taskId }
  if (patch.subject !== undefined) input.subject = patch.subject
  if (patch.description !== undefined) input.description = patch.description
  if (patch.status !== undefined) input.status = patch.status
  if (patch.owner !== undefined) input.owner = patch.owner
  // SDK uses additive block edges (addBlocks / addBlockedBy), not replace.
  if (patch.blocks !== undefined) input.addBlocks = patch.blocks
  if (patch.blockedBy !== undefined) input.addBlockedBy = patch.blockedBy
  return input
}

/**
 * Merge an update patch onto the prior shadow task (or a minimal stub when the
 * task was never seen), producing the updated {@link TaskData} the store returns.
 * The status comes from the SDK's reported change when present, else the patch.
 */
function mergeUpdated(
  prior: TaskData | undefined,
  taskId: string,
  patch: Partial<TaskData>,
  statusTo?: TaskStatus,
): TaskData {
  const base: TaskData = prior ?? { id: taskId, subject: '', status: 'pending' }
  const merged: TaskData = {
    ...base,
    ...patch,
    id: taskId,
    status: statusTo ?? patch.status ?? base.status,
  }
  return merged
}

export class ClaudeTaskStore implements TaskStore {
  /** The shadow of the SDK task system, keyed by task id. */
  private readonly shadow = new Map<string, TaskData>()

  constructor(private readonly exec: ClaudeTaskExecutor) {}

  /**
   * Create a task. `list` is the neutral list name; the Claude SDK has a single
   * implicit task list (no list parameter on TaskCreate), so it is accepted for
   * interface parity and not forwarded. `subject` doubles as the SDK-required
   * `description` when no richer text is available.
   */
  async create(_list: string, subject: string): Promise<TaskData> {
    const out = await this.exec('TaskCreate', { subject, description: subject })
    const task = parseCreateResult(out, subject)
    if (task.id) this.shadow.set(task.id, task)
    return task
  }

  /**
   * List all tasks. A successful parse (≥1 task) replaces the shadow with the
   * fresh snapshot; a recognisably-empty list clears it; an unparseable output
   * keeps the shadow unchanged (avoids wrongly emptying the list on a parse miss).
   */
  async list(): Promise<TaskData[]> {
    const out = await this.exec('TaskList', {})
    const tasks = parseListResult(out)
    if (tasks.length > 0) {
      this.shadow.clear()
      for (const t of tasks) this.shadow.set(t.id, t)
      return tasks
    }
    if (looksLikeEmptyList(out)) {
      this.shadow.clear()
      return []
    }
    // Parse miss — keep the last good shadow rather than report an empty list.
    return [...this.shadow.values()]
  }

  /**
   * Update one task by id. The SDK confirms success but does not echo the full
   * task, so the patch is merged onto the shadow entry and the merged task is
   * returned. A failed update still returns the merged optimistic view (the
   * caller's intent) — the next {@link list}/{@link get} reconciles it.
   */
  async update(taskId: string, patch: Partial<TaskData>): Promise<TaskData> {
    const out = await this.exec('TaskUpdate', toUpdateInput(taskId, patch))
    const { statusTo } = parseUpdateResult(out)
    const merged = mergeUpdated(this.shadow.get(taskId), taskId, patch, statusTo)
    this.shadow.set(taskId, merged)
    return merged
  }

  /**
   * Get one task by id. A parsed task upserts the shadow and is returned; an
   * explicit not-found drops it from the shadow and returns `undefined`; an
   * unparseable output falls back to the shadow (the last known value, if any).
   */
  async get(taskId: string): Promise<TaskData | undefined> {
    const out = await this.exec('TaskGet', { taskId })
    const task = parseGetResult(out)
    if (task) {
      this.shadow.set(task.id, task)
      return task
    }
    if (task === null) {
      this.shadow.delete(taskId)
      return undefined
    }
    // Unparseable — best-effort fall back to the shadow.
    return this.shadow.get(taskId)
  }

  // onUpdate omitted: no native task-push event on the Claude SDK (see file head).
  // The optional-method probe (`typeof store.onUpdate === 'function'`) returns
  // false, so the upper layer degrades to pull-based list()/get() refreshes.
}
