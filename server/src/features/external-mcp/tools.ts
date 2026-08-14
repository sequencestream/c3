/**
 * The EXTERNALLY-GRANTABLE capability catalog — the closed set of c3 tools a
 * long-lived API key may ever be authorized to call on `/mcp/<api-key>`.
 *
 * The catalog is an explicit ALLOWLIST, not "the internal tool universe minus a
 * denylist". That direction is the whole safety property: adding a new internal
 * tool (a write, a session launcher, a review submission) cannot leak outward by
 * omission — it has to be named here AND graded, and the compile-time check at
 * the bottom pins the built catalog to the names declared in the shared protocol.
 *
 * Being IN the catalog is not authorization. It only means an administrator MAY
 * tick it for a key. What one key can actually call is that key's own `tools`
 * scope, which the transport applies; the catalog decides what the picker can
 * ever offer. The catalog is also decoupled from what a NEW key starts with
 * (`EXTERNAL_MCP_DEFAULT_TOOLS`): a read-graded tool can be grantable without
 * being granted by default — that is how the delivery read tools ship.
 *
 * Grading is by real effect, not by intent: `read` never mutates the intent
 * ledger, discussions, specs or session lifecycle. `publish_event` stays `read`
 * because it delivers a fact with a server-derived workspace and source and
 * cannot itself edit state — subscribed automations reacting to it is the tool's
 * own documented semantics, which an administrator granting a key must know.
 *
 * Tool BEHAVIOUR is the same `run*` core the internal surfaces call, so an
 * external caller never observes different rules from an internal one; only the
 * binding differs. The binding comes from the authenticated request
 * ({@link ExternalMcpScope}) rather than from a run closure — an external caller
 * has no run.
 */
import type { ZodRawShape } from 'zod'
import { z } from 'zod'
import type { Intent } from '@ccc/shared/protocol'
import { canonicalizeWorkspacePath } from '../../kernel/config/mcp-api-keys.js'
import { workspaceNameToCanonicalPath } from './workspace-scope.js'
import {
  findDesc,
  findSchema,
  runFind,
  runSaveConfirmed,
  runSaveIntentDirectly,
  runView,
  saveDesc,
  saveIntentDirectlyDesc,
  saveIntentDirectlySchema,
  saveSchema,
  viewDesc,
  viewSchema,
  type FindArgs,
  type SaveArgs,
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
  publishEventDesc,
  publishEventSchema,
  runPublishEvent,
  type PublishEventArgs,
} from '../events/tool-defs.js'
import {
  readSpecFingerprint,
  runSubmitSpecReview,
  submitSpecReviewDesc,
  submitSpecReviewSchema,
  type SubmitSpecReviewArgs,
} from '../intents/spec-review.js'
import { getIntent } from '../intents/store.js'
import {
  launchSpecSession,
  launchWorkSession,
  type SessionLaunchDeps,
  type SessionLaunchResult,
} from '../intents/session-launcher.js'
import {
  EXTERNAL_MCP_DEFAULT_TOOLS,
  EXTERNAL_MCP_READ_TOOLS,
  EXTERNAL_MCP_WRITE_TOOLS,
  type Discussion,
  type DiscussionMessage,
  type ExternalMcpToolAccess,
  type ExternalMcpToolDescriptor,
  type ExternalMcpToolName,
} from '@ccc/shared/protocol'
import type { GenericEvent, GenericEventEnvelope } from '@ccc/shared'
import type { NormalizeResult } from '../../kernel/events/generic-event.js'

/**
 * What one authenticated external request acts on: the workspace resolved from
 * the key's binding, the key id that answered, and the tool scope that key was
 * granted. All three are server-derived — the caller supplies only a key.
 */
export interface ExternalMcpScope {
  workspacePath: string
  keyId: string
  /** The names this key may call; anything outside it is refused by the transport. */
  tools: readonly string[]
}

/** Composition-root callbacks the external tool handlers need at dispatch time. */
export interface ExternalMcpToolDeps {
  /** Normalize an untrusted event core through the kernel normalizer registry. */
  normalizeEvent: (core: GenericEvent) => NormalizeResult
  /** Deliver a normalized event envelope onto the event bus. */
  publishEvent: (payload: GenericEventEnvelope) => void
  /** Refresh a workspace's intent list to every connection. */
  broadcastIntents: (workspacePath: string) => void
  /** Refresh a workspace's discussion list to every connection. */
  broadcastDiscussions: (workspacePath: string) => void
  /** Stream one appended discussion message to every connection. */
  broadcastDiscussionMessage: (discussionId: string, message: DiscussionMessage) => void
  /** Start (or resume) a background discussion orchestration run. */
  startDiscussionRun: (discussion: Discussion) => void
  /** Start an agent run — what makes `start_session_for_intent` actually launch. */
  readonly launchRun: SessionLaunchDeps['launchRun']
}

