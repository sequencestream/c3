/**
 * Shared definitions for the four discussion tools exposed to unattended
 * automation runs, kept ONE source (mirrors `features/intents/tool-defs.ts`) so
 * the MCP surface that advertises them never drifts from the core logic.
 *
 * This module is framing-free: it owns the zod input shapes, the description
 * strings advertised in the system prompt, and the CORE logic (list the
 * project's discussions, view one, start a draft, continue/resume). It imports
 * the discussion store directly (a plain SQLite read/write, easy to exercise in
 * a unit test with a temp db) but takes the RUNTIME pieces —
 * `hasDiscussionRun`, `startDiscussionRun`, and the broadcast callbacks — as
 * INJECTED deps. The starters live in `wiring/` (composition root), so injecting
 * them keeps this module from reverse-depending on wiring/automation and lets the
 * unit tests drive the run-control branch with a spy.
 *
 * Recovery is deliberately state-free: there is no new `error`/`stuck`
 * `DiscussionStatus`. An `in_progress` discussion with no live run (the
 * post-error / post-restart dangling combination) is the recoverable case —
 * `continue_discussion` re-invokes `startDiscussionRun` on the latest record so
 * the orchestrator resumes from the persisted transcript/agenda, without
 * appending a message or resetting any state.
 */
import { resolve } from 'node:path'
import { z } from 'zod'
import type { Discussion, DiscussionMessage, DiscussionStatus } from '@ccc/shared/protocol'
import { resolveWorkspaceRoot } from '../../state.js'
import {
  appendMessage,
  getDiscussion,
  isStoreAvailable,
  listDiscussions,
  listMessages,
  updateDiscussionStatus,
} from './store.js'

const DISCUSSION_STATUSES = [
  'draft',
  'in_progress',
  'completed',
  'cancelled',
] as const satisfies readonly DiscussionStatus[]

/** An MCP tool result. Identical shape across the Claude SDK and the MCP SDK. */
export interface DiscussionToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

const text = (s: string): DiscussionToolResult['content'] => [{ type: 'text' as const, text: s }]
const ok = (s: string): DiscussionToolResult => ({ content: text(s) })
const fail = (s: string): DiscussionToolResult => ({ content: text(s), isError: true })

// ---- Injected runtime deps (live run-control + broadcast; the store is imported) ----

/** The run-control pieces every start/continue branch needs to gate re-entry. */
export interface DiscussionRunStarter {
  /** Whether a discussion currently has a live orchestration run (re-entry guard). */
  hasDiscussionRun: (id: string) => boolean
  /** Start (or resume) a background orchestration run for a discussion. */
  startDiscussionRun: (discussion: Discussion) => void
}

/** `continue_discussion` additionally broadcasts the appended message + refreshed list. */
export interface ContinueDiscussionDeps extends DiscussionRunStarter {
  broadcastDiscussionMessage: (discussionId: string, message: DiscussionMessage) => void
  broadcastDiscussions: (workspacePath: string) => void
}

// ---- Zod input shapes (raw shapes; both `tool()` and `registerTool` accept them) ----

export const findDiscussionsSchema = {
  status: z
    .enum(DISCUSSION_STATUSES)
    .optional()
    .describe('按状态过滤:draft/in_progress/completed/cancelled(可留空则返回全部)'),
}

export const viewDiscussionSchema = { discussionId: z.string().describe('讨论 id') }

export const startDiscussionSchema = { discussionId: z.string().describe('要启动的 draft 讨论 id') }

export const continueDiscussionSchema = {
  discussionId: z.string().describe('要继续或恢复的讨论 id'),
  text: z
    .string()
    .optional()
    .describe(
      '追问文本:仅当讨论已 completed、要开启新一轮时必填(非空);' +
        '恢复一个 in_progress 且无存活运行的悬挂讨论时不要填写——恢复不追加发言。',
    ),
}

export type FindDiscussionsArgs = { status?: DiscussionStatus }
export type ViewDiscussionArgs = { discussionId: string }
export type StartDiscussionArgs = { discussionId: string }
export type ContinueDiscussionArgs = { discussionId: string; text?: string }

// ---- Description strings (advertised in the system prompt) ----

export const findDiscussionsDesc =
  '检索本项目已有讨论(只读)。用于感知当前项目里有哪些讨论、该继续/恢复哪一个,避免重复发起。' +
  '可按 status 过滤(可选,留空返回全部);返回精简列表(id、title、type、status、agendaIndex、' +
  'agendaCount、hasConclusion、updatedAt),不含完整消息体。'

export const viewDiscussionDesc =
  '按 id 查看本项目单条讨论的完整详情(只读):含讨论记录本体与按 seq 排序的消息列表。' +
  '仅能查看归属当前 workspace 的讨论;跨 workspace 或不存在返回错误。'

export const startDiscussionDesc =
  '对一个已存在的 draft 讨论触发启动(复用现有 orchestrator,不新建讨论、不跑 research 阶段)。' +
  '仅当目标是 draft 且当前无存活运行时成功;跨 workspace、非 draft、已有存活运行或库不可用返回错误。'

export const continueDiscussionDesc =
  '继续或恢复本项目一个已存在的讨论(双语义,均要求当前无存活运行):' +
  'a) 讨论已 completed 时,追加一条 human 追问(text 必填非空)并开启新一轮;' +
  'b) 讨论为 in_progress 但无存活运行(上一轮出错/服务重启留下的悬挂态)时,视为「恢复」——' +
  '不追加发言,直接让 orchestrator 从持久化的 transcript/stage/agenda 位置继续,而非从头开始。' +
  '其余状态(draft、cancelled、或已有存活运行)返回错误。'

