/**
 * Call-scoped c3 write tools for IM robots.
 *
 * Capability selection happens when robot-mcp registers a per-turn subset. This
 * module enforces the independent target boundary on every invocation: refresh
 * the IM scope, resolve only registered workspaces, reject foreign object ids,
 * then enter the shared domain core. The robot run root is intentionally absent
 * from every type and closure in this file.
 */
import { z, type ZodRawShape } from 'zod'
import type { Discussion, DiscussionMessage } from '@ccc/shared/protocol'
import { resolveWorkspaceRoot } from '../../state.js'
import type { AutomationC3Tool, AutomationC3ToolResult } from '../automations/c3-tools.js'
import {
  runSaveConfirmed,
  runSaveIntentDirectly,
  saveDesc,
  saveIntentDirectlyDesc,
  saveIntentDirectlySchema,
  saveSchema,
  type SaveArgs,
  type SaveIntentDirectlyArgs,
} from '../intents/tool-defs.js'
import { getIntent } from '../intents/store.js'
import {
  readSpecFingerprint,
  runSubmitSpecReview,
  submitSpecReviewDesc,
  submitSpecReviewSchema,
  type SubmitSpecReviewArgs,
} from '../intents/spec-review.js'
import {
  launchSpecSession,
  launchWorkSession,
  type SessionLaunchDeps,
  type SessionLaunchResult,
} from '../intents/session-launcher.js'
import {
  continueDiscussionDesc,
  continueDiscussionSchema,
  runContinueDiscussion,
  runStartDiscussion,
  startDiscussionDesc,
  startDiscussionSchema,
  type ContinueDiscussionArgs,
  type StartDiscussionArgs,
} from '../discussions/tool-defs.js'
import { getDiscussion } from '../discussions/store.js'
import { hasDiscussionRun } from '../discussions/run-controls.js'
import { isWorkspaceInDetail, type CallScopeSnapshot } from './call-scope.js'
import {
  freshRobotScope,
  robotNotVisible,
  robotScopeChanged,
  type RobotL1AuthContext,
} from './robot-l1-tools.js'

export const ROBOT_WRITE_TOOL_NAMES = [
  'save_intents',
  'save_intent_directly',
  'submit_spec_review',
  'start_session_for_intent',
  'start_discussion',
  'continue_discussion',
] as const

export type RobotWriteToolName = (typeof ROBOT_WRITE_TOOL_NAMES)[number]

export function isRobotWriteTool(name: string): name is RobotWriteToolName {
  return (ROBOT_WRITE_TOOL_NAMES as readonly string[]).includes(name)
}

/** Composition-root callbacks needed by the six robot write tools, and no more. */
export interface RobotWriteMcpDeps {
  broadcastIntents: (workspacePath: string) => void
  broadcastDiscussions: (workspacePath: string) => void
  broadcastDiscussionMessage: (discussionId: string, message: DiscussionMessage) => void
  startDiscussionRun: (discussion: Discussion) => void
  readonly launchRun: SessionLaunchDeps['launchRun']
}

type RobotWriteDeps = () => RobotWriteMcpDeps | null

type ExplicitWorkspaceArgs = { workspaceName: string }
type StartSessionArgs = { intentId: string; sessionType: 'spec' | 'work' }
type RobotSpecReviewArgs = SubmitSpecReviewArgs & { intentId: string }

const workspaceNameField = z
  .string()
  .min(1)
  .describe('本次写入的目标工作区名称,必须属于当前 IM 对话的详细可见工作区。')

const startSessionDesc =
  '为一条意图启动 spec 编写或开发会话。' +
  'sessionType="spec" 时创建或续写 spec 会话;sessionType="work" 时复用既有工作会话或在全部业务门通过后启动开发。' +
  '作用域通过不代表业务门通过,意图状态、规格批准、依赖、并发与 Git 分支策略仍由共享启动核心校验。'

const startSessionSchema = {
  intentId: z.string().describe('要启动会话的意图 id'),
  sessionType: z.enum(['spec', 'work']).describe('会话类型:spec=编写需求文档, work=开始开发'),
}

function text(value: string): AutomationC3ToolResult['content'] {
  return [{ type: 'text', text: value }]
}

function depsNotReady(): AutomationC3ToolResult {
  return {
    content: text(JSON.stringify({ code: 'robot_mcp_not_ready' })),
    isError: true,
  }
}

