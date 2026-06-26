/**
 * Shared definitions for the three intent tools, kept ONE source so the two MCP
 * surfaces that expose them never drift:
 *  - the in-process Claude SDK MCP server (`save-tool.ts`, `createSdkMcpServer`),
 *  - the localhost HTTP MCP route for driver-path vendors (`transport/intent-mcp`,
 *    codex; 2026-06-12-005).
 *
 * This module is framing-free: it owns the zod input shapes, the description
 * strings advertised in the system prompt, and the CORE logic (search the ledger,
 * view one item, persist a confirmed batch). The MCP framing — tool registration,
 * the save confirmation gate — lives in each surface. `runSaveConfirmed` is the
 * POST-confirmation persist: both surfaces gate `save_intents` BEFORE calling it
 * (Claude via `canUseTool`, the HTTP route via `permission_request`/`waitForDecision`).
 */
import { resolve } from 'node:path'
import { z } from 'zod'
import type { IntentPrStatus, IntentStatus } from '@ccc/shared/protocol'
import { resolveWorkspaceRoot } from '../../state.js'
import { publishIntentLifecycle } from './lifecycle-events.js'
import {
  findIntents,
  getIntent,
  insertIntents,
  isStoreAvailable,
  setPrStatus,
  updateStatus,
  upsertIntents,
} from './store.js'

const INTENT_STATUSES = [
  'draft',
  'todo',
  'in_progress',
  'done',
  'cancelled',
] as const satisfies readonly IntentStatus[]

/** An MCP tool result. Identical shape across the Claude SDK and the MCP SDK. */
export interface IntentToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

const text = (s: string): IntentToolResult['content'] => [{ type: 'text' as const, text: s }]

// ---- Zod input shapes (raw shapes; both `tool()` and `registerTool` accept them) ----

