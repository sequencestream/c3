/**
 * Framing-free builder for the automation c3 MCP tool set — ONE source registered
 * onto the localhost HTTP MCP route (`transport/automation-mcp`) that BOTH Claude
 * and Codex automations bind per execution. There is no separate in-process SDK MCP
 * surface anymore; every vendor reads these tools over the same streamable-HTTP route.
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
  runView,
  saveIntentDirectlyDesc,
  saveIntentDirectlySchema,
  viewDesc,
  viewSchema,
  type FindArgs,
  type SaveIntentDirectlyArgs,
  type ViewArgs,
} from '../intents/tool-defs.js'
import {
  findDeliveriesDesc,
  findDeliveriesSchema,
  runFindDeliveries,
  runViewDelivery,
  viewDeliveryDesc,
  viewDeliverySchema,
  type FindDeliveriesArgs,
  type ViewDeliveryArgs,
} from '../deliveries/tool-defs.js'
import {
  runSyncIntentPrStatus,
  syncIntentPrStatusDesc,
  syncIntentPrStatusSchema,
  type SyncIntentPrStatusArgs,
} from '../intents/pr-status-tool-defs.js'
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
import type { Discussion, DiscussionMessage } from '@ccc/shared/protocol'
import type { GenericEvent, GenericEventEnvelope } from '@ccc/shared'
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
 * composition-root callbacks (may be null before the route is wired at startup,
 * guarded with `?.` on every branch). The handlers close over `workspacePath` /
 * `executionId` so the model can neither read nor write another workspace's data,
 * and the tool args never accept a workspace or session override.
 *
 * `executionId` accepts a getter (the robot-turn binder passes the live run id
 * so a pending→real rebind attributes `publish_event` to the bound session);
 * automations keep passing a fixed execution id — the getter form is only
 * resolved where the id is actually read, so a string call site is unchanged.
 */
export function buildAutomationC3Tools(
  workspacePath: string,
  executionId: string | (() => string),
  deps: AutomationMcpDeps | null,
  automationMetadata?: Record<string, string>,
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
    // Delivery tools are READ-ONLY by design; there is deliberately no write
    // counterpart, since every status write funnels through the state machine.
    {
      name: 'find_deliveries',
      description: findDeliveriesDesc,
      inputSchema: findDeliveriesSchema,
      handler: async (args) => ({
        ...runFindDeliveries(workspacePath, args as FindDeliveriesArgs),
      }),
    },
    {
      name: 'view_delivery',
      description: viewDeliveryDesc,
      inputSchema: viewDeliverySchema,
      handler: async (args) => ({ ...runViewDelivery(workspacePath, args as ViewDeliveryArgs) }),
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
    // PR-status sync: a TRIGGER, not a status write. The tool takes only an
    // intent id and hands it to the shared `syncIntentPrStatus` core, which
    // queries the forge for every `reviewing` row and persists the terminal
    // `merged` / `closed` states — the model never supplies a status value, so
    // the ledger can only move on the forge's own verdict.
    {
      name: 'sync_intent_pr_status',
      description: syncIntentPrStatusDesc,
      inputSchema: syncIntentPrStatusSchema,
      handler: async (args) =>
        await runSyncIntentPrStatus(workspacePath, args as SyncIntentPrStatusArgs, (path) =>
          deps?.broadcastIntents(path),
        ),
    },
    {
      name: 'publish_event',
      description: publishEventDesc,
      inputSchema: publishEventSchema,
      handler: async (args) => {
        // Seed the published event's metadata with this automation's own
        // annotations so downstream automations can filter chains by them, then
        // let the model's own `metadata` win on key conflicts (spread last).
        const core = args as PublishEventArgs
        const merged =
          automationMetadata && Object.keys(automationMetadata).length > 0
            ? { ...core, metadata: { ...automationMetadata, ...core.metadata } }
            : core
        return {
          ...runPublishEvent(
            merged,
            (event) =>
              deps?.normalizeEvent(event) ?? {
                ok: false,
                reason: 'automation event deps not wired',
              },
            (event) =>
              deps?.publishEvent({
                workspacePath,
                sessionId: typeof executionId === 'function' ? executionId() : executionId,
                event,
              }),
          ),
        }
      },
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
        'sessionType="work":若意图已有存活的工作会话,正在跑则 attach(返回原 id,不发新 turn),' +
        '空闲则 resume(在原 id 上续跑);否则校验状态、SDD 审批、依赖阻塞与 Git 分支策略后,' +
        '启动开发会话并注册 pending→intent 回链。' +
        '同一工作区已有其它意图的工作会话在运行时,fresh/resume 会被全局并发闸门拒绝。' +
        '成功返回 JSON:{"sessionId":"…","sessionType":"…","mode":"fresh|resume|attach"},' +
        '失败返回 JSON:{"code":"…","params":{…}}。',
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
              content: text(
                JSON.stringify({ sessionId: result.sessionId, sessionType, mode: result.mode }),
              ),
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
