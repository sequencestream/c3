/**
 * The in-process MCP tools the `c3` server exposes to the intent-
 * communication agent:
 *  - `save_intents` (write): the agent submits a batch of proposed
 *    intents; the c3 permission gate (see `claude.ts`) intercepts and asks
 *    the user to confirm. Reaching the handler therefore means the user already
 *    allowed it — the handler just persists and broadcasts.
 *  - `find_intents` / `view_intent` (read-only): let the agent search
 *    the project ledger and inspect one item so it can discover related work,
 *    avoid duplicates, and set `dependsOn` correctly. The gate auto-allows these
 *    (no confirmation). All three are bound to ONE project via `projectPath` in
 *    the closure, so the agent can never read/write another project's ledger.
 *
 * Tools are named on the `c3` server, so the fully-qualified names are
 * `mcp__c3__save_intents` / `mcp__c3__find_intents` /
 * `mcp__c3__view_intent` (see the `*_TOOL` constants in `claude.ts`).
 *
 * Deprecated alias soft-landing (requirements→intents rename, PR-2): the old
 * `save_requirements` / `find_requirements` / `view_requirement` names are ALSO
 * registered (same schema + handler) so a cached/old caller that hardcoded a
 * pre-rename name still works for ONE minor version. The system prompt advertises
 * only the new names; the deprecated tools survive purely as a fallback and are
 * **hard-deleted next minor**.
 */
// C-SEC exception (annotated): this DEFINES an in-process MCP tool (the
// `save_intents` server) handed to the kernel run loop — it does not run an
// agent or mint a permission verdict. The tool's invocations still pass through
// the intent gate in `kernel/permission` (classifyIntentTool ⇒ confirm-save).
// eslint-disable-next-line no-restricted-imports
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
// eslint-disable-next-line no-restricted-imports
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { IntentStatus } from '@ccc/shared/protocol'
import { findIntents, getIntent, isStoreAvailable, upsertIntents } from './store.js'

const INTENT_STATUSES = [
  'draft',
  'todo',
  'in_progress',
  'done',
  'cancelled',
] as const satisfies readonly IntentStatus[]

/** Prefix a deprecated alias tool's description so the model prefers the new name. */
const DEPRECATED = (newName: string, desc: string) => `【已弃用,请改用 ${newName}】${desc}`

/**
 * Build the `c3` MCP server carrying `save_intents`, bound to one project.
 *
 * `projectPath` is captured in the closure so the agent can't redirect the save
 * to another project; `onSaved` lets the server broadcast the refreshed list
 * (the tool stays decoupled from connection state). Re-construct per run so the
 * binding always matches the current comm runtime's workspace.
 */
