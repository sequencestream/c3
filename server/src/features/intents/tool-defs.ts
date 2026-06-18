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
import type { IntentStatus } from '@ccc/shared/protocol'
import { resolveWorkspaceRoot } from '../../state.js'
import { findIntents, getIntent, isStoreAvailable, upsertIntents } from './store.js'

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
    }),
  ),
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

export type SaveArgs = { intents: Parameters<typeof upsertIntents>[1] }
export type FindArgs = { keyword?: string; module?: string; status?: IntentStatus }
export type ViewArgs = { id: string }

// ---- Description strings (advertised in the system prompt) ----

export const saveDesc =
  '提交一批意图条目(新建或更新);落库前由用户在 c3 UI 确认。' +
  '每条不带 id 则新建;带 id 则原地更新该已存在意图(upsert)——' +
  'refine 已有意图时务必回填原 id 以更新原条目,避免新建重复项;' +
  'in_progress/done 的意图不可修改(整批失败),cancelled 更新后会重新激活为 todo。' +
  '当本批意图之间存在先后/依赖关系时,用每条的 dependsOnIndexes 字段(同批数组下标)' +
  '声明它依赖本批的哪些兄弟意图,落库时会解析为真实 id,使自动化编排按依赖顺序启动。'

export const findDesc =
  '检索本项目已有意图(只读)。用于发现关联项、避免重复、为 dependsOn 找到真实 id。' +
  '可按 keyword(模糊匹配标题/内容)、module、status 过滤(均可选,留空则返回全部);' +
  '返回精简列表(id、title、module、priority、status、dependsOn)。'

export const viewDesc = '按 id 查看本项目单条意图的完整详情(只读,含 content、dependsOn 等)。'

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
