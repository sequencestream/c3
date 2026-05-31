/**
 * The in-process `save_requirements` MCP tool exposed to the requirement-
 * communication agent. The agent calls it with a batch of proposed requirements;
 * the c3 permission gate (see `claude.ts`) intercepts the call and asks the user
 * to confirm. Reaching this handler therefore means the user already allowed it —
 * the handler just persists and broadcasts.
 *
 * The tool is named `save_requirements` on the `c3` server, so its fully-qualified
 * name is `mcp__c3__save_requirements` (see `SAVE_REQUIREMENTS_TOOL`).
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { insertRequirements, isStoreAvailable } from './store.js'

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
    ],
  })
  return { c3: server }
}