export function createIntentMcpServer(
  projectPath: string,
  onSaved: (projectPath: string) => void,
): Record<string, McpServerConfig> {
  // ---- Shared schemas + handlers (registered under both the canonical and the
  // deprecated wire names so a pre-rename caller lands on the same logic). ----

  const saveSchema = {
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
  const saveHandler = async (args: { intents: Parameters<typeof upsertIntents>[1] }) => {
    // Getting here means the gate already allowed (user confirmed).
    if (!isStoreAvailable()) {
      return {
        content: [{ type: 'text' as const, text: '意图库不可用,未保存。' }],
        isError: true,
      }
    }
    try {
      // Upsert: items carrying an `id` update that intent in place; the rest insert.
      // The whole batch is atomic — a status-locked / foreign / unknown id (or an
      // invalid intra-batch dep) throws and nothing is written.
      const updated = args.intents.filter((it) => it.id !== undefined).length
      const created = args.intents.length - updated
      const saved = upsertIntents(projectPath, args.intents)
      onSaved(projectPath)
      const summary =
        updated > 0
          ? `已保存 ${saved.length} 条意图(新建 ${created}、更新 ${updated})`
          : `已保存 ${saved.length} 条意图`
      return {
        content: [
          {
            type: 'text' as const,
            text: `${summary}:${saved.map((r) => r.title).join('、')}`,
          },
        ],
      }
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `保存失败:${String(err)}` }],
        isError: true,
      }
    }
  }

  const findSchema = {
    keyword: z.string().optional().describe('关键字,模糊匹配 title/content(可留空)'),
    module: z.string().optional().describe('按所属模块名精确过滤(可留空)'),
    status: z
      .enum(INTENT_STATUSES)
      .optional()
      .describe('按状态过滤:draft/todo/in_progress/done/cancelled(可留空)'),
  }
  const findHandler = async (args: {
    keyword?: string
    module?: string
    status?: IntentStatus
  }) => {
    if (!isStoreAvailable()) {
      return {
        content: [{ type: 'text' as const, text: '意图库不可用,无法检索。' }],
        isError: true,
      }
    }
    const rows = findIntents(projectPath, {
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
      content: [
        {
          type: 'text' as const,
          text:
            slim.length === 0
              ? '未找到匹配的意图。'
              : `找到 ${slim.length} 条意图:\n${JSON.stringify(slim, null, 2)}`,
        },
      ],
    }
  }

  const viewSchema = { id: z.string().describe('意图 id') }
  const viewHandler = async (args: { id: string }) => {
    if (!isStoreAvailable()) {
      return {
        content: [{ type: 'text' as const, text: '意图库不可用,无法查看。' }],
        isError: true,
      }
    }
    const req = getIntent(args.id)
    // Bind to the closure project: getIntent is id-only, so guard here
    // that the row belongs to THIS project — otherwise treat it as not found
    // (no cross-project reads, consistent with save_intents).
    if (!req || req.projectPath !== resolve(projectPath)) {
      return {
        content: [{ type: 'text' as const, text: `未找到 id 为 ${args.id} 的意图(本项目)。` }],
      }
    }
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(req, null, 2) }],
    }
  }

  const saveDesc =
    '提交一批意图条目(新建或更新);落库前由用户在 c3 UI 确认。' +
    '每条不带 id 则新建;带 id 则原地更新该已存在意图(upsert)——' +
    'refine 已有意图时务必回填原 id 以更新原条目,避免新建重复项;' +
    'in_progress/done 的意图不可修改(整批失败),cancelled 更新后会重新激活为 todo。' +
    '当本批意图之间存在先后/依赖关系时,用每条的 dependsOnIndexes 字段(同批数组下标)' +
    '声明它依赖本批的哪些兄弟意图,落库时会解析为真实 id,使自动化编排按依赖顺序启动。'
  const findDesc =
    '检索本项目已有意图(只读)。用于发现关联项、避免重复、为 dependsOn 找到真实 id。' +
    '可按 keyword(模糊匹配标题/内容)、module、status 过滤(均可选,留空则返回全部);' +
    '返回精简列表(id、title、module、priority、status、dependsOn)。'
  const viewDesc = '按 id 查看本项目单条意图的完整详情(只读,含 content、dependsOn 等)。'

  const server = createSdkMcpServer({
    name: 'c3',
    // Keep this server's tools resident in the turn-1 prompt instead of letting
    // the harness defer them behind tool search. Without this, the intent
    // agent must ToolSearch `save_intents` back before every save (an extra
    // round-trip + tokens). `alwaysLoad` sets `_meta['anthropic/alwaysLoad']` on
    // each tool (≡ API `defer_loading: false`). The blocking-startup side effect
    // is moot here — this is an in-process MCP server, so it connects instantly.
    // Scope is naturally the intent agent only: this server is built solely
    // by the `kind === 'intent'` / `gate: 'intent'` launch path.
    alwaysLoad: true,
    tools: [
      // Canonical names (advertised in the system prompt).
      tool('save_intents', saveDesc, saveSchema, saveHandler),
      tool('find_intents', findDesc, findSchema, findHandler),
      tool('view_intent', viewDesc, viewSchema, viewHandler),
      // Deprecated wire-name aliases (PR-2 soft-landing; hard-delete next minor).
      tool('save_requirements', DEPRECATED('save_intents', saveDesc), saveSchema, saveHandler),
      tool('find_requirements', DEPRECATED('find_intents', findDesc), findSchema, findHandler),
      tool('view_requirement', DEPRECATED('view_intent', viewDesc), viewSchema, viewHandler),
    ],
  })
  return { c3: server }
}
