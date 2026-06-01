/**
 * The in-process MCP tools the `c3` server exposes to the requirement-
 * communication agent:
 *  - `save_requirements` (write): the agent submits a batch of proposed
 *    requirements; the c3 permission gate (see `claude.ts`) intercepts and asks
 *    the user to confirm. Reaching the handler therefore means the user already
 *    allowed it — the handler just persists and broadcasts.
 *  - `find_requirements` / `view_requirement` (read-only): let the agent search
 *    the project ledger and inspect one item so it can discover related work,
 *    avoid duplicates, and set `dependsOn` correctly. The gate auto-allows these
 *    (no confirmation). All three are bound to ONE project via `projectPath` in
 *    the closure, so the agent can never read/write another project's ledger.
 *
 * Tools are named on the `c3` server, so the fully-qualified names are
 * `mcp__c3__save_requirements` / `mcp__c3__find_requirements` /
 * `mcp__c3__view_requirement` (see the `*_TOOL` constants in `claude.ts`).
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { RequirementStatus } from '@ccc/shared/protocol'
import { findRequirements, getRequirement, insertRequirements, isStoreAvailable } from './store.js'

const REQUIREMENT_STATUSES = [
  'draft',
  'todo',
  'in_progress',
  'done',
  'cancelled',
] as const satisfies readonly RequirementStatus[]

/**
 * Build the `c3` MCP server carrying `save_requirements`, bound to one project.
 *
 * `projectPath` is captured in the closure so the agent can't redirect the save
 * to another project; `onSaved` lets the server broadcast the refreshed list
 * (the tool stays decoupled from connection state). Re-construct per run so the
 * binding always matches the current comm runtime's workspace.
 */
export function createRequirementMcpServer(
  projectPath: string,
  onSaved: (projectPath: string) => void,
): Record<string, McpServerConfig> {
  const server = createSdkMcpServer({
    name: 'c3',
    // Keep this server's tools resident in the turn-1 prompt instead of letting
    // the harness defer them behind tool search. Without this, the requirement
    // agent must ToolSearch `save_requirements` back before every save (an extra
    // round-trip + tokens). `alwaysLoad` sets `_meta['anthropic/alwaysLoad']` on
    // each tool (≡ API `defer_loading: false`). The blocking-startup side effect
    // is moot here — this is an in-process MCP server, so it connects instantly.
    // Scope is naturally the requirement agent only: this server is built solely
    // by the `kind === 'requirement'` / `gate: 'requirement'` launch path.
    alwaysLoad: true,
    tools: [
      tool(
        'save_requirements',
        '提交一批拟新增的需求条目;落库前由用户在 c3 UI 确认。' +
          '当本批需求之间存在先后/依赖关系时,用每条的 dependsOnIndexes 字段(同批数组下标)' +
          '声明它依赖本批的哪些兄弟需求,落库时会解析为真实 id,使自动化编排按依赖顺序启动。',
        {
          requirements: z.array(
            z.object({
              title: z.string(),
              content: z.string(),
              priority: z.enum(['P0', 'P1', 'P2', 'P3']),
              module: z.string().optional().describe('所属模块名(按标题/内容推断,可留空)'),
              dependsOn: z
                .array(z.string())
                .optional()
                .describe('依赖的“已存在需求”的 id(引用本次提交之前就已落库的需求)'),
              dependsOnIndexes: z
                .array(z.number().int())
                .optional()
                .describe(
                  '本批内依赖:用同批 requirements 数组的下标(0 起)引用兄弟需求;' +
                    '有先后关系时务必填写(被依赖项应排在依赖项之前提交)。' +
                    '与 dependsOn 并用互补;下标越界/自引用/批内成环会导致整批保存失败。',
                ),
            }),
          ),
        },
        async (args) => {
          // Getting here means the gate already allowed (user confirmed).
          if (!isStoreAvailable()) {
            return {
              content: [{ type: 'text', text: '需求库不可用,未保存。' }],
              isError: true,
            }
          }
          try {
            const saved = insertRequirements(projectPath, args.requirements)
            onSaved(projectPath)
            return {
              content: [
                {
                  type: 'text',
                  text: `已保存 ${saved.length} 条需求:${saved.map((r) => r.title).join('、')}`,
                },
              ],
            }
          } catch (err) {
            return {
              content: [{ type: 'text', text: `保存失败:${String(err)}` }],
              isError: true,
            }
          }
        },
      ),
      tool(
        'find_requirements',
        '检索本项目已有需求(只读)。用于发现关联项、避免重复、为 dependsOn 找到真实 id。' +
          '可按 keyword(模糊匹配标题/内容)、module、status 过滤(均可选,留空则返回全部);' +
          '返回精简列表(id、title、module、priority、status、dependsOn)。',
        {
          keyword: z.string().optional().describe('关键字,模糊匹配 title/content(可留空)'),
          module: z.string().optional().describe('按所属模块名精确过滤(可留空)'),
          status: z
            .enum(REQUIREMENT_STATUSES)
            .optional()
            .describe('按状态过滤:draft/todo/in_progress/done/cancelled(可留空)'),
        },
        async (args) => {
          if (!isStoreAvailable()) {
            return { content: [{ type: 'text', text: '需求库不可用,无法检索。' }], isError: true }
          }
          const rows = findRequirements(projectPath, {
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
                type: 'text',
                text:
                  slim.length === 0
                    ? '未找到匹配的需求。'
                    : `找到 ${slim.length} 条需求:\n${JSON.stringify(slim, null, 2)}`,
              },
            ],
          }
        },
      ),
      tool(
        'view_requirement',
        '按 id 查看本项目单条需求的完整详情(只读,含 content、dependsOn 等)。',
        {
          id: z.string().describe('需求 id'),
        },
        async (args) => {
          if (!isStoreAvailable()) {
            return { content: [{ type: 'text', text: '需求库不可用,无法查看。' }], isError: true }
          }
          const req = getRequirement(args.id)
          // Bind to the closure project: getRequirement is id-only, so guard here
          // that the row belongs to THIS project — otherwise treat it as not found
          // (no cross-project reads, consistent with save_requirements).
          if (!req || req.projectPath !== resolve(projectPath)) {
            return {
              content: [{ type: 'text', text: `未找到 id 为 ${args.id} 的需求(本项目)。` }],
            }
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(req, null, 2) }],
          }
        },
      ),
    ],
  })
  return { c3: server }
}