// Shared field shapes for one proposed intent. `save_intents`(upsert,带可选 id)与
// schedule 专用的 `save_intent_directly`(create-only,无 id)都复用这一组字段,
// 避免两处 schema 漂移。
const proposedIntentShape = {
  title: z.string(),
  shortEnTitle: z
    .string()
    .describe(
      '必填:简短英文 ASCII 短标题(≤64 字符),仅用 a-z/0-9/空格/连字符等 ASCII 字符,' +
        '作为派生 Git 分支名 / worktree 目录名的稳定来源(勿用中文/非 ASCII);' +
        '应是对 title 的简明英文概括。落库时超过 128 字符会被截断。',
    ),
  content: z.string(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  module: z.string().optional().describe('所属模块名(按标题/内容推断,可留空)'),
  dependsOn: z
    .array(z.string())
    .optional()
    .describe('依赖的“已存在意图”的 id(引用本次提交之前就已落库的意图)'),
  dependsOnIndexes: z
    .array(z.number().int())
    .optional()
    .describe(
      '本批内依赖:用同批 intents 数组的下标(0 起)引用兄弟意图;' +
        '有先后关系时务必填写(被依赖项应排在依赖项之前提交)。' +
        '与 dependsOn 并用互补;下标越界/自引用/批内成环会导致整批保存失败。',
    ),
}

export const saveSchema = {
  intents: z.array(
    z.object({
      id: z
        .string()
        .optional()
        .describe(
          '可选:要更新的“已存在意图”的 id(upsert)。' +
            '带 id 则原地更新该意图的 title/content/priority/module/dependsOn,而非新建;' +
            'refine 已有意图时必须回填原 id 以更新原条目,避免重复。' +
            '目标须可改:draft/todo 保持状态、cancelled 自动重新激活为 todo;' +
            'in_progress/done 不可修改,会导致整批保存失败。留空则新建一条意图。',
        ),
      intentSessionId: z
        .string()
        .optional()
        .describe(
          '可选:把这条意图回链到产出它的本次沟通会话(便于日后从意图跳回当时的讨论上下文)。' +
            '仅当本批只保存 1 条意图时才填写,值用系统在提示中给出的当前会话 id;' +
            '批量保存多条时一律不填——填了也会被忽略,不会写入任何一行。',
        ),
      ...proposedIntentShape,
    }),
  ),
}

// create-only:不含 id,该工具只新建草稿、永不 upsert(去重由调用方先 find_intents)。
export const saveIntentDirectlySchema = {
  intents: z.array(z.object(proposedIntentShape)),
}

export const findSchema = {
  keyword: z.string().optional().describe('关键字,模糊匹配 title/content(可留空)'),
  module: z.string().optional().describe('按所属模块名精确过滤(可留空)'),
  status: z
    .enum(INTENT_STATUSES)
    .optional()
    .describe('按状态过滤:draft/todo/in_progress/done/cancelled(可留空)'),
}

export const viewSchema = { id: z.string().describe('意图 id') }

export const saveIntentPrInfoSchema = {
  intentId: z.string().describe('要回填 PR 状态的本项目意图 id'),
  prStatus: z.enum(['reviewing', 'rejected', 'failed', 'merged', 'closed']),
  done: z.boolean().optional().describe('仅 PR 已合并时传 true，将意图标记为 done'),
}

export type SaveArgs = { intents: Parameters<typeof upsertIntents>[1] }
// create-only:每条都是新建草稿,不携带 id(insertIntents 总是 mint 新 id)。
export type SaveIntentDirectlyArgs = {
  intents: Array<Omit<Parameters<typeof insertIntents>[1][number], 'id'>>
}
export type FindArgs = { keyword?: string; module?: string; status?: IntentStatus }
export type ViewArgs = { id: string }
export type SaveIntentPrInfoArgs = { intentId: string; prStatus: IntentPrStatus; done?: boolean }

// ---- Description strings (advertised in the system prompt) ----

export const saveDesc =
  '提交一批意图条目(新建或更新);落库前由用户在 c3 UI 确认。' +
  '每条不带 id 则新建;带 id 则原地更新该已存在意图(upsert)——' +
  'refine 已有意图时务必回填原 id 以更新原条目,避免新建重复项;' +
  'in_progress/done 的意图不可修改(整批失败),cancelled 更新后会重新激活为 todo。' +
  '当本批意图之间存在先后/依赖关系时,用每条的 dependsOnIndexes 字段(同批数组下标)' +
  '声明它依赖本批的哪些兄弟意图,落库时会解析为真实 id,使自动化编排按依赖顺序启动。' +
  '当本轮只产出 1 条意图、且它来自与用户的沟通时,可用 intentSessionId 把它回链到本次会话(批量多条时不填)。'

export const findDesc =
  '检索本项目已有意图(只读)。用于发现关联项、避免重复、为 dependsOn 找到真实 id。' +
  '可按 keyword(模糊匹配标题/内容)、module、status 过滤(均可选,留空则返回全部);' +
  '返回精简列表(id、title、module、priority、status、dependsOn)。'

export const saveIntentDirectlyDesc =
  '直接落库一批“新建”意图为草稿(draft):仅供无人值守的定时任务使用,不弹用户确认框、直接写库。' +
  '人工确认门改由意图列表对 draft 的评审/激活承担,而非保存弹框。' +
  '仅新建、不更新已有意图(create-only,不接受 id);落库前务必先用 find_intents 去重,' +
  '已被现有意图覆盖的不要重复创建。本批意图之间的先后关系用每条的 dependsOnIndexes(同批数组下标)声明。'

export const viewDesc = '按 id 查看本项目单条意图的完整详情(只读,含 content、dependsOn 等)。'
export const saveIntentPrInfoDesc =
  '回填本项目一条意图的 PR 状态。仅用于 PR 对账：可写入 reviewing/rejected/failed/merged/closed；' +
  '当 PR 已合并时传 done=true 将意图标记为 done。'

// ---- Core logic (framing-free; bound to ONE project via `workspacePath`) ----

/** Search the project ledger (read-only). */
export function runFind(workspacePath: string, args: FindArgs): IntentToolResult {
  if (!isStoreAvailable()) return { content: text('意图库不可用,无法检索。'), isError: true }
  const rows = findIntents(workspacePath, {
    keyword: args.keyword,
    module: args.module,
    status: args.status,
  })
  const slim = rows.map((r) => ({
    id: r.id,
    title: r.title,
    module: r.module,
    priority: r.priority,
    status: r.status,
    dependsOn: r.dependsOn,
  }))
  return {
    content: text(
      slim.length === 0
        ? '未找到匹配的意图。'
        : `找到 ${slim.length} 条意图:\n${JSON.stringify(slim, null, 2)}`,
    ),
  }
}

/** View one item by id, bound to the closure project (no cross-project reads). */
export function runView(workspacePath: string, args: ViewArgs): IntentToolResult {
  if (!isStoreAvailable()) return { content: text('意图库不可用,无法查看。'), isError: true }
  const req = getIntent(args.id)
  if (!req || resolveWorkspaceRoot(req.workspaceId) !== resolve(workspacePath)) {
    return { content: text(`未找到 id 为 ${args.id} 的意图(本项目)。`) }
  }
  return { content: text(JSON.stringify(req, null, 2)) }
}

/**
 * Persist a CONFIRMED batch (the caller already passed the save gate). Bound to
 * `workspacePath`; `onSaved` lets the caller broadcast the refreshed list.
 */
export function runSaveConfirmed(
  workspacePath: string,
  args: SaveArgs,
  onSaved: (workspacePath: string) => void,
): IntentToolResult {
  if (!isStoreAvailable()) return { content: text('意图库不可用,未保存。'), isError: true }
  try {
    const updated = args.intents.filter((it) => it.id !== undefined).length
    const created = args.intents.length - updated
    const saved = upsertIntents(workspacePath, args.intents)
    for (const [index, input] of args.intents.entries()) {
      if (input.id === undefined && saved[index]) {
        publishIntentLifecycle(workspacePath, saved[index], 'created')
      }
    }
    onSaved(workspacePath)
    const summary =
      updated > 0
        ? `已保存 ${saved.length} 条意图(新建 ${created}、更新 ${updated})`
        : `已保存 ${saved.length} 条意图`
    return { content: text(`${summary}:${saved.map((r) => r.title).join('、')}`) }
  } catch (err) {
    return { content: text(`保存失败:${String(err)}`), isError: true }
  }
}

/**
 * Persist a batch of NEW intents as `draft`, bypassing the save confirmation gate.
 * Used only by the unattended schedule MCP profile: a schedule has no browser
 * decision queue, so instead of gating the save it lands every item as a `draft`
 * and the human confirms later by reviewing/activating the draft in the intent
 * list. Create-only — never updates an existing intent (de-dup is the caller's
 * job via `find_intents`); `onSaved` lets the caller broadcast the refreshed list.
 */
export function runSaveIntentDirectly(
  workspacePath: string,
  args: SaveIntentDirectlyArgs,
  onSaved: (workspacePath: string) => void,
): IntentToolResult {
  if (!isStoreAvailable()) return { content: text('意图库不可用,未保存。'), isError: true }
  try {
    const saved = insertIntents(workspacePath, args.intents, 'draft')
    for (const intent of saved) {
      publishIntentLifecycle(workspacePath, intent, 'created')
    }
    onSaved(workspacePath)
    return {
      content: text(
        `已落库 ${saved.length} 条草稿意图(待人工确认):${saved.map((r) => r.title).join('、')}`,
      ),
    }
  } catch (err) {
    return { content: text(`保存失败:${String(err)}`), isError: true }
  }
}

/** Persist PR reconciliation information for one workspace-bound intent. */
export function runSaveIntentPrInfo(
  workspacePath: string,
  args: SaveIntentPrInfoArgs,
  onSaved: (workspacePath: string) => void,
): IntentToolResult {
  if (!isStoreAvailable()) return { content: text('意图库不可用,未保存。'), isError: true }
  const intent = getIntent(args.intentId)
  if (!intent || resolveWorkspaceRoot(intent.workspaceId) !== resolve(workspacePath)) {
    return { content: text(`未找到 id 为 ${args.intentId} 的意图(本项目)。`), isError: true }
  }
  try {
    setPrStatus(intent.id, args.prStatus)
    if (args.done === true) updateStatus(intent.id, 'done')
    onSaved(workspacePath)
    return {
      content: text(
        `已回填意图 ${intent.id} 的 PR 状态为 ${args.prStatus}${args.done ? '，并标记为完成' : ''}。`,
      ),
    }
  } catch (err) {
    return { content: text(`保存失败:${String(err)}`), isError: true }
  }
}
