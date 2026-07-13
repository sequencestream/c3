/**
 * Framing-free builder for the automation c3 MCP tool set — ONE source consumed
 * by both surfaces that expose these tools to an unattended automation execution:
 *  - the in-process Claude SDK MCP server (`c3-mcp.ts`, `createSdkMcpServer`),
 *  - the localhost HTTP MCP route for the driver-path vendor
 *    (`transport/automation-mcp`, codex — `inProcessMcp: false`, so it cannot load
 *    the SDK server and reads the same tools over streamable-HTTP instead).
 *
 * Each entry pairs a tool name + description + zod input shape with a handler
 * closure bound to ONE automation execution (its `workspacePath` + `executionId`).
 * Keeping the list here — instead of duplicating the closures per surface —
 * guarantees Claude and Codex automations advertise the SAME tools with the SAME
 * behavior, and lets the HTTP route derive its explicit `enabledTools` from the
 * same list so the two never drift.
 *
 * This module is framing-free: it imports only the shared tool-defs (the zod
 * shapes + descriptions + core logic) and the feature-private discussion run
 * guard. The composition-root callbacks arrive as injected {@link AutomationMcpDeps}
 * so it never reverse-depends on wiring; the SDK / MCP framing lives in each surface.
 */
import type { ZodRawShape } from 'zod'
import { z } from 'zod'
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
  publishEventDesc,
  publishEventSchema,
  runPublishEvent,
  type PublishEventArgs,
} from '../events/tool-defs.js'
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
import {
  launchSpecSession,
  launchWorkSession,
  type SessionLaunchDeps,
  type SessionLaunchResult,
} from '../intents/session-launcher.js'
import type {
  Discussion,
  DiscussionMessage,
  GenericEvent,
  GenericEventEnvelope,
} from '@ccc/shared/protocol'
import type { NormalizeResult } from '../../kernel/events/generic-event.js'

/** Composition-root callbacks the automation c3 tool handlers need at dispatch time. */
export interface AutomationMcpDeps {
  broadcastIntents: (workspacePath: string) => void
  /** Normalize an untrusted event core through the kernel normalizer registry. */
  normalizeEvent: (core: GenericEvent) => NormalizeResult
  publishEvent: (payload: GenericEventEnvelope) => void
  /** Refresh a workspace's discussion list to every connection. */
  broadcastDiscussions: (workspacePath: string) => void
  /** Stream one appended discussion message to every connection. */
  broadcastDiscussionMessage: (discussionId: string, message: DiscussionMessage) => void
  /** Start (or resume) a background discussion orchestration run. */
  startDiscussionRun: (discussion: Discussion) => void
  /** Start an agent run — injected by the composition root for session launcher tools. */
  readonly launchRun: SessionLaunchDeps['launchRun']
}

/** An MCP tool result. Structurally identical across the Claude SDK and the MCP SDK. */
export interface AutomationC3ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** One automation c3 tool: its wire identity + a handler bound to the execution. */
export interface AutomationC3Tool {
  name: string
  description: string
  inputSchema: ZodRawShape
  /** Args arrive already validated by the surface's zod gate; the closure narrows them. */
  handler: (args: unknown) => Promise<AutomationC3ToolResult>
}

/**
 * Build the automation c3 tool list bound to ONE execution. `deps` are the
 * composition-root callbacks (null before {@link configureAutomationMcp}, guarded
 * with `?.` on every branch). The handlers close over `workspacePath` /
 * `executionId` so the model can neither read nor write another workspace's data,
 * and the tool args never accept a workspace or session override.
 */