/**
 * The framing-free result shape every c3 tool core already returns. A type alias
 * rather than an interface so it keeps its implicit index signature and stays
 * assignable to the MCP SDK's `CallToolResult` without a cast.
 */
export type ExternalToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** One catalog entry: wire identity + grading + zod input shape + a scope-bound handler. */
export interface ExternalMcpTool {
  name: ExternalMcpToolName
  /**
   * Derived from the shared read/write name lists, never written per entry: one
   * source for grading means a tool cannot be listed under the write section here
   * and still land in the default read-only scope.
   */
  access: ExternalMcpToolAccess
  description: string
  inputSchema: ZodRawShape
  handler: (args: unknown) => ExternalToolResult | Promise<ExternalToolResult>
}

/** A catalog entry before its grading is attached. */
type ExternalMcpToolSpec = Omit<ExternalMcpTool, 'access'>

/**
 * The stable source identity an external call is attributed to. It names the
 * KEY, never a run — an external caller has no session, and letting it choose one
 * would let it forge provenance on the bus and in the intent log.
 */
export function externalMcpSourceId(keyId: string): string {
  return `external-mcp:${keyId}`
}

const text = (s: string): ExternalToolResult['content'] => [{ type: 'text' as const, text: s }]

/**
 * Build the WHOLE catalog bound to ONE authenticated request scope. Filtering to
 * the key's granted subset is the transport's job — keeping the two apart means
 * the catalog cannot quietly become "whatever this key happens to have".
 */
export function buildExternalMcpCatalog(
  scope: ExternalMcpScope,
  deps: ExternalMcpToolDeps,
): ExternalMcpTool[] {
  return buildToolSpecs(scope, deps).map((spec) => ({ ...spec, access: accessOf(spec.name) }))
}

