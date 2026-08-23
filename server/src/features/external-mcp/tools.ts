/**
 * The EXTERNALLY-GRANTABLE capability catalog — the closed set of c3 tools a
 * long-lived API key may ever be authorized to call on `POST /mcp`.
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
 * binding differs. The binding comes from the authenticated request — the
 * {@link EffectiveScope} the gate produced for THIS call — rather than from a run
 * closure; an external caller has no run.
 *
 * The catalog closes over NO scope. Every handler receives the scope as an
 * argument, so a write that names another workspace is served by the same entry
 * under a freshly authorized scope, and there is no closure left holding the
 * workspace a session happened to initialize with.
 */
import type { ZodRawShape } from 'zod'
import { z } from 'zod'
import type { Intent } from '@ccc/shared/protocol'
import { canonicalizeWorkspacePath } from '../../kernel/config/mcp-api-keys.js'
import { listWorkspacesForSubject, type EffectiveScope } from '../auth/authorization.js'
import { workspaceNameToCanonicalPath } from './workspace-scope.js'
import {
  findDesc,
  findSchema,
  runFind,
  runSaveConfirmed,
  runSaveIntentDirectly,
  runView,
  saveCoreDesc,
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
import { getDiscussion } from '../discussions/store.js'
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
  EXTERNAL_MCP_TOOL_NAMES,
  type Discussion,
  type DiscussionMessage,
  type ExternalMcpToolAccess,
  type ExternalMcpToolDescriptor,
  type ExternalMcpToolName,
} from '@ccc/shared/protocol'
import type { GenericEvent, GenericEventEnvelope } from '@ccc/shared'
import type { NormalizeResult } from '../../kernel/events/generic-event.js'

/**
 * What one authenticated external CALL acts on. It is the gate's own frozen
 * result, re-derived per call — never a session-lifetime value and never
 * anything the caller supplied. Aliased rather than re-declared so a field can
 * not drift away from what `authorizeCall` actually decided.
 */
export type ExternalMcpScope = EffectiveScope

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

/** One catalog entry: wire identity + grading + zod input shape + a scope-taking handler. */
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
  /**
   * Refuse the call BEFORE the business core runs, returning the tool text to
   * answer with. This is where an id whose real owner is another workspace is
   * caught: the dispatcher reports it as a `rejected` write, so it is
   * distinguishable in the audit trail from a handler that ran and failed.
   */
  validate?: (args: unknown, scope: ExternalMcpScope) => string | null
  handler: (
    args: unknown,
    scope: ExternalMcpScope,
  ) => ExternalToolResult | Promise<ExternalToolResult>
}

/** A catalog entry before its grading (and the write-only workspace override) is attached. */
type ExternalMcpToolSpec = Omit<ExternalMcpTool, 'access'>

/**
 * The stable source identity an external call is attributed to. It names the
 * KEY and the workspace the call was authorized against — never a run, because
 * an external caller has no session and letting it choose one would let it forge
 * provenance on the bus and in the intent log. The workspace is part of the id
 * so events from ONE range-scoped key stay attributable when that key operates
 * across several workspaces.
 */
export function externalMcpSourceId(keyId: string, workspaceName: string): string {
  return `external-mcp:${keyId}@${workspaceName}`
}

const text = (s: string): ExternalToolResult['content'] => [{ type: 'text' as const, text: s }]
const ok = (s: string): ExternalToolResult => ({ content: text(s) })

/**
 * The optional per-call workspace override, attached to EVERY write entry and to
 * no read entry. Centralized rather than repeated per tool: the two grades are
 * derived from one name list, so "which tools accept an override" cannot drift
 * away from "which tools are writes".
 */
const workspaceOverrideField = z
  .string()
  .optional()
  .describe(
    '可选:本次调用的目标工作区名称,必须是 list_workspaces 返回的名字之一;' +
      '省略则使用建立连接时 X-C3-Workspace 选定的工作区。' +
      '范围外或不存在的名字一律拒绝,不会改写为任何其它工作区。',
  )

/**
 * Build the WHOLE catalog. It closes over the composition root's callbacks and
 * over NOTHING about who is calling: the scope arrives per call, so one built
 * catalog serves every key, every session and every workspace.
 *
 * Filtering to the key's granted subset is the transport's job — keeping the two
 * apart means the catalog cannot quietly become "whatever this key happens to
 * have".
 */
