/**
 * Shared, framing-free definitions for the two intent WorkNote tools, kept ONE
 * source so the surfaces that expose them never drift:
 *  - the work-session HTTP MCP route (`transport/event-mcp`, injected tool table),
 *  - the unattended-automation c3 MCP tool set (`../automations/c3-tools.ts`).
 *
 * This module owns the zod input shapes, the descriptions advertised in the system
 * prompt, and the CORE logic (append one note / list notes). The MCP framing — tool
 * registration + the per-run binding closure that supplies `workspacePath` — lives
 * in each surface. The workspace is server-derived: a caller cannot name one, which
 * is what makes "workspace A cannot read workspace B's notes" structural. The note
 * `sessionId` is model-supplied and verbatim — never auto-filled from a run or
 * execution id, so an automation execution id is never misrepresented as a session.
 */
import { resolve } from 'node:path'
import { z } from 'zod'
import { INTENT_WORKNOTE_KINDS } from '@ccc/shared/protocol'
import type { IntentWorknoteKind } from '@ccc/shared/protocol'
import { resolveWorkspaceRoot } from '../../state.js'
import { appendIntentWorknote, getIntent, isStoreAvailable, listIntentWorknotes } from './store.js'

/** An MCP tool result. Identical shape across the Claude SDK and the MCP SDK. */
export interface WorknoteToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

const text = (s: string): WorknoteToolResult['content'] => [{ type: 'text' as const, text: s }]
const fail = (reason: string): WorknoteToolResult => ({ content: text(reason), isError: true })

// ---- Zod input shapes (raw shapes; both `tool()` and `registerTool` accept them) ----

export const appendWorknoteSchema = {
  intentId: z.string().describe('要追加 WorkNote 的意图 id'),
  kind: z
    .enum(INTENT_WORKNOTE_KINDS)
    .describe('WorkNote 类型:work=开发总结、review=评审发现的问题、fix=修复改了什么'),
  note: z.string().describe('自由文本正文,原样保存(含换行与首尾空白),须含非空白字符'),
  sessionId: z.string().optional().describe('可选:产生该 note 的会话 id(未知/无则省略)'),
}

export const listWorknotesSchema = {
  intentId: z.string().describe('要读取 WorkNote 历史的意图 id'),
  kind: z.enum(INTENT_WORKNOTE_KINDS).optional().describe('可选:按类型过滤(与追加同一封闭枚举)'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('可选:返回条数上限,1–200 的整数,省略为 50'),
}

export type AppendWorknoteArgs = {
  intentId: string
  kind: IntentWorknoteKind
  note: string
  sessionId?: string
}

export type ListWorknotesArgs = {
  intentId: string
  kind?: IntentWorknoteKind
  limit?: number
}

// ---- Description strings (advertised in the system prompt) ----

export const appendWorknoteDesc =
  '向一条意图追加一条 WorkNote 历史(work 总结 / review 问题 / fix 修复说明),调用即落库、只增不改。' +
  'kind 三选一:work=上一轮开发做了什么、review=评审发现的问题、fix=修复改了什么;' +
  'note 为自由文本正文(含换行与首尾空白,原样保存,须含非空白字符);' +
  'sessionId 可选,填产生该 note 的会话 id(未知/无则省略)。' +
  '不存在或属于其他项目的 intentId 会返回「未找到意图(本项目)」。' +
  '本接口不是幂等的:提交成功但响应丢失时重试会形成重复正文,服务端不自动重试。'

export const listWorknotesDesc =
  '按 intentId 倒序读取某意图的 WorkNote 历史(work/review/fix),供 Review/Fix Agent 读取前序上下文。' +
  'kind 可选过滤(与追加同一封闭枚举),limit 可选 1–200(省略为 50)。' +
  '返回 JSON 数组(无匹配为空数组);不含聚合统计、分页游标,正文不截断。' +
  '大正文建议按 kind + 较小 limit 读取。' +
  '不存在或属于其他项目的 intentId 会返回「未找到意图(本项目)」。'

// ---- Core logic (framing-free; bound to ONE project via `workspacePath`) ----

/**
 * The project-scoped existence + ownership guard both tools share: the intent must
 * exist and its workspace identity must resolve to the bound workspace, so an id
 * from another project reads as "not found" and never leaks its records.
 */
function findOwnedIntent(workspacePath: string, intentId: string) {
  const req = getIntent(intentId)
  if (!req || resolveWorkspaceRoot(req.workspaceName) !== resolve(workspacePath)) return null
  return req
}

/** Append one note to a project intent; returns the stored record as JSON text. */
export function runAppendWorknote(
  workspacePath: string,
  args: AppendWorknoteArgs,
): WorknoteToolResult {
  if (!isStoreAvailable()) return fail('意图库不可用,无法追加 WorkNote。')
  if (!findOwnedIntent(workspacePath, args.intentId)) {
    return { content: text(`未找到 id 为 ${args.intentId} 的意图(本项目)。`) }
  }
  try {
    const saved = appendIntentWorknote(args.intentId, args.kind, args.note, args.sessionId)
    return { content: text(JSON.stringify(saved)) }
  } catch (err) {
    return fail(`追加 WorkNote 失败:${String(err)}`)
  }
}

/** List a project intent's notes newest-first; returns an array as JSON text. */
export function runListWorknotes(
  workspacePath: string,
  args: ListWorknotesArgs,
): WorknoteToolResult {
  if (!isStoreAvailable()) return fail('意图库不可用,无法读取 WorkNote。')
  if (!findOwnedIntent(workspacePath, args.intentId)) {
    return { content: text(`未找到 id 为 ${args.intentId} 的意图(本项目)。`) }
  }
  try {
    const rows = listIntentWorknotes(args.intentId, args.kind, args.limit)
    return { content: text(JSON.stringify(rows)) }
  } catch (err) {
    return fail(`读取 WorkNote 失败:${String(err)}`)
  }
}