export function buildAutomationC3Tools(
  workspacePath: string,
  executionId: string,
  deps: AutomationMcpDeps | null,
): AutomationC3Tool[] {
  // Discussion run-control deps: `hasDiscussionRun` is the feature-private
  // live-run guard (imported directly); `startDiscussionRun` + broadcasts come
  // from the injected composition-root callbacks.
  const runStarter = {
    hasDiscussionRun,
    startDiscussionRun: (discussion: Discussion) => deps?.startDiscussionRun(discussion),
  }
  // Session-launcher deps: built from the automation composition-root callbacks
  // so the shared core never depends on MCP framing.
  const sessionLaunchDeps: SessionLaunchDeps = {
    launchRun: (rt, prompt, images, inject) =>
      deps?.launchRun(rt, prompt, images, inject) ?? Promise.resolve(),
    broadcastIntents: (path) => deps?.broadcastIntents(path),
  }
  const text = (s: string): AutomationC3ToolResult['content'] => [
    { type: 'text' as const, text: s },
  ]
  return [
    {
      name: 'find_intents',
      description: findDesc,
      inputSchema: findSchema,
      handler: async (args) => ({ ...runFind(workspacePath, args as FindArgs) }),
    },
    {
      name: 'view_intent',
      description: viewDesc,
      inputSchema: viewSchema,
      handler: async (args) => ({ ...runView(workspacePath, args as ViewArgs) }),
    },
    {
      name: 'save_intent_pr_info',
      description: saveIntentPrInfoDesc,
      inputSchema: saveIntentPrInfoSchema,
      handler: async (args) => ({
        ...runSaveIntentPrInfo(workspacePath, args as SaveIntentPrInfoArgs, (path) =>
          deps?.broadcastIntents(path),
        ),
      }),
    },
    {
      name: 'save_intent_directly',
      description: saveIntentDirectlyDesc,
      inputSchema: saveIntentDirectlySchema,
      handler: async (args) => ({
        ...runSaveIntentDirectly(workspacePath, args as SaveIntentDirectlyArgs, (path) =>
          deps?.broadcastIntents(path),
        ),
      }),
    },
    {
      name: 'publish_event',
      description: publishEventDesc,
      inputSchema: publishEventSchema,
      handler: async (args) => ({
        ...runPublishEvent(
          args as PublishEventArgs,
          (core) =>
            deps?.normalizeEvent(core) ?? { ok: false, reason: 'automation event deps not wired' },
          (event) => deps?.publishEvent({ workspacePath, sessionId: executionId, event }),
        ),
      }),
    },
    {
      name: 'find_discussions',
      description: findDiscussionsDesc,
      inputSchema: findDiscussionsSchema,
      handler: async (args) => ({
        ...runFindDiscussions(workspacePath, args as FindDiscussionsArgs),
      }),
    },
    {
      name: 'view_discussion',
      description: viewDiscussionDesc,
      inputSchema: viewDiscussionSchema,
      handler: async (args) => ({
        ...runViewDiscussion(workspacePath, args as ViewDiscussionArgs),
      }),
    },
    {
      name: 'start_discussion',
      description: startDiscussionDesc,
      inputSchema: startDiscussionSchema,
      handler: async (args) => ({
        ...runStartDiscussion(workspacePath, args as StartDiscussionArgs, runStarter),
      }),
    },
    {
      name: 'continue_discussion',
      description: continueDiscussionDesc,
      inputSchema: continueDiscussionSchema,
      handler: async (args) => ({
        ...runContinueDiscussion(workspacePath, args as ContinueDiscussionArgs, {
          ...runStarter,
          broadcastDiscussionMessage: (id, message) =>
            deps?.broadcastDiscussionMessage(id, message),
          broadcastDiscussions: (path) => deps?.broadcastDiscussions(path),
        }),
      }),
    },
    {
      name: 'start_session_for_intent',
      description:
        '为一条意图启动 spec 编写或开发会话。' +
        'sessionType="spec":首次创建 spec 目录与种子文件,启动受限 spec 会话;' +
        '若 intent 已有 specSessionId 则续写同一会话(不重建目录,返回原 id)。' +
        'sessionType="work":校验状态、SDD 审批、依赖阻塞与 Git 分支策略后,' +
        '启动开发会话并注册 pending→intent 回链。' +
        '成功返回 JSON:{"sessionId":"…","sessionType":"…"},失败返回 JSON:{"code":"…","params":{…}}。',
      inputSchema: {
        intentId: z.string().describe('要启动会话的意图 id'),
        sessionType: z.enum(['spec', 'work']).describe('会话类型:spec=编写需求文档, work=开始开发'),
      },
      handler: async (args) => {
        const { intentId, sessionType } = args as {
          intentId: string
          sessionType: 'spec' | 'work'
        }
        try {
          const result: SessionLaunchResult =
            sessionType === 'work'
              ? await launchWorkSession(workspacePath, intentId, sessionLaunchDeps)
              : await launchSpecSession(workspacePath, intentId, sessionLaunchDeps)

          if (result.success) {
            return {
              content: text(JSON.stringify({ sessionId: result.sessionId, sessionType })),
            }
          }
          const errorPayload: Record<string, unknown> = { code: result.code }
          if (result.params) errorPayload.params = result.params
          return {
            content: text(JSON.stringify(errorPayload)),
            isError: true,
          }
        } catch (err) {
          return {
            content: text(
              JSON.stringify({
                code: 'intent.launchInternalError',
                params: { message: String(err) },
              }),
            ),
            isError: true,
          }
        }
      },
    },
  ]
}

/**
 * The stable, ordered names of the automation c3 tool set — the single source the
 * HTTP route hands Codex as its explicit `enabledTools` (Codex marks each
 * required/approved, so the route must advertise ALL of them or a listed tool is
 * silently disabled). Derived from {@link buildAutomationC3Tools} so it can never
 * drift from what the surfaces actually register. The dummy binding builds only
 * closures — no handler runs, no store is touched.
 */
export const AUTOMATION_C3_TOOL_NAMES: readonly string[] = buildAutomationC3Tools('', '', null).map(
  (t) => t.name,
)