// ---- Core logic (framing-free; bound to ONE project via `workspacePath`) ----

/** List the project's discussions (read-only), optionally status-filtered. */
export function runFindDiscussions(
  workspacePath: string,
  args: FindDiscussionsArgs,
): DiscussionToolResult {
  if (!isStoreAvailable()) return fail('讨论库不可用,无法检索。')
  const rows = listDiscussions(workspacePath, args.status)
  const slim = rows.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    status: r.status,
    agendaIndex: r.agendaIndex,
    agendaCount: r.agenda.length,
    hasConclusion: !!r.conclusion,
    updatedAt: r.updatedAt,
  }))
  return ok(
    slim.length === 0
      ? '未找到匹配的讨论。'
      : `找到 ${slim.length} 条讨论:\n${JSON.stringify(slim, null, 2)}`,
  )
}

/** Whether a discussion belongs to the closure-bound workspace (id reads are global). */
function belongsToWorkspace(discussion: Discussion, workspacePath: string): boolean {
  return resolveWorkspaceRoot(discussion.workspaceId) === resolve(workspacePath)
}

/**
 * View one discussion (detail + messages), bound to the closure project. Rejects
 * (isError) on not-found or cross-workspace to avoid global id reads leaking
 * another workspace's discussion.
 */
export function runViewDiscussion(
  workspacePath: string,
  args: ViewDiscussionArgs,
): DiscussionToolResult {
  if (!isStoreAvailable()) return fail('讨论库不可用,无法查看。')
  const discussion = getDiscussion(args.discussionId)
  if (!discussion || !belongsToWorkspace(discussion, workspacePath)) {
    return fail(`未找到 id 为 ${args.discussionId} 的讨论(本项目)。`)
  }
  return ok(JSON.stringify({ discussion, messages: listMessages(discussion.id) }, null, 2))
}

/**
 * Start a pre-existing `draft` discussion via the injected `startDiscussionRun`.
 * Only a `draft` with no live run starts; not-found/cross-workspace, non-draft,
 * or an already-live run return isError (never a silent success).
 */
export function runStartDiscussion(
  workspacePath: string,
  args: StartDiscussionArgs,
  deps: DiscussionRunStarter,
): DiscussionToolResult {
  if (!isStoreAvailable()) return fail('讨论库不可用,无法启动。')
  const discussion = getDiscussion(args.discussionId)
  if (!discussion || !belongsToWorkspace(discussion, workspacePath)) {
    return fail(`未找到 id 为 ${args.discussionId} 的讨论(本项目)。`)
  }
  if (deps.hasDiscussionRun(discussion.id)) {
    return fail(`讨论 ${discussion.id} 已有存活运行,无法重复启动。`)
  }
  if (discussion.status !== 'draft') {
    return fail(`只能启动 draft 讨论;讨论 ${discussion.id} 当前状态为 ${discussion.status}。`)
  }
  deps.startDiscussionRun(discussion)
  return ok(`已启动 draft 讨论 ${discussion.id}。`)
}

/**
 * Continue or recover a pre-existing discussion. Both semantics require no live
 * run first:
 *  - `completed` → append a non-empty human follow-up, flip to `in_progress`,
 *    broadcast, and start a fresh round (matches the WebSocket `continue_discussion`).
 *  - `in_progress` with no live run → RECOVER: don't append or reset anything;
 *    re-invoke `startDiscussionRun` so the orchestrator resumes from the persisted
 *    transcript/agenda/agent last_seq.
 * draft / cancelled / already-live-run / completed-but-empty-text return isError.
 */
export function runContinueDiscussion(
  workspacePath: string,
  args: ContinueDiscussionArgs,
  deps: ContinueDiscussionDeps,
): DiscussionToolResult {
  if (!isStoreAvailable()) return fail('讨论库不可用,无法继续。')
  const discussion = getDiscussion(args.discussionId)
  if (!discussion || !belongsToWorkspace(discussion, workspacePath)) {
    return fail(`未找到 id 为 ${args.discussionId} 的讨论(本项目)。`)
  }
  if (deps.hasDiscussionRun(discussion.id)) {
    return fail(`讨论 ${discussion.id} 已有存活运行,无法重复启动。`)
  }
  if (discussion.status === 'completed') {
    const followUp = (args.text ?? '').trim()
    if (!followUp) return fail('对已结束的讨论开启新一轮时,text 追问不能为空。')
    const message = appendMessage({
      discussionId: discussion.id,
      speakerKind: 'human',
      speakerName: 'Human',
      content: followUp,
    })
    deps.broadcastDiscussionMessage(discussion.id, message)
    updateDiscussionStatus(discussion.id, 'in_progress')
    deps.broadcastDiscussions(resolveWorkspaceRoot(discussion.workspaceId)!)
    deps.startDiscussionRun({ ...discussion, status: 'in_progress' })
    return ok(`已追加追问并开启新一轮讨论 ${discussion.id}。`)
  }
  if (discussion.status === 'in_progress') {
    // 悬挂态恢复:in_progress + 无存活 run。不追加消息、不重置 agenda/conclusion/
    // agent session 映射,直接以最新记录重启 orchestrator,从持久化位置继续。
    deps.startDiscussionRun(discussion)
    return ok(`已恢复讨论 ${discussion.id},从当前 stage/agenda 继续。`)
  }
  return fail(`讨论 ${discussion.id} 当前状态为 ${discussion.status},无法继续或恢复。`)
}
