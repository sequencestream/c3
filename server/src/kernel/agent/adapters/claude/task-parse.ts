/**
 * Claude task-tool output parsing (ADR-0011, TaskStore amendment). The SDK's
 * built-in task tools (TaskCreate / TaskList / TaskUpdate / TaskGet) return their
 * result as a `tool_result` whose `content` is a STRING — not a typed object. The
 * exact serialization is not contractually pinned: a structured result may arrive
 * JSON-stringified (`{"task":{"id":"1",...}}`), while TaskCreate's confirmation is
 * a human line (`"Created task 1: Fix login bug"`). So every parser here is
 * dual-mode — JSON first (the structured shapes from `sdk-tools.d.ts`), text regex
 * as the fallback — and every one degrades safely: an unparseable / error output
 * yields `null` / `undefined` / `[]`, never a throw (the {@link ClaudeTaskStore}
 * shadow then keeps the last good state rather than crashing the caller).
 *
 * These are pure functions over `{ content, isError }`, unit-tested without
 * spawning a `claude` process; the live tool invocation lives in `runTaskTool`
 * (`kernel/agent/index.ts`), which feeds its output here.
 */
import type { TaskData, TaskStatus } from '../types.js'
import type { TaskToolOutput } from '../../index.js'

const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed']

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Normalise an id-like field (string or finite number) to a non-empty string. */
function asId(v: unknown): string | undefined {
  if (typeof v === 'string') return v.length > 0 ? v : undefined
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

/** Status fault-tolerance: only the three legal values; anything else ⇒ pending. */
function normalizeStatus(v: unknown): TaskStatus {
  if (typeof v !== 'string') return 'pending'
  const s = v.toLowerCase().replace(/\s+/g, '_')
  if (s === 'done' || s === 'complete' || s === 'completed') return 'completed'
  if (s === 'in_progress') return 'in_progress'
  return (TASK_STATUSES as readonly string[]).includes(s) ? (s as TaskStatus) : 'pending'
}

/** Fault-tolerant string-id array extraction; no valid item ⇒ undefined (unset). */
function asIdArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  const ids = v.map(asId).filter((x): x is string => x !== undefined)
  return ids.length > 0 ? ids : undefined
}

/**
 * Best-effort JSON parse of a tool_result string. Tries the whole content first,
 * then a balanced `{…}` / `[…]` slice (the SDK may wrap the JSON in prose). Returns
 * `undefined` on failure rather than throwing.
 */