function workspacePathFor(
  auth: RobotL1AuthContext,
  scope: CallScopeSnapshot,
  workspaceName: string,
): string | AutomationC3ToolResult {
  if (!isWorkspaceInDetail(scope, workspaceName)) return robotNotVisible(auth)
  return resolveWorkspaceRoot(workspaceName) ?? robotNotVisible(auth)
}

function freshScope(auth: RobotL1AuthContext): CallScopeSnapshot | AutomationC3ToolResult {
  const scope = freshRobotScope(auth)
  return scope === 'changed' || scope === 'unbound' ? robotScopeChanged() : scope
}

function isToolResult(value: unknown): value is AutomationC3ToolResult {
  return typeof value === 'object' && value !== null && 'content' in value
}

function resolveExplicitWorkspace(
  auth: RobotL1AuthContext,
  workspaceName: string,
): { scope: CallScopeSnapshot; workspacePath: string } | AutomationC3ToolResult {
  const scope = freshScope(auth)
  if (isToolResult(scope)) return scope
  const workspacePath = workspacePathFor(auth, scope, workspaceName)
  if (isToolResult(workspacePath)) return workspacePath
  return { scope, workspacePath }
}

function resolveIntentWorkspace(
  auth: RobotL1AuthContext,
  intentId: string,
):
  | { scope: CallScopeSnapshot; workspacePath: string; workspaceName: string }
  | AutomationC3ToolResult {
  const scope = freshScope(auth)
  if (isToolResult(scope)) return scope
  const intent = getIntent(intentId)
  if (!intent || !isWorkspaceInDetail(scope, intent.workspaceName)) return robotNotVisible(auth)
  const workspacePath = resolveWorkspaceRoot(intent.workspaceName)
  if (!workspacePath) return robotNotVisible(auth)
  return { scope, workspacePath, workspaceName: intent.workspaceName }
}

function resolveDiscussionWorkspace(
  auth: RobotL1AuthContext,
  discussionId: string,
):
  | { scope: CallScopeSnapshot; workspacePath: string; workspaceName: string }
  | AutomationC3ToolResult {
  const scope = freshScope(auth)
  if (isToolResult(scope)) return scope
  const discussion = getDiscussion(discussionId)
  if (!discussion || !isWorkspaceInDetail(scope, discussion.workspaceName)) {
    return robotNotVisible(auth)
  }
  const workspacePath = resolveWorkspaceRoot(discussion.workspaceName)
  if (!workspacePath) return robotNotVisible(auth)
  return { scope, workspacePath, workspaceName: discussion.workspaceName }
}

type IntentBatchOwnershipArgs = {
  intents?: ReadonlyArray<{ id?: string; dependsOn?: readonly string[] }>
}

function intentBatchVisible(args: unknown, workspaceName: string): boolean {
  for (const item of (args as IntentBatchOwnershipArgs)?.intents ?? []) {
    const ids = [...(item.id ? [item.id] : []), ...(item.dependsOn ?? [])]
    for (const id of ids) {
      const intent = getIntent(id)
      if (!intent || intent.workspaceName !== workspaceName) return false
    }
  }
  return true
}

function stripRobotSaveArgs(args: SaveArgs): SaveArgs {
  return {
    intents: args.intents.map(({ intentSessionId: _dropped, ...intent }) => intent),
  }
}

async function runStartSession(
  workspacePath: string,
  args: StartSessionArgs,
  deps: SessionLaunchDeps,
): Promise<AutomationC3ToolResult> {
  try {
    const result: SessionLaunchResult =
      args.sessionType === 'work'
        ? await launchWorkSession(workspacePath, args.intentId, deps)
        : await launchSpecSession(workspacePath, args.intentId, deps)
    if (result.success) {
      return {
        content: text(
          JSON.stringify({
            sessionId: result.sessionId,
            sessionType: args.sessionType,
            mode: result.mode,
          }),
        ),
      }
    }
    const payload: Record<string, unknown> = { code: result.code }
    if (result.params) payload.params = result.params
    return { content: text(JSON.stringify(payload)), isError: true }
  } catch (err) {
    return {
      content: text(
        JSON.stringify({ code: 'intent.launchInternalError', params: { message: String(err) } }),
      ),
      isError: true,
    }
  }
}

function tool(
  name: RobotWriteToolName,
  description: string,
  inputSchema: ZodRawShape,
  handler: AutomationC3Tool['handler'],
): AutomationC3Tool {
  return { name, description, inputSchema, handler }
}