function buildToolSpecs(scope: ExternalMcpScope, deps: ExternalMcpToolDeps): ExternalMcpToolSpec[] {
  const sourceId = externalMcpSourceId(scope.keyId)
  // Discussion run controls: the live-run guard is feature-private, the starter
  // and broadcasts come from the composition root.
  const runStarter = {
    hasDiscussionRun,
    startDiscussionRun: (discussion: Discussion) => deps.startDiscussionRun(discussion),
  }
  const sessionLaunchDeps: SessionLaunchDeps = {
    launchRun: (rt, prompt, images, inject) => deps.launchRun(rt, prompt, images, inject),
    broadcastIntents: (path) => deps.broadcastIntents(path),
  }
  return [
    // ---- read ----
    {
      name: 'find_intents',
      description: findDesc,
      inputSchema: findSchema,
      handler: (args) => runFind(scope.workspacePath, args as FindArgs),
    },
    {
      name: 'view_intent',
      description: viewDesc,
      inputSchema: viewSchema,
      handler: (args) => runView(scope.workspacePath, args as ViewArgs),
    },
    {
      name: 'find_discussions',
      description: findDiscussionsDesc,
      inputSchema: findDiscussionsSchema,
      handler: (args) => runFindDiscussions(scope.workspacePath, args as FindDiscussionsArgs),
    },
    {
      name: 'view_discussion',
      description: viewDiscussionDesc,
      inputSchema: viewDiscussionSchema,
      handler: (args) => runViewDiscussion(scope.workspacePath, args as ViewDiscussionArgs),
    },
    // Delivery tools are read-only and, unlike the other read entries, are NOT in
    // the default scope of a new key: a fresh key must not silently gain the
    // ability to read a workspace's delivery plan. There is no write counterpart.
    {
      name: 'find_deliveries',
      description: findDeliveriesDesc,
      inputSchema: findDeliveriesSchema,
      handler: (args) => runFindDeliveries(scope.workspacePath, args as FindDeliveriesArgs),
    },
    {
      name: 'view_delivery',
      description: viewDeliveryDesc,
      inputSchema: viewDeliverySchema,
      handler: (args) => runViewDelivery(scope.workspacePath, args as ViewDeliveryArgs),
    },
    {
      name: 'publish_event',
      description: publishEventDesc,
      inputSchema: publishEventSchema,
      // The envelope's workspace and source come from the authenticated scope,
      // never from the arguments: an external caller can describe an event but
      // cannot decide which workspace hears it or whom it appears to come from.
      handler: (args) =>
        runPublishEvent(args as PublishEventArgs, deps.normalizeEvent, (event) =>
          deps.publishEvent({
            workspacePath: scope.workspacePath,
            sessionId: sourceId,
            event,
          }),
        ),
    },

    // ---- write ----
    {
      name: 'save_intents',
      description: saveDesc,
      inputSchema: saveSchema,
      // Interactively this tool is gated by the user's textual go-ahead in the
      // conversation. An unattended external caller has no conversation partner,
      // so the administrator's decision to tick this tool for this key IS the
      // authorization. That replaces the confirmation gate and nothing else: the
      // batch still goes through the store's own atomic validation and the same
      // intent-state rules.
      handler: (args) =>
        runSaveConfirmed(scope.workspacePath, stripSessionBackLinks(args as SaveArgs), (path) =>
          deps.broadcastIntents(path),
        ),
    },
    {
      name: 'save_intent_directly',
      description: saveIntentDirectlyDesc,
      inputSchema: saveIntentDirectlySchema,
      handler: (args) =>
        runSaveIntentDirectly(scope.workspacePath, args as SaveIntentDirectlyArgs, (path) =>
          deps.broadcastIntents(path),
        ),
    },
    {
      name: 'submit_spec_review',
      description: `${submitSpecReviewDesc}外部调用需指明 intentId(内部审核会话由启动绑定,无需传)。`,
      // The internal reviewer never names its intent — the launch binds it. An
      // external caller has no launch, so the intent IS an argument here; every
      // other rule (verdict enum, non-empty reason, rework counting, idempotency)
      // is the shared core's.
      inputSchema: {
        intentId: z.string().describe('要提交审核结论的意图 id'),
        ...submitSpecReviewSchema,
      },
      handler: (args) =>
        runExternalSpecReview(scope, args as SubmitSpecReviewArgs & { intentId: string }),
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
      handler: (args) =>
        runStartSession(scope.workspacePath, args as StartSessionArgs, sessionLaunchDeps),
    },
    {
      name: 'start_discussion',
      description: startDiscussionDesc,
      inputSchema: startDiscussionSchema,
      handler: (args) =>
        runStartDiscussion(scope.workspacePath, args as StartDiscussionArgs, runStarter),
    },
    {
      name: 'continue_discussion',
      description: continueDiscussionDesc,
      inputSchema: continueDiscussionSchema,
      handler: (args) =>
        runContinueDiscussion(scope.workspacePath, args as ContinueDiscussionArgs, {
          ...runStarter,
          broadcastDiscussionMessage: (id, message) => deps.broadcastDiscussionMessage(id, message),
          broadcastDiscussions: (path) => deps.broadcastDiscussions(path),
        }),
    },
  ]
}

/**
 * Drop any `intentSessionId` an external batch carries.
 *
 * Interactively the server OVERWRITES this field with the live run id, so the
 * back-link always resolves. Externally there is no run to link to, and honouring
 * a caller-supplied id would let it point a stored intent at somebody else's
 * session. Removing it is the only truthful option.
 */
function stripSessionBackLinks(args: SaveArgs): SaveArgs {
  if (!args?.intents?.some((intent) => intent.intentSessionId !== undefined)) return args
  return {
    intents: args.intents.map(({ intentSessionId: _dropped, ...rest }) => rest),
  }
}

/**
 * True when the intent's owning project is the workspace the key is bound to.
 * The wire `Intent.workspaceName` is the immutable workspace name, so ownership is
 * resolved back to a canonical path and compared with the canonicalized scope
 * path — the same equivalence the workspace registry itself uses.
 */
function intentInWorkspace(workspacePath: string, intent: Intent): boolean {
  const owned = workspaceNameToCanonicalPath(intent.workspaceName)
  return owned !== null && owned === canonicalizeWorkspacePath(workspacePath)
}

/**
 * Submit a review conclusion from outside.
 *
 * The internal reviewer's anti-stale guard compares the spec content captured
 * when its review session was LAUNCHED against the content at submit time, so an
 * edit mid-review invalidates the judgement. An external caller has no launch
 * instant, so there is nothing to anchor to: the conclusion binds to the content
 * as it reads at submit time. That is weaker by nature, not by omission — c3
 * cannot know when an outside process started reading. Everything else (intent
 * must exist and belong to this key's workspace, spec must be readable,
 * duplicate submissions do not re-count) is the shared core's, unchanged.
 */
