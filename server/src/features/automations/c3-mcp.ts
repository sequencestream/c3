/**
 * In-process c3 MCP profile for unattended Claude automation runs.
 *
 * This is deliberately separate from the interactive intent MCP profile: a
 * automation has no browser decision queue, so it exposes only the bounded PR
 * reconciliation write instead of the confirmation-gated general intent save.
 */
// eslint-disable-next-line no-restricted-imports
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
// eslint-disable-next-line no-restricted-imports
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import {
  findDesc,
  findSchema,
  runFind,
  runSaveIntentDirectly,
  runSaveIntentPrInfo,
  runView,
  saveIntentDirectlyDesc,
  saveIntentDirectlySchema,
  saveIntentPrInfoDesc,
  saveIntentPrInfoSchema,
  viewDesc,
  viewSchema,
  type FindArgs,
  type SaveIntentDirectlyArgs,
  type SaveIntentPrInfoArgs,
  type ViewArgs,
} from '../intents/tool-defs.js'
import {
  publishPrEventDesc,
  publishPrEventSchema,
  runPublishPrEvent,
  type PublishPrEventArgs,
} from '../pr-events/tool-defs.js'
import type { PrOperationEvent } from '@ccc/shared/protocol'

interface AutomationMcpDeps {
  broadcastIntents: (workspacePath: string) => void
  publishPrEvent: (payload: { workspacePath: string; sessionId: string } & PrOperationEvent) => void
}

let deps: AutomationMcpDeps | null = null

/** Configure composition-root callbacks used by automation c3 MCP handlers. */
export function configureAutomationMcp(next: AutomationMcpDeps): void {
  deps = next
}

/** Build the restricted c3 server bound to one automation execution. */
export function createAutomationMcpServer(
  workspacePath: string,
  executionId: string,
): Record<string, McpServerConfig> {
  const current = deps
  const findHandler = async (args: FindArgs) => ({ ...runFind(workspacePath, args) })
  const viewHandler = async (args: ViewArgs) => ({ ...runView(workspacePath, args) })
  const savePrHandler = async (args: SaveIntentPrInfoArgs) => ({
    ...runSaveIntentPrInfo(workspacePath, args, (path) => current?.broadcastIntents(path)),
  })
  const saveDirectlyHandler = async (args: SaveIntentDirectlyArgs) => ({
    ...runSaveIntentDirectly(workspacePath, args, (path) => current?.broadcastIntents(path)),
  })
  const publishHandler = async (args: PublishPrEventArgs) => ({
    ...runPublishPrEvent(args, (event) =>
      current?.publishPrEvent({ workspacePath, sessionId: executionId, ...event }),
    ),
  })
  const server = createSdkMcpServer({
    name: 'c3',
    alwaysLoad: true,
    tools: [
      tool('find_intents', findDesc, findSchema, findHandler),
      tool('view_intent', viewDesc, viewSchema, viewHandler),
      tool('save_intent_pr_info', saveIntentPrInfoDesc, saveIntentPrInfoSchema, savePrHandler),
      tool(
        'save_intent_directly',
        saveIntentDirectlyDesc,
        saveIntentDirectlySchema,
        saveDirectlyHandler,
      ),
      tool('publish_pr_event', publishPrEventDesc, publishPrEventSchema, publishHandler),
    ],
  })
  return { c3: server }
}