export function buildRobotWriteTools(
  auth: RobotL1AuthContext,
  getRunId: () => string,
  getDeps: RobotWriteDeps,
): AutomationC3Tool[] {
  return [
    tool(
      'save_intents',
      `${saveDesc}机器人调用还必须显式给出当前可见的 workspaceName,且不得携带会话回链。`,
      { workspaceName: workspaceNameField, ...saveSchema },
      async (raw) => {
        const args = raw as SaveArgs & ExplicitWorkspaceArgs
        const target = resolveExplicitWorkspace(auth, args.workspaceName)
        if (isToolResult(target)) return target
        if (!intentBatchVisible(args, args.workspaceName)) return robotNotVisible(auth)
        const deps = getDeps()
        if (!deps) return depsNotReady()
        return runSaveConfirmed(
          target.workspacePath,
          stripRobotSaveArgs(args),
          deps.broadcastIntents,
          target.scope.subject,
          target.scope.subject,
        )
      },
    ),
    tool(
      'save_intent_directly',
      `${saveIntentDirectlyDesc}机器人调用必须显式给出当前可见的 workspaceName。`,
      { workspaceName: workspaceNameField, ...saveIntentDirectlySchema },
      async (raw) => {
        const args = raw as SaveIntentDirectlyArgs & ExplicitWorkspaceArgs
        const target = resolveExplicitWorkspace(auth, args.workspaceName)
        if (isToolResult(target)) return target
        if (!intentBatchVisible(args, args.workspaceName)) return robotNotVisible(auth)
        const deps = getDeps()
        if (!deps) return depsNotReady()
        const { workspaceName: _workspaceName, ...coreArgs } = args
        return runSaveIntentDirectly(
          target.workspacePath,
          coreArgs as SaveIntentDirectlyArgs,
          deps.broadcastIntents,
        )
      },
    ),
    tool(
      'submit_spec_review',
      `${submitSpecReviewDesc}机器人调用需额外指明 intentId。`,
      { intentId: z.string().describe('要提交审核结论的意图 id'), ...submitSpecReviewSchema },
      async (raw) => {
        const args = raw as RobotSpecReviewArgs
        const target = resolveIntentWorkspace(auth, args.intentId)
        if (isToolResult(target)) return target
        const deps = getDeps()
        if (!deps) return depsNotReady()
        const intent = getIntent(args.intentId)
        const fingerprint = intent
          ? readSpecFingerprint(target.workspacePath, intent.specPath)
          : null
        if (fingerprint === null) {
          return { content: text('spec 当前不可读,结论未记录。'), isError: true }
        }
        return runSubmitSpecReview(
          target.workspacePath,
          { intentId: args.intentId, sessionId: getRunId(), fingerprint },
          { verdict: args.verdict, reason: args.reason },
        )
      },
    ),
    tool('start_session_for_intent', startSessionDesc, startSessionSchema, async (raw) => {
      const args = raw as StartSessionArgs
      const target = resolveIntentWorkspace(auth, args.intentId)
      if (isToolResult(target)) return target
      const deps = getDeps()
      if (!deps) return depsNotReady()
      return runStartSession(target.workspacePath, args, {
        launchRun: deps.launchRun,
        broadcastIntents: deps.broadcastIntents,
      })
    }),
    tool('start_discussion', startDiscussionDesc, startDiscussionSchema, async (raw) => {
      const args = raw as StartDiscussionArgs
      const target = resolveDiscussionWorkspace(auth, args.discussionId)
      if (isToolResult(target)) return target
      const deps = getDeps()
      if (!deps) return depsNotReady()
      return runStartDiscussion(target.workspacePath, args, {
        hasDiscussionRun,
        startDiscussionRun: deps.startDiscussionRun,
      })
    }),
    tool('continue_discussion', continueDiscussionDesc, continueDiscussionSchema, async (raw) => {
      const args = raw as ContinueDiscussionArgs
      const target = resolveDiscussionWorkspace(auth, args.discussionId)
      if (isToolResult(target)) return target
      const deps = getDeps()
      if (!deps) return depsNotReady()
      return runContinueDiscussion(target.workspacePath, args, {
        hasDiscussionRun,
        startDiscussionRun: deps.startDiscussionRun,
        broadcastDiscussionMessage: deps.broadcastDiscussionMessage,
        broadcastDiscussions: deps.broadcastDiscussions,
      })
    }),
  ]
}
