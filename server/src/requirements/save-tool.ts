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
    tools: [
      tool(
        'save_requirements',
        '提交一批拟新增的需求条目;落库前由用户在 c3 UI 确认。',
        {
          requirements: z.array(
            z.object({
              title: z.string(),
              content: z.string(),
              priority: z.enum(['P0', 'P1', 'P2', 'P3']),
              dependsOn: z.array(z.string()).optional(),
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