export function buildExternalMcpCatalog(deps: ExternalMcpToolDeps): ExternalMcpTool[] {
  return buildToolSpecs(deps).map((spec) => {
    const access = accessOf(spec.name)
    return access === 'write'
      ? {
          ...spec,
          access,
          inputSchema: { ...spec.inputSchema, workspaceName: workspaceOverrideField },
        }
      : { ...spec, access }
  })
}

function buildToolSpecs(deps: ExternalMcpToolDeps): ExternalMcpToolSpec[] {
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
      handler: (args, scope) => runFind(scope.workspacePath, args as FindArgs),
    },
    {
      name: 'view_intent',
      description: viewDesc,
      inputSchema: viewSchema,
      handler: (args, scope) => runView(scope.workspacePath, args as ViewArgs),
    },
    {
      name: 'find_discussions',
      description: findDiscussionsDesc,
      inputSchema: findDiscussionsSchema,
      handler: (args, scope) =>
        runFindDiscussions(scope.workspacePath, args as FindDiscussionsArgs),
    },
    {
      name: 'view_discussion',
      description: viewDiscussionDesc,
      inputSchema: viewDiscussionSchema,
      handler: (args, scope) => runViewDiscussion(scope.workspacePath, args as ViewDiscussionArgs),
    },
    // Delivery tools are read-only and, unlike the other read entries, are NOT in
    // the default scope of a new key: a fresh key must not silently gain the
    // ability to read a workspace's delivery plan. There is no write counterpart.
    {
      name: 'find_deliveries',
      description: findDeliveriesDesc,
      inputSchema: findDeliveriesSchema,
      handler: (args, scope) => runFindDeliveries(scope.workspacePath, args as FindDeliveriesArgs),
    },
    {
      name: 'view_delivery',
      description: viewDeliveryDesc,
      inputSchema: viewDeliverySchema,
      handler: (args, scope) => runViewDelivery(scope.workspacePath, args as ViewDeliveryArgs),
    },
    {
      name: 'list_workspaces',
      description: listWorkspacesDesc,
      inputSchema: {},
      handler: (_args, scope) =>
        ok(JSON.stringify({ workspaces: reachableWorkspaceNames(scope) }, null, 2)),
    },
    {
      name: 'whoami',
      description: whoamiDesc,
      inputSchema: {},
      // Owner, reach and granted tools — the three answers a caller would
      // otherwise guess by probing. Never a path, never anything about the key
      // beyond its non-secret id: this tool exists to remove the need for
      // enumeration, not to become an enumeration surface of its own.
      handler: (_args, scope) =>
        ok(
          JSON.stringify(
            {
              keyId: scope.keyId,
              owner: scope.ownerSubject,
              workspace: scope.workspaceName,
              workspaces: reachableWorkspaceNames(scope),
              tools: [...scope.tools],
            },
            null,
            2,
          ),
        ),
    },
    {
      name: 'publish_event',
      description: publishEventDesc,
      inputSchema: publishEventSchema,
      // The envelope's workspace and source come from the authenticated scope,
      // never from the arguments: an external caller can describe an event but
      // cannot decide which workspace hears it or whom it appears to come from.
      // Whatever workspace/session/source fields the payload carries stay inside
      // the event body as ordinary (normalized) data — nothing is copied out of
      // it into the envelope.
      handler: (args, scope) =>
        runPublishEvent(args as PublishEventArgs, deps.normalizeEvent, (event) =>
          deps.publishEvent({
            workspacePath: scope.workspacePath,
            sessionId: externalMcpSourceId(scope.keyId, scope.workspaceName),
            event,
          }),
        ),
    },

    // ---- write ----
    {
      name: 'save_intents',
      description:
        saveCoreDesc +
        '外部 MCP 没有逐次对话确认;管理员为当前 key 授予本写工具即构成调用授权,且不放宽任何业务校验。',
      inputSchema: saveSchema,
      // Every id the batch names — the upsert targets AND the dependency
      // references that get persisted as edges — must already belong to this
      // call's workspace. Checked as a whole before anything is written, so a
      // batch carrying one foreign id lands nothing at all.
      validate: (args, scope) => validateIntentBatchOwnership(args, scope),
      // Interactively this tool is gated by the user's textual go-ahead in the
      // conversation. An unattended external caller has no conversation partner,
      // so the administrator's decision to tick this tool for this key IS the
      // authorization. That replaces the confirmation gate and nothing else: the
      // batch still goes through the store's own atomic validation and the same
      // intent-state rules.
      handler: (args, scope) =>
        runSaveConfirmed(scope.workspacePath, stripSessionBackLinks(args as SaveArgs), (path) =>
          deps.broadcastIntents(path),
        ),
    },
    {
      name: 'save_intent_directly',
      description: saveIntentDirectlyDesc,
      inputSchema: saveIntentDirectlySchema,
      // Create-only, so there is no upsert target to own — but `dependsOn` is
      // the same persisted edge `save_intents` guards, and an unguarded one here
      // would be the whole cross-workspace write this rule exists to stop,
      // reachable through the OTHER intent-writing tool.
      validate: (args, scope) => validateIntentBatchOwnership(args, scope),
      handler: (args, scope) =>
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
      validate: (args, scope) =>
        intentOwnedByScope((args as { intentId: string }).intentId, scope)
          ? null
          : SPEC_REVIEW_INTENT_NOT_FOUND,
      handler: (args, scope) =>
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
      // Before ANY launch gate is evaluated and before a worktree is prepared:
      // an intent from another workspace must not reach the launcher at all.
      validate: (args, scope) =>
        intentOwnedByScope((args as StartSessionArgs).intentId, scope)
          ? null
          : JSON.stringify({ code: 'intent.notFound' }),
      handler: (args, scope) =>
        runStartSession(scope.workspacePath, args as StartSessionArgs, sessionLaunchDeps),
    },
    {
      name: 'start_discussion',
      description: startDiscussionDesc,
      inputSchema: startDiscussionSchema,
      // The core refuses a foreign discussion too, but only AFTER the call has
      // entered it — which the audit trail would then record as a `failure`, the
      // classification reserved for a handler that ran. An ownership mismatch is
      // a `rejected`, here as in `continue_discussion`: one kind of refusal must
      // not read as two depending on which tool the caller picked.
      validate: (args, scope) => {
        const id = (args as StartDiscussionArgs).discussionId
        return discussionOwnedByScope(id, scope) ? null : discussionNotFound(id)
      },
      handler: (args, scope) =>
        runStartDiscussion(scope.workspacePath, args as StartDiscussionArgs, runStarter),
    },
    {
      name: 'continue_discussion',
      description: continueDiscussionDesc,
      inputSchema: continueDiscussionSchema,
      // Before the message is appended, the status moves, the list is broadcast
      // or a run starts — all four are side effects a mis-owned id must not buy.
      validate: (args, scope) => {
        const id = (args as ContinueDiscussionArgs).discussionId
        return discussionOwnedByScope(id, scope) ? null : discussionNotFound(id)
      },
      handler: (args, scope) =>
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

/** The established in-scope not-found text for an intent id. */
function intentNotFound(id: string): string {
  return `未找到 id 为 ${id} 的意图(本项目)。`
}

/** The established in-scope not-found text for a discussion id. */
function discussionNotFound(id: string): string {
  return `未找到 id 为 ${id} 的讨论(本项目)。`
}

/** `submit_spec_review` answers with its own wording; the intent id is not echoed back. */
const SPEC_REVIEW_INTENT_NOT_FOUND = '待审核的意图不存在,结论未记录。'

/**
 * Whether one persisted intent id is really this call's workspace's.
 *
 * The lookup is GLOBAL on purpose: an id addresses a row, not a workspace, so
 * the only truthful check is "fetch it, then compare its immutable owner". An id
 * that belongs elsewhere is answered exactly like an id that does not exist —
 * the caller must not be able to tell a foreign workspace's ledger apart from an
 * empty one.
 */
function intentOwnedByScope(id: unknown, scope: ExternalMcpScope): boolean {
  if (typeof id !== 'string' || id.length === 0) return false
  const intent = getIntent(id)
  return intent !== null && intent !== undefined && intentInWorkspace(scope.workspacePath, intent)
}

/** The same question for a discussion id. */
function discussionOwnedByScope(id: unknown, scope: ExternalMcpScope): boolean {
  if (typeof id !== 'string' || id.length === 0) return false
  const discussion = getDiscussion(id)
  if (!discussion) return false
  const owned = workspaceNameToCanonicalPath(discussion.workspaceName)
  return owned !== null && owned === canonicalizeWorkspacePath(scope.workspacePath)
}

/**
 * The only part of an intent batch that carries a foreign-id risk, shared by
 * `save_intents` (upsert + deps) and `save_intent_directly` (deps only). Kept
 * structural rather than tied to either arg type so one validator covers both
 * and a third intent writer cannot appear with the check silently missing.
 */
type IntentBatchOwnershipArgs = {
  intents?: ReadonlyArray<{ id?: string; dependsOn?: readonly string[] }>
}

/**
 * Refuse an intent batch that names any intent this workspace does not own — as
 * an upsert target OR as a persisted `dependsOn` reference.
 *
 * Both are ownership questions, not just the obvious one: a dependency edge is
 * persisted, so accepting a foreign id would write a cross-workspace edge into
 * this workspace's graph without ever "updating" the foreign intent. That is why
 * the create-only writer is guarded too — it mints new rows, but the edges those
 * rows carry can still point anywhere. Intra-batch `dependsOnIndexes` are NOT
 * checked here — they address siblings of this very batch, which by construction
 * land in this workspace.
 *
 * The first offending id rejects the WHOLE batch, before any write: partial
 * application of a batch the caller submitted as one unit is not a state c3 will
 * produce.
 */
function validateIntentBatchOwnership(args: unknown, scope: ExternalMcpScope): string | null {
  for (const intent of (args as IntentBatchOwnershipArgs)?.intents ?? []) {
    if (intent.id !== undefined && !intentOwnedByScope(intent.id, scope)) {
      return intentNotFound(String(intent.id))
    }
    for (const dep of intent.dependsOn ?? []) {
      if (!intentOwnedByScope(dep, scope)) return intentNotFound(String(dep))
    }
  }
  return null
}

/**
 * The workspace names this call's principal may reach, in registry order.
 *
 * Derived from the SAME owner-scope resolver `authorizeCall` intersects, never
 * from the workspace the key was filed under and never from the arguments — so
 * "what `list_workspaces` shows" and "what a write override is allowed to name"
 * are one answer. Names only: a path would hand out filesystem layout the wire
 * protocol deliberately keeps server-side.
 */
function reachableWorkspaceNames(scope: ExternalMcpScope): string[] {
  return listWorkspacesForSubject(scope.ownerSubject).map((w) => w.name)
}

const listWorkspacesDesc =
  '列出本 key 当前可访问的工作区名称(只读)。' +
  '返回 JSON:{"workspaces":["…"]},顺序与注册表一致,只含名称、不含任何磁盘路径。' +
  '写工具的 workspaceName 入参必须取自本列表;列表之外的名字一律被拒绝。'

const whoamiDesc =
  '回显本次调用的身份与权限(只读),用于自检而不必靠试错探测。' +
  '返回 JSON:{"keyId","owner","workspace","workspaces":[…],"tools":[…]} —— ' +
  'owner 是该 key 的归属账号,workspace 是本会话选定的工作区,' +
  'workspaces 是当前可访问的全部工作区名,tools 是本 key 实际可调用的工具名。' +
  '不返回任何密钥、哈希、认证头或磁盘路径。'

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
    return { content: text(SPEC_REVIEW_INTENT_NOT_FOUND), isError: true }
  }
  const live = readSpecFingerprint(scope.workspacePath, intent.specPath)
  if (live === null) return { content: text('spec 当前不可读,结论未记录。'), isError: true }
  return runSubmitSpecReview(
    scope.workspacePath,
    {
      intentId: args.intentId,
      sessionId: externalMcpSourceId(scope.keyId, scope.workspaceName),
      fingerprint: live,
    },
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
  // another workspace must not be reachable through this key's scope. The
  // dispatcher already refused that case through this entry's `validate` — this
  // is the in-core backstop, kept so the invariant does not depend on a single
  // call site remembering to ask.
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
const EXTERNAL_MCP_TOOL_ORDER: readonly ExternalMcpToolName[] = EXTERNAL_MCP_TOOL_NAMES

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
