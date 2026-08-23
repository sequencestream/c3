/**
 * Shared definitions for the three intent tools, kept ONE source so every surface
 * that exposes them never drifts. Every vendor reaches these tools over
 * the SAME loopback HTTP MCP route (`transport/intent-mcp`); there is no in-process
 * SDK MCP server for c3 tools anymore.
 *
 * This module is framing-free: it owns the zod input shapes, the description
 * strings advertised in the system prompt, and the CORE logic (search the ledger,
 * view one item, persist a confirmed batch). The MCP framing — tool registration,
 * the per-run binding — lives in the route + the comm-save handler.
 * `runSaveConfirmed` is the POST-confirmation persist: the comm agent obtains the
 * user's textual confirmation in the conversation BEFORE it calls `save_intents`.
 */
import { resolve } from 'node:path'
import { z } from 'zod'
import type { IntentPrStatus, IntentStatus } from '@ccc/shared/protocol'
import { activeIntentPrs, pickPrimaryIntentPr } from '@ccc/shared'
import { resolveWorkspaceRoot } from '../../state.js'
import { publishIntentLifecycle } from './lifecycle-events.js'
import {
  findIntents,
  getIntent,
  insertIntents,
  isStoreAvailable,
  updateStatus,
  upsertIntentPr,
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
// 直接写路径的 `save_intent_directly`(create-only,无 id)都复用这一组字段,
// 避免两处 schema 漂移。
export const intentContentGuidance =
  '请用自由文本覆盖五维内容:Why(问题、证据、不处理的影响);What(可观察目标);' +
  'Trade-offs / Non-goals(取舍、边界、不做什么);When(仅有时限、阶段或依赖窗口时填写,否则可省略);' +
  'Acceptance(可验证完成条件)。这是软性写作指引,缺少维度、使用不同 Markdown 或空内容不会因此被拒绝。'

const proposedIntentShape = {
  title: z.string(),
  shortEnTitle: z
    .string()
    .describe(
      '必填:简短英文 ASCII 短标题(≤64 字符),仅用 a-z/0-9/空格/连字符等 ASCII 字符,' +
        '作为派生 Git 分支名 / worktree 目录名的稳定来源(勿用中文/非 ASCII);' +
        '应是对 title 的简明英文概括。落库时超过 128 字符会被截断。',
    ),
  content: z.string().describe(intentContentGuidance),
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
  specMode: z
    .enum(['sdd', 'fast'])
    .nullish()
    .describe(
      '可选:每意图级 spec 模式。省略 = 不改动/新建意图按工作区继承(当前值);' +
        '显式传 null = 清除覆盖,恢复继承工作区;' +
        "'sdd' = 固定规格先行(先在 spec 获批后才能开发);" +
        "'fast' = 固定规格延后(小改动可先产出 diff,落定后系统反向生成待批准规格)。" +
        '仅在用户明确要求该意图走 fast/恢复 sdd 时才设置;普通编辑不要携带此字段。',
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
            'in_progress/done 不可修改,会导致整批保存失败。留空则新建一条意图。' +
            '注意:更新使 title/content 发生实际变化时,该意图原有的 spec 批准会被自动撤销,需重新评审批准后才能进入开发。',
        ),
      intentSessionId: z
        .string()
        .optional()
        .describe(
          '可选:把这条意图回链到产出它的本次沟通会话(便于日后从意图跳回当时的讨论上下文)。' +
            '仅当本批只保存 1 条意图时才填写,值用系统在提示中给出的当前会话 id;' +
            '批量保存多条时一律不填——填了也会被忽略,不会写入任何一行。',
        ),
      status: z
        .literal('todo')
        .optional()
        .describe(
          "可选:本次保存后的目标状态,只允许 'todo'。新建时省略仍为 todo;" +
            'upsert 时可显式执行 draft→todo、cancelled→todo 或 todo→todo。' +
            '省略时 draft/todo 保持、cancelled 沿用既有规则恢复为 todo,其他可修改状态保持。',
        ),
      automate: z
        .boolean()
        .optional()
        .describe(
          '可选:是否允许自动化队列拾取。新建时省略为 false,upsert 时省略保留原值;' +
            '显式 true 仅在本次保存后的状态为 todo 时允许,且不会绕过规格、依赖或工作区自动化总闸。',
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
  intentId: z.string().describe('要回填 PR 状态的本项目意图 id(该意图必须已有 PR)'),
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

export const saveCoreDesc =
  '提交一批意图条目(新建或更新),调用即落库。' +
  '每条不带 id 则新建;带 id 则原地更新该已存在意图(upsert)——' +
  'refine 已有意图时务必回填原 id 以更新原条目,避免新建重复项;' +
  'in_progress/done 的意图不可修改(整批失败),cancelled 更新后会重新激活为 todo;' +
  "每条可用 status='todo' 显式激活 draft/cancelled,并用 automate 设置自动执行资格;" +
  'automate=true 仅允许最终状态为 todo,任一非法状态或组合会使整批原子失败。' +
  '更新使已有意图的 title/content 实际改变时,其原有 spec 批准会被撤销(需重新评审批准才能开发)。' +
  '当本批意图之间存在先后/依赖关系时,用每条的 dependsOnIndexes 字段(同批数组下标)' +
  '声明它依赖本批的哪些兄弟意图,落库时会解析为真实 id,使自动化编排按依赖顺序启动。' +
  intentContentGuidance

export const saveDesc =
  saveCoreDesc +
  '当本轮只产出 1 条意图、且它来自与用户的沟通时,可用 intentSessionId 把它回链到本次会话(批量多条时不填)。' +
  '仅在你已把本轮全部意图及有效 status/automate 完整列出、明确说明本次会改变的值,' +
  '且用户在对话中明确确认后才调用;没有任何确认弹框可以撤回。'

export const findDesc =
  '检索本项目已有意图(只读)。用于发现关联项、避免重复、为 dependsOn 找到真实 id。' +
  '可按 keyword(模糊匹配标题/内容)、module、status 过滤(均可选,留空则返回全部);' +
  '返回精简列表(id、title、module、priority、status、dependsOn)。'

export const saveIntentDirectlyDesc =
  '直接落库一批“新建”意图为草稿(draft):仅供管理员明确授权的直接写路径使用,不等待对话确认,直接写库。' +
  '人工确认门由意图列表对 draft 的评审/激活承担。' +
  '仅新建、不更新已有意图(create-only,不接受 id);落库前务必先用 find_intents 去重,' +
  '已被现有意图覆盖的不要重复创建。本批意图之间的先后关系用每条的 dependsOnIndexes(同批数组下标)声明。' +
  '本工具不接受 status/automate,始终新建 draft + automate=false。' +
  intentContentGuidance

export const viewDesc = '按 id 查看本项目单条意图的完整详情(只读,含 content、dependsOn 等)。'
export const saveIntentPrInfoDesc =
  '【已废弃,勿再使用】回填本项目一条意图**既有** PR 的状态。' +
  '一个意图可能同时持有多条 PR(每个交付一条),仅凭 intentId 无法确定要回填哪一条,' +
  '因此本工具已从所有 allowlist 移除、不再可授权,仅为过渡期存量调用保留。' +
  '替代路径:用只读的 find_intents / view_intent 读取 PR 现状;' +
  '需要把被拒/失败/关闭的 PR 复位为 reviewing 时,发布 pr:update 事件并携带 ' +
  'association.deliveryId 或 pr.number 精确定位该 PR;终态(merged/closed)由 c3 自己' +
  '从 forge 事实落库(「同步 PR 状态」),不再由模型回填。' +
  '过渡期行为:可写入 reviewing/rejected/failed/merged/closed;PR 已合并时传 done=true 将意图标记为 done;' +
  '只更新已存在的 PR 记录,意图尚无 PR 时拒绝;意图有多条活跃 PR 时**明确报错并列出各 PR 编号**,绝不猜一条。'

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
  if (!req || resolveWorkspaceRoot(req.workspaceName) !== resolve(workspacePath)) {
    return { content: text(`未找到 id 为 ${args.id} 的意图(本项目)。`) }
  }
  return { content: text(JSON.stringify(req, null, 2)) }
}

/**
 * Persist a CONFIRMED batch (the user already confirmed it in the conversation).
 * Bound to `workspacePath`; `onSaved` lets the caller broadcast the refreshed list.
 * `actor` attributes the `intent_logs.actor`; absent / null lets `upsertIntents`
 * fall back to `'system'` — which is what the comm path does, since a chat
 * confirmation carries no separately authenticated subject.
 */
export function runSaveConfirmed(
  workspacePath: string,
  args: SaveArgs,
  onSaved: (workspacePath: string) => void,
  actor?: string | null,
  responsibleSubjectForNew?: string | null,
): IntentToolResult {
  if (!isStoreAvailable()) return { content: text('意图库不可用,未保存。'), isError: true }
  try {
    const updated = args.intents.filter((it) => it.id !== undefined).length
    const created = args.intents.length - updated
    const saved = upsertIntents(workspacePath, args.intents, actor, responsibleSubjectForNew)
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
 * Persist a batch of NEW intents as `draft`. Direct-write MCP profiles use this
 * when their administrator-granted capability intentionally does not wait for an
 * interactive confirmation. The human confirms later by reviewing/activating the
 * draft in the intent list. Create-only — never updates an existing intent
 * (de-dup is the caller's job via `find_intents`); `onSaved` lets the caller
 * broadcast the refreshed list.
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

/**
 * Reconcile the status of an intent's EXISTING PR.
 *
 * DEPRECATED — and removed from every allowlist (the automation tool set, the
 * built-in templates, and the externally-grantable catalog), so no NEW
 * authorization to call it can be created. The reason is structural: an intent
 * may now hold several PRs (one per delivery), and this tool's only locator is
 * the intent id, which addresses a set rather than a row. The replacements are a
 * `pr:update` event carrying `association.deliveryId` / `pr.number` (for a reset
 * back to `reviewing`) and c3's own forge-driven `syncIntentPrStatus` (for the
 * terminal `merged` / `closed`).
 *
 * The core stays as the TRANSITIONAL implementation for whatever call path can
 * still reach it, with the two refusals that make it safe:
 *
 * It cannot create a PR. The tool only ever receives a status — no forge, no
 * repo, no URL — so letting it insert would make it the one entry point capable
 * of minting a PR row with no verifiable origin, which is exactly what the
 * ledger's identity key exists to prevent. An intent with no PR is therefore
 * rejected with an instruction to create one first.
 *
 * Several active PRs are rejected too, by NAMING them: with only an intent id in
 * hand the tool cannot say WHICH PR the caller reconciled, and picking one would
 * be a guess — a guess that would corrupt a real PR's status. This refusal is
 * pinned by a unit test so no later change can soften it back into a guess.
 */
export function runSaveIntentPrInfo(
  workspacePath: string,
  args: SaveIntentPrInfoArgs,
  onSaved: (workspacePath: string) => void,
): IntentToolResult {
  if (!isStoreAvailable()) return { content: text('意图库不可用,未保存。'), isError: true }
  const intent = getIntent(args.intentId)
  if (!intent || resolveWorkspaceRoot(intent.workspaceName) !== resolve(workspacePath)) {
    return { content: text(`未找到 id 为 ${args.intentId} 的意图(本项目)。`), isError: true }
  }
  if (intent.prs.length === 0) {
    return {
      content: text(`意图 ${intent.id} 尚无 PR,本工具只能更新既有 PR 的状态,请先创建 PR。`),
      isError: true,
    }
  }
  const active = activeIntentPrs(intent.prs)
  if (active.length > 1) {
    return {
      content: text(
        `意图 ${intent.id} 有 ${active.length} 条活跃 PR(${active
          .map((pr) => `#${pr.number}`)
          .join('、')}),无法确定要回填哪一条。`,
      ),
      isError: true,
    }
  }
  // The single PR to reconcile: the live one, or — when every PR is finished — the
  // one the intent has, so a merged/closed row can still be corrected.
  const target = active[0] ?? pickPrimaryIntentPr(intent.prs)
  if (!target) return { content: text(`意图 ${intent.id} 尚无 PR。`), isError: true }
  try {
    upsertIntentPr({
      intentId: intent.id,
      deliveryId: target.deliveryId,
      forge: target.forge,
      repo: target.repo,
      number: target.number,
      status: args.prStatus,
    })
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