function runExternalSpecReview(
  scope: ExternalMcpScope,
  args: SubmitSpecReviewArgs & { intentId: string },
): ExternalToolResult {
  const intent = getIntent(args.intentId)
  if (!intent || !intentInWorkspace(scope.workspacePath, intent)) {
    return { content: text('待审核的意图不存在,结论未记录。'), isError: true }
  }
  const live = readSpecFingerprint(scope.workspacePath, intent.specPath)
  if (live === null) return { content: text('spec 当前不可读,结论未记录。'), isError: true }
  return runSubmitSpecReview(
    scope.workspacePath,
    { intentId: args.intentId, sessionId: externalMcpSourceId(scope.keyId), fingerprint: live },
    { verdict: args.verdict, reason: args.reason },
  )
}

type StartSessionArgs = { intentId: string; sessionType: 'spec' | 'work' }

/** Launch a spec/work session for one intent, reporting failures as JSON tool errors. */
async function runStartSession(
  workspacePath: string,
  args: StartSessionArgs,
  deps: SessionLaunchDeps,
): Promise<ExternalToolResult> {
  // The launcher binds by intentId but acts on `workspacePath`; an intent from
  // another workspace must not be reachable through this key's scope.
  const intent = getIntent(args.intentId)
  if (!intent || !intentInWorkspace(workspacePath, intent)) {
    return {
      content: text(JSON.stringify({ code: 'intent.notFound' })),
      isError: true,
    }
  }
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
    const errorPayload: Record<string, unknown> = { code: result.code }
    if (result.params) errorPayload.params = result.params
    return { content: text(JSON.stringify(errorPayload)), isError: true }
  } catch (err) {
    return {
      content: text(
        JSON.stringify({ code: 'intent.launchInternalError', params: { message: String(err) } }),
      ),
      isError: true,
    }
  }
}

/**
 * The catalog as the console sees it: name + grading only. The description, the
 * schema and the handler stay server-side — an authorization UI needs neither,
 * and shipping the agent-facing prose to the browser would only invite it to be
 * treated as user copy.
 */
export function externalMcpToolDescriptors(): ExternalMcpToolDescriptor[] {
  return EXTERNAL_MCP_TOOL_ORDER.map((name) => ({ name, access: accessOf(name) }))
}

/** Whether a name is externally grantable at all. */
export function isExternalMcpToolName(name: string): name is ExternalMcpToolName {
  return (EXTERNAL_MCP_TOOL_ORDER as readonly string[]).includes(name)
}

/**
 * Normalize a submitted tool scope, or report the first name that disqualifies it.
 * An unknown name or a repeat fails the WHOLE scope: a partially applied
 * authorization would read to the administrator as the one they submitted.
 */
export function normalizeExternalMcpToolScope(
  names: readonly string[],
): { ok: true; tools: ExternalMcpToolName[] } | { ok: false; offender: string } {
  const out: ExternalMcpToolName[] = []
  for (const raw of names) {
    const name = typeof raw === 'string' ? raw.trim() : ''
    if (!isExternalMcpToolName(name) || out.includes(name))
      return { ok: false, offender: String(raw) }
    out.push(name)
  }
  // Store in catalog order so two equivalent scopes are also equal on disk.
  return { ok: true, tools: EXTERNAL_MCP_TOOL_ORDER.filter((n) => out.includes(n)) }
}

/** The catalog's declared order: read tools first, then write tools. */
const EXTERNAL_MCP_TOOL_ORDER: readonly ExternalMcpToolName[] = [
  ...EXTERNAL_MCP_READ_TOOLS,
  ...EXTERNAL_MCP_WRITE_TOOLS,
]

function accessOf(name: ExternalMcpToolName): ExternalMcpToolAccess {
  return (EXTERNAL_MCP_READ_TOOLS as readonly string[]).includes(name) ? 'read' : 'write'
}

// Compile-time catalog pin: the built set must cover every declared name and
// introduce none of its own. A tool added to the builder without being declared
// in the shared protocol (or vice versa) fails typecheck rather than shipping
// silently — in either direction, since either drift is a surface bug.
type BuiltNames = ReturnType<typeof buildExternalMcpCatalog>[number]['name']
type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _catalogIsExact: AssertSame<BuiltNames, ExternalMcpToolName> = true
void _catalogIsExact

// Compile-time default-scope pin: the catalog and the default set are decoupled
// (a grantable read tool need not be granted by default), but the default set may
// never contain a WRITE tool — that direction would hand every fresh key a
// mutation it was never authorized for.
type AssertExtends<A extends B, B> = [A, B] extends [B, B] ? true : never
const _defaultsAreReadGraded: AssertExtends<
  (typeof EXTERNAL_MCP_DEFAULT_TOOLS)[number],
  (typeof EXTERNAL_MCP_READ_TOOLS)[number]
> = true
void _defaultsAreReadGraded
