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
import {
  continueDiscussionDesc,
  continueDiscussionSchema,
  findDiscussionsDesc,
  findDiscussionsSchema,
  runContinueDiscussion,
  runFindDiscussions,
  runStartDiscussion,
  runViewDiscussion,
  startDiscussionDesc,
  startDiscussionSchema,
  viewDiscussionDesc,
  viewDiscussionSchema,
  type ContinueDiscussionArgs,
  type FindDiscussionsArgs,
  type StartDiscussionArgs,
  type ViewDiscussionArgs,
} from '../discussions/tool-defs.js'
import { hasDiscussionRun } from '../discussions/run-controls.js'
import type { Discussion, DiscussionMessage, PrOperationEvent } from '@ccc/shared/protocol'

interface AutomationMcpDeps {
  broadcastIntents: (workspacePath: string) => void
  publishPrEvent: (payload: { workspacePath: string; sessionId: string } & PrOperationEvent) => void
  /** Refresh a workspace's discussion list to every connection. */
  broadcastDiscussions: (workspacePath: string) => void
  /** Stream one appended discussion message to every connection. */
  broadcastDiscussionMessage: (discussionId: string, message: DiscussionMessage) => void
  /** Start (or resume) a background discussion orchestration run. */
  startDiscussionRun: (discussion: Discussion) => void
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
  // Discussion run-control deps: `hasDiscussionRun` is the feature-private
  // live-run guard (imported directly); `startDiscussionRun` + broadcasts come
  // from the composition root so this module never reverse-depends on wiring.
  const runStarter = {
    hasDiscussionRun,
    startDiscussionRun: (discussion: Discussion) => current?.startDiscussionRun(discussion),
  }
  const findDiscussionsHandler = async (args: FindDiscussionsArgs) => ({
    ...runFindDiscussions(workspacePath, args),
  })
  const viewDiscussionHandler = async (args: ViewDiscussionArgs) => ({
    ...runViewDiscussion(workspacePath, args),
  })
  const startDiscussionHandler = async (args: StartDiscussionArgs) => ({
    ...runStartDiscussion(workspacePath, args, runStarter),
  })
  const continueDiscussionHandler = async (args: ContinueDiscussionArgs) => ({
    ...runContinueDiscussion(workspacePath, args, {
      ...runStarter,
      broadcastDiscussionMessage: (id, message) => current?.broadcastDiscussionMessage(id, message),
      broadcastDiscussions: (path) => current?.broadcastDiscussions(path),
    }),
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
      tool('find_discussions', findDiscussionsDesc, findDiscussionsSchema, findDiscussionsHandler),
      tool('view_discussion', viewDiscussionDesc, viewDiscussionSchema, viewDiscussionHandler),
      tool('start_discussion', startDiscussionDesc, startDiscussionSchema, startDiscussionHandler),
      tool(
        'continue_discussion',
        continueDiscussionDesc,
        continueDiscussionSchema,
        continueDiscussionHandler,
      ),
    ],
  })
  return { c3: server }
}