function tryParseJson(content: string): unknown {
  const direct = tryParse(content)
  if (direct !== undefined) return direct
  // Fall back to the first balanced object/array substring.
  const start = content.search(/[{[]/)
  if (start === -1) return undefined
  const open = content[start]
  const close = open === '{' ? '}' : ']'
  const end = content.lastIndexOf(close)
  if (end <= start) return undefined
  return tryParse(content.slice(start, end + 1))
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

/**
 * Normalise one task-like JSON record into a {@link TaskData}. Tolerates the SDK's
 * field aliases (`taskId`/`id`, `content`/`description`). Returns `null` when no id
 * can be read (a task with no id can be neither tracked nor updated).
 */
export function normalizeTaskObject(raw: unknown): TaskData | null {
  if (!isObject(raw)) return null
  const id = asId(raw.id ?? raw.taskId)
  if (id === undefined) return null
  const description = asString(raw.description ?? raw.content)
  const blockedBy = asIdArray(raw.blockedBy)
  const blocks = asIdArray(raw.blocks)
  const owner = asString(raw.owner)
  return {
    id,
    // subject degradation chain: subject → title → truncated description → ''.
    subject: asString(raw.subject) ?? asString(raw.title) ?? description?.slice(0, 80) ?? '',
    status: normalizeStatus(raw.status),
    ...(description !== undefined ? { description } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(blockedBy !== undefined ? { blockedBy } : {}),
    ...(blocks !== undefined ? { blocks } : {}),
  }
}

/** Pull a task-like object out of the assorted JSON envelope shapes the SDK uses. */
function extractTaskObject(parsed: unknown): unknown | undefined {
  if (!isObject(parsed)) return undefined
  // TaskCreateOutput / TaskGetOutput: `{ task: {...} | null }`.
  if ('task' in parsed) return parsed.task ?? undefined
  // Bare task object (`{ id, subject, ... }`).
  if ('id' in parsed || 'taskId' in parsed) return parsed
  return undefined
}

/** Pull a task array out of `[...]` / `{ tasks: [...] }`. */
function extractTaskArray(parsed: unknown): unknown[] | undefined {
  if (Array.isArray(parsed)) return parsed
  if (isObject(parsed) && Array.isArray(parsed.tasks)) return parsed.tasks
  return undefined
}

/**
 * Match a task id out of a TaskCreate confirmation line. Handles the documented
 * `"Created task 1: ..."` and variants (`"task #abc"`, `"id: t-3"`). The id token
 * starts alphanumeric so trailing punctuation / colons are not captured.
 */
function matchCreatedTaskId(text: string): string | undefined {
  const patterns = [
    // "Created task 1: ..." — the most specific, tried first.
    /created\s+task[:\s#]+([A-Za-z0-9][\w-]*)/i,
    // "...id: t-3" / "id = abc" — a colon/equals is required so a bare "id" word
    // in prose ("no id here") does NOT match.
    /\bid\s*[:=]\s*([A-Za-z0-9][\w-]*)/i,
    // "task #abc" — the loosest, tried last.
    /\btask[\s#]+([A-Za-z0-9][\w-]*)/i,
  ]
  for (const re of patterns) {
    const m = re.exec(text)
    if (m) return m[1]
  }
  return undefined
}

/**
 * Parse a TaskCreate result into the created {@link TaskData}. The id comes from
 * the SDK output (JSON `task.id` or the `"Created task N"` line); `subject` /
 * `description` are taken from the caller's create input (the SDK echoes only a
 * thin `{ id, subject }`, so the caller's values are authoritative). A new task is
 * always `pending`. When no id can be parsed the id degrades to `''` — the caller
 * detects the empty id and skips shadow-tracking rather than crashing.
 */
export function parseCreateResult(
  output: TaskToolOutput,
  subject: string,
  description?: string,
): TaskData {
  const parsed = output.isError ? undefined : tryParseJson(output.content)
  const fromJson = parsed !== undefined ? normalizeTaskObject(extractTaskObject(parsed)) : null
  const id = fromJson?.id ?? (output.isError ? undefined : matchCreatedTaskId(output.content)) ?? ''
  const resolvedDescription = description ?? fromJson?.description
  return {
    id,
    subject: subject || fromJson?.subject || '',
    status: 'pending',
    ...(resolvedDescription !== undefined ? { description: resolvedDescription } : {}),
  }
}

/**
 * Parse a TaskList result into a full task snapshot. JSON (`{ tasks: [...] }` /
 * `[...]`) first, then a line-based text fallback. An error output, an
 * unparseable body, or a genuinely empty list all yield `[]`; the caller decides
 * whether `[]` means "no tasks" (trust it) or "could not parse" (keep the shadow)
 * via {@link looksLikeEmptyList}.
 */
export function parseListResult(output: TaskToolOutput): TaskData[] {
  if (output.isError) return []
  const parsed = tryParseJson(output.content)
  const arr = parsed !== undefined ? extractTaskArray(parsed) : undefined
  if (arr) {
    return arr.map(normalizeTaskObject).filter((t): t is TaskData => t !== null)
  }
  return parseTextList(output.content)
}

/** Line-based TaskList text fallback: one task per parseable line, others skipped. */
function parseTextList(content: string): TaskData[] {
  const out: TaskData[] = []
  for (const line of content.split('\n')) {
    const task = parseTaskLine(line)
    if (task) out.push(task)
  }
  return out
}

/** A `[status]` / `(status)` tag, used to detect both the status and a task line. */
const STATUS_TAG_RE = /[[(]\s*(pending|in[_\s]?progress|completed|done|todo)\s*[\])]/i

/**
 * Parse one text line into a task. To avoid eating arbitrary prose, a line must
 * carry a STRUCTURAL task marker: a leading numeric index (`1.` / `2)`), a `task N`
 * keyword, or a `[status]` tag. Lacking all three ⇒ `null`. The remainder (minus
 * the marker and any status tag) is the subject; an empty subject ⇒ `null` too.
 */
function parseTaskLine(line: string): TaskData | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const statusMatch = STATUS_TAG_RE.exec(trimmed)
  const taskKwMatch = /^(?:[-*]\s*)?task[\s#]+([A-Za-z0-9][\w-]*)[.):\s]/i.exec(trimmed)
  const indexMatch = /^(?:[-*]\s*)?(\d+)[.)]\s+/.exec(trimmed)

  let id: string | undefined
  let consumed = 0
  if (taskKwMatch) {
    id = taskKwMatch[1]
    consumed = taskKwMatch[0].length
  } else if (indexMatch) {
    id = indexMatch[1]
    consumed = indexMatch[0].length
  } else if (statusMatch) {
    // A status tag alone qualifies the line; take its leading token as the id.
    const tok = /^(?:[-*]\s*)?([A-Za-z0-9][\w-]*)[.):\s]/.exec(trimmed)
    if (tok) {
      id = tok[1]
      consumed = tok[0].length
    }
  }
  if (id === undefined) return null

  const status = statusMatch ? normalizeStatus(statusMatch[1]) : 'pending'
  const subject = trimmed.slice(consumed).replace(STATUS_TAG_RE, '').trim()
  if (!subject) return null
  return { id, subject, status }
}

/**
 * Distinguish a genuinely empty TaskList from an unparseable one. An empty list
 * serializes recognisably (`[]`, `{"tasks":[]}`, or an explicit "no tasks"
 * line); anything else that parsed to `[]` is treated as a parse miss so the
 * caller keeps its shadow instead of wrongly clearing it.
 */
export function looksLikeEmptyList(output: TaskToolOutput): boolean {
  if (output.isError) return false
  const parsed = tryParseJson(output.content)
  if (Array.isArray(parsed)) return parsed.length === 0
  if (isObject(parsed) && Array.isArray(parsed.tasks)) return parsed.tasks.length === 0
  return /\bno\s+(?:tasks?|items?|results?)\b/i.test(output.content)
}

/**
 * Parse a TaskGet result into three outcomes the caller can act on distinctly:
 *  - {@link TaskData} — the task was found;
 *  - `null` — the task explicitly does NOT exist (`{ task: null }` or a
 *    "not found" line) ⇒ the caller drops it from the shadow;
 *  - `undefined` — the output was unparseable ⇒ the caller falls back to its shadow.
 */
export function parseGetResult(output: TaskToolOutput): TaskData | null | undefined {
  if (output.isError) return undefined
  const parsed = tryParseJson(output.content)
  if (parsed !== undefined) {
    // `{ task: null }` is an explicit not-found, distinct from a parse miss.
    if (isObject(parsed) && 'task' in parsed && parsed.task === null) return null
    const obj = extractTaskObject(parsed)
    if (obj !== undefined) return normalizeTaskObject(obj)
  }
  if (/\bnot\s+found\b|\bno\s+such\s+task\b/i.test(output.content)) return null
  return undefined
}

/** The outcome of a TaskUpdate, the bits the caller merges into its shadow. */
export interface UpdateOutcome {
  /** Whether the SDK confirmed the update succeeded. */
  success: boolean
  /** The new status, when the SDK reported a status change. */
  statusTo?: TaskStatus
}

/**
 * Parse a TaskUpdate result. The SDK output is a confirmation
 * (`{ success, updatedFields, statusChange? }`), not the full task, so the caller
 * merges the patch onto its shadow entry; this only extracts the success flag and
 * any reported status change. An error / unparseable output ⇒ `success: false`.
 */
export function parseUpdateResult(output: TaskToolOutput): UpdateOutcome {
  if (output.isError) return { success: false }
  const parsed = tryParseJson(output.content)
  if (isObject(parsed)) {
    const success = parsed.success === true || (!('success' in parsed) && !('error' in parsed))
    const change = parsed.statusChange
    const statusTo =
      isObject(change) && typeof change.to === 'string' ? normalizeStatus(change.to) : undefined
    return { success, ...(statusTo !== undefined ? { statusTo } : {}) }
  }
  // Text confirmation: "Updated task 1" / "Task 1 updated" ⇒ success.
  return { success: /\bupdated\b|\bsuccess(?:fully)?\b/i.test(output.content) }
}
