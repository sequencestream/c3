/**
 * The queue advisor's DEDICATED c3 MCP tool group — belt two of the
 * propose-then-validate pair.
 *
 * An advisor agent is consulted at a decision point the deterministic kernel
 * cannot resolve on its own; it reads diagnostics, proposes one structured
 * action, and the kernel executes it only after validation. This module is the
 * execution surface for that.
 *
 * Three properties hold it together:
 *
 *  1. **Not general automation capability.** These tools are built by their own
 *     builder and MUST NOT join `AUTOMATION_C3_TOOL_NAMES`. An ordinary
 *     automation's tool list is unchanged by this module's existence.
 *  2. **Scope lives in the closure.** `workspacePath` and `intentId` are bound
 *     when the group is built. No tool accepts either as an argument, so a model
 *     cannot reach another workspace's or another intent's data by asking.
 *  3. **The gate is re-checked in the tool.** `advisor-validate.ts` screens a
 *     proposal against a fact snapshot; every write tool here re-reads the
 *     authoritative facts and re-applies ownership, status and hard-gate checks
 *     immediately before its side effect. Skipping the validator entirely still
 *     fails, and facts that changed in between are decided by this later check.
 *     A rejection produces no partial write.
 *
 * What is deliberately absent: `approve_spec` (a human checkpoint, offered under
 * no name or alias) and any path to `done` (RM-R9's automated-completion
 * exception belongs to the queue's judge → commit → push path and is not
 * widened here).
 *
 * Framing-free: the composition root injects its callbacks as
 * {@link AdvisorToolDeps}; MCP framing lives in the transport route.
 */
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { ZodRawShape } from 'zod'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import type { IntentStatus } from '@ccc/shared/protocol'
import { ensureRuntime, getRuntime, isRunning, stopRun } from '../../runs.js'
import { loadHistory } from '../../sessions.js'
import { getDefaultMode } from '../../kernel/config/index.js'
import { resolveSessionVendor, setSessionAgent } from '../../kernel/agent-config/index.js'
import { sessionAgentTargetForRole } from '../sessions/agent-target.js'
import { redactSecrets } from '../pr-events/tool-defs.js'
import { upsertBoundRow } from '../sessions/session-metadata-store.js'
import { createEvent, getEventByRequestId } from '../user-involve/store.js'
import { getIntent, isStoreAvailable, setChatSession } from './store.js'
import { registerPendingIntentLink } from './intent-link.js'
import { registerPendingSpecLink } from './spec-link.js'
import { claimSpecOccupancy, releaseSpecOccupancy } from './spec-occupancy.js'
import { resolveSpecFileAbs } from './specs-root.js'
import { buildResetSpecPrompt } from './spec.js'
import { buildResetIntentPrompt } from './reset-prompts.js'
import { syncIntentPrStatus } from './pr-status-sync.js'
import { applyIntentStatusChange, createPrForIntent } from './write-cores.js'
import type { SessionLaunchDeps } from './session-launcher.js'
import { hasPendingQuestion } from './turn-guards.js'
import {
  ADVISOR_MAX_CHAIN_DEPTH,
  advisorActionRequiresConfirmation,
  type AdvisorAction,
  type AdvisorRejectReason,
} from './advisor-validate.js'
import type { GenericEvent } from '@ccc/shared'
import type { NormalizeResult } from '../../kernel/events/generic-event.js'

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/** The scope one advisor consultation is bound to. Never widened by an argument. */
export interface AdvisorScopeBinding {
  workspacePath: string
  /** The intent under consultation — the ONLY intent these tools may touch. */
  intentId: string
  /** Advisor hops that led here; past {@link ADVISOR_MAX_CHAIN_DEPTH} nothing runs. */
  chainDepth: number
  /** The advisor's own run id — where a confirmation prompt is emitted. */
  sessionId: string
}

/** Composition-root callbacks the advisor tool handlers need at dispatch time. */
export interface AdvisorToolDeps {
  broadcastIntents: (workspacePath: string) => void
  /** Re-send a workspace's `todo` wait-user-involve list to every connection. */
  broadcastWaitUserEvents: (workspacePath: string) => void
  /** Start an agent run (the reset tools launch a fresh session). */
  readonly launchRun: SessionLaunchDeps['launchRun']
  normalizeEvent: (core: GenericEvent) => NormalizeResult
  publishEvent: (workspacePath: string, sessionId: string, event: GenericEvent) => void
  /** Domain event for cross-feature subscribers when a status actually changed. */
  publishStatusChanged: (input: {
    intentId: string
    workspacePath: string
    fromStatus: IntentStatus
    toStatus: IntentStatus
  }) => void
  /**
   * The write-approval queue. Resolves `true` ONLY when a human approved this
   * action. Approval never relaxes a gate: the caller still re-validates after
   * it returns.
   */
  requestWriteApproval: (input: {
    toolName: string
    workspacePath: string
    intentId: string
    /** The advisor run the prompt is emitted on. */
    sessionId: string
    input: unknown
  }) => Promise<boolean>
}

/** An MCP tool result. Structurally identical across the Claude SDK and the MCP SDK. */
export interface AdvisorToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** One advisor tool: its wire identity + a handler bound to the consultation. */
export interface AdvisorTool {
  name: string
  description: string
  inputSchema: ZodRawShape
  /** Whether this tool's action goes through the write-approval queue. */
  requiresConfirmation: boolean
  handler: (args: unknown) => Promise<AdvisorToolResult>
}

// ---------------------------------------------------------------------------
// Transcript hygiene
// ---------------------------------------------------------------------------

/** Hard ceiling on a transcript read, in characters, after redaction. */
export const TRANSCRIPT_TAIL_LIMIT = 20_000

/**
 * Redact FIRST, then keep the tail. Doing it in this order matters: truncating
 * first could slice a token in half and smuggle the remaining half past the
 * redactor. The tail is what a diagnosis needs — the newest turns.
 */
export function redactAndTail(text: string, limit = TRANSCRIPT_TAIL_LIMIT): string {
  const redacted = redactSecrets(text)
  if (redacted.length <= limit) return redacted
  return `…(已截断,仅保留最后 ${limit} 字符)\n${redacted.slice(-limit)}`
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

const text = (s: string): AdvisorToolResult['content'] => [{ type: 'text' as const, text: s }]

function ok(payload: unknown): AdvisorToolResult {
  return { content: text(JSON.stringify(payload)) }
}

/**
 * A structured refusal, identical in shape to the validator's — so an agent that
 * learned to read one reads the other, whichever belt stopped it.
 */
function denied(
  reason:
    | AdvisorRejectReason
    | 'approval_denied'
    | 'db_unavailable'
    | 'tool_failed'
    | 'agent_group_unavailable',
  detail: string,
  retryable: boolean,
  constraints?: Record<string, string>,
): AdvisorToolResult {
  return {
    content: text(
      JSON.stringify({ accepted: false, reason, detail, retryable, ...(constraints ?? {}) }),
    ),
    isError: true,
  }
}

// ---------------------------------------------------------------------------
// Server-side re-validation (belt two)
// ---------------------------------------------------------------------------

/** The bound intent's own session ids — the only sessions these tools may name. */
function ownedSessionIds(intentId: string): string[] {
  const intent = getIntent(intentId)
  if (!intent) return []
  return [intent.lastWorkSessionId, intent.specSessionId, intent.intentSessionId].filter(
    (id): id is string => !!id,
  )
}

/**
 * The gate every tool runs before doing anything, re-read from the store rather
 * than trusted from the proposal: chain depth, then the bound intent's existence,
 * then — for session-scoped tools — ownership of the named session.
 */
function guard(
  scope: AdvisorScopeBinding,
  opts: { sessionId?: string } = {},
): AdvisorToolResult | null {
  if (scope.chainDepth > ADVISOR_MAX_CHAIN_DEPTH) {
    return denied(
      'chain_depth_exceeded',
      `顾问调用链深度 ${scope.chainDepth} 超过上限 ${ADVISOR_MAX_CHAIN_DEPTH}`,
      false,
      { maxChainDepth: String(ADVISOR_MAX_CHAIN_DEPTH) },
    )
  }
  if (!isStoreAvailable()) return denied('db_unavailable', '意图账本当前不可用', true)
  if (!getIntent(scope.intentId)) {
    return denied('intent_not_found', '绑定的意图已不存在', false, {
      boundIntentId: scope.intentId,
    })
  }
  if (opts.sessionId !== undefined && !ownedSessionIds(scope.intentId).includes(opts.sessionId)) {
    // An out-of-scope session is REFUSED, never answered with an empty result:
    // a silent blank would read as "nothing there" and hide the over-reach.
    return denied('session_scope_mismatch', '该会话不属于本次顾问绑定的意图', false, {
      boundIntentId: scope.intentId,
    })
  }
  return null
}

/**
 * Run a confirmed action: ask the write-approval queue, then re-run the guard
 * once more. An approval that arrives after the world moved on still cannot
 * execute against stale facts.
 */
async function confirmed(
  scope: AdvisorScopeBinding,
  deps: AdvisorToolDeps,
  toolName: string,
  input: unknown,
  run: () => Promise<AdvisorToolResult>,
): Promise<AdvisorToolResult> {
  const approved = await deps.requestWriteApproval({
    toolName,
    workspacePath: scope.workspacePath,
    intentId: scope.intentId,
    sessionId: scope.sessionId,
    input,
  })
  if (!approved) return denied('approval_denied', '该写操作未获人工批准', true)
  const blocked = guard(scope)
  if (blocked) return blocked
  return run()
}

// ---------------------------------------------------------------------------
// Session resets — framing-free equivalents of the WS handlers
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Start a FRESH intent-communication session replacing the intent's current one.
 * Mirrors the `reset_intent_session` handler minus the per-connection framing
 * (no viewer swap, no `session_selected` — an MCP caller has no connection);
 * the seed prompt, the pending→intent link and the projection write are shared.
 */
function resetIntentSessionCore(
  scope: AdvisorScopeBinding,
  deps: AdvisorToolDeps,
  userInput: string,
): AdvisorToolResult {
  const intent = getIntent(scope.intentId)!
  // The intent role's agent (possibly a group), resolved before the session exists.
  const target = sessionAgentTargetForRole('intent')
  if (!target.ok) {
    return denied('agent_group_unavailable', `agent 组 ${target.groupRef} 无可用成员`, false)
  }
  const chatId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const rt = ensureRuntime(chatId, scope.workspacePath, 'default', [], 'intent')
  setSessionAgent(chatId, target.target.ref)
  setChatSession(scope.workspacePath, chatId, intent.title)
  try {
    upsertBoundRow({
      sessionId: chatId,
      workspacePath: scope.workspacePath,
      vendor: resolveSessionVendor(chatId),
      agentId: target.target.ref,
      title: intent.title,
      sessionKind: 'intent',
      ownerKind: 'intent',
      ownerId: intent.id,
    })
  } catch (err) {
    console.warn(`[c3:advisor] intent session projection write failed: ${errMsg(err)}`)
  }
  registerPendingIntentLink(chatId, intent.id)
  void deps.launchRun(rt, buildResetIntentPrompt(intent, userInput)).catch((err: unknown) => {
    console.warn(`[c3:advisor] reset_intent_session launch failed: ${errMsg(err)}`)
  })
  deps.broadcastIntents(scope.workspacePath)
  return ok({ sessionId: chatId, sessionType: 'intent' })
}

/**
 * Start a FRESH spec-authoring session on the intent's existing spec file.
 * Mirrors the `reset_spec_session` handler minus the per-connection framing.
 * Requires an already-written spec — a reset replaces context, it does not
 * scaffold a spec that was never authored.
 */
function resetSpecSessionCore(
  scope: AdvisorScopeBinding,
  deps: AdvisorToolDeps,
  userInput: string,
): AdvisorToolResult {
  const intent = getIntent(scope.intentId)!
  if (!intent.specPath) {
    return denied('session_required', '该意图尚未编写 spec,无法重置 spec 会话', false)
  }
  const specTarget = sessionAgentTargetForRole('spec')
  if (!specTarget.ok) {
    return denied('agent_group_unavailable', `agent 组 ${specTarget.groupRef} 无可用成员`, false)
  }
  // Claim the authoring slot before creating the runtime (same occupancy the
  // queue and the WS reset handler use). A concurrent launch already holding it
  // is refused rather than double-started.
  const specId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const claim = claimSpecOccupancy(intent.id, specId, {
    workspacePath: scope.workspacePath,
    vendor: specTarget.target.agent.vendor,
    agentId: specTarget.target.ref,
    title: intent.title,
  })
  if (!claim.ok) {
    return claim.owner
      ? denied('concurrency_gate', 'spec 会话正在运行,请等待其结束', false)
      : denied('db_unavailable', 'spec 占用投影写入失败,请稍后重试', true)
  }
  const releaseClaim = (): void => releaseSpecOccupancy(intent.id, specId)

  const fileAbs = resolveSpecFileAbs(scope.workspacePath, intent.specPath)
  const rt = ensureRuntime(
    specId,
    scope.workspacePath,
    getDefaultMode(scope.workspacePath),
    [],
    'spec',
  )
  rt.specDir = dirname(fileAbs)
  setSessionAgent(specId, specTarget.target.ref)
  registerPendingSpecLink(specId, intent.id)
  void deps
    .launchRun(rt, buildResetSpecPrompt(intent, fileAbs, userInput, scope.workspacePath))
    .catch((err: unknown) => {
      releaseClaim()
      console.warn(`[c3:advisor] reset_spec_session launch failed: ${errMsg(err)}`)
    })
  return ok({ sessionId: specId, sessionType: 'spec' })
}

// ---------------------------------------------------------------------------
// The tool group
// ---------------------------------------------------------------------------

const STATUS_VALUES = ['draft', 'todo', 'in_progress', 'cancelled', 'blocked', 'failed'] as const

/**
 * Build the advisor tool group bound to ONE consultation. `deps` may be null
 * before the composition root wires the route (every branch guards with `?.`),
 * which also lets {@link ADVISOR_C3_TOOL_NAMES} derive its list without touching
 * a store.
 */
export function buildAdvisorC3Tools(
  scope: AdvisorScopeBinding,
  deps: AdvisorToolDeps | null,
): AdvisorTool[] {
  const d: AdvisorToolDeps = deps ?? {
    broadcastIntents: () => {},
    broadcastWaitUserEvents: () => {},
    launchRun: () => Promise.resolve(),
    normalizeEvent: () => ({ ok: false, reason: 'advisor deps not wired' }),
    publishEvent: () => {},
    publishStatusChanged: () => {},
    requestWriteApproval: () => Promise.resolve(false),
  }

  const define = (
    action: AdvisorAction,
    description: string,
    inputSchema: ZodRawShape,
    handler: (args: never) => Promise<AdvisorToolResult>,
  ): AdvisorTool => ({
    name: action,
    description,
    inputSchema,
    requiresConfirmation: advisorActionRequiresConfirmation(action),
    handler: handler as (args: unknown) => Promise<AdvisorToolResult>,
  })

  return [
    // ── Reads ──
    define(
      'read_session_transcript',
      '读取绑定意图某个会话的 transcript 尾部,用于根因分析。' +
        '内容先脱敏再按尾部截断;会话不属于绑定意图时直接拒绝(不会返回空结果掩盖越权)。',
      { sessionId: z.string().describe('要读取的会话 id,必须属于绑定的意图') },
      async (args: { sessionId: string }) => {
        const blocked = guard(scope, { sessionId: args.sessionId })
        if (blocked) return blocked
        const rt = getRuntime(args.sessionId)
        const history = await loadHistory(scope.workspacePath, args.sessionId).catch(() => [])
        const lines = history.map((item) => JSON.stringify(item))
        for (const e of rt?.buffer ?? []) lines.push(JSON.stringify(e))
        return ok({
          sessionId: args.sessionId,
          truncated: lines.join('\n').length > TRANSCRIPT_TAIL_LIMIT,
          transcript: redactAndTail(lines.join('\n')),
        })
      },
    ),
    define(
      'get_run_status',
      '查看绑定意图某个会话当前是否有 turn 在运行,以及是否停在未作答的提问上。',
      { sessionId: z.string().describe('要查询的会话 id,必须属于绑定的意图') },
      async (args: { sessionId: string }) => {
        const blocked = guard(scope, { sessionId: args.sessionId })
        if (blocked) return blocked
        const rt = getRuntime(args.sessionId)
        return ok({
          sessionId: args.sessionId,
          running: isRunning(args.sessionId),
          status: rt?.status ?? 'unknown',
          pendingQuestion: rt ? hasPendingQuestion(rt.buffer) : false,
        })
      },
    ),
    define(
      'list_sessions',
      '列出绑定意图拥有的全部会话(work / spec / intent)及其存活状态。只返回该意图可见的数据。',
      {},
      async () => {
        const blocked = guard(scope)
        if (blocked) return blocked
        const intent = getIntent(scope.intentId)!
        const rows = (
          [
            ['work', intent.lastWorkSessionId],
            ['spec', intent.specSessionId],
            ['intent', intent.intentSessionId],
          ] as const
        )
          .filter(([, id]) => !!id)
          .map(([kind, id]) => ({
            sessionType: kind,
            sessionId: id!,
            running: isRunning(id!),
            status: getRuntime(id!)?.status ?? 'unknown',
          }))
        return ok({ intentId: scope.intentId, sessions: rows })
      },
    ),

    // ── Writes, no confirmation ──
    define(
      'stop_run',
      '停止绑定意图拥有的某个会话正在执行的 turn。不改变意图状态,不删除会话与 transcript。',
      { sessionId: z.string().describe('要停止的会话 id,必须属于绑定的意图') },
      async (args: { sessionId: string }) => {
        const blocked = guard(scope, { sessionId: args.sessionId })
        if (blocked) return blocked
        stopRun(args.sessionId)
        return ok({ sessionId: args.sessionId, stopped: true })
      },
    ),
    define(
      'raise_user_todo',
      '创建一条去重的 wait-user-involve 待办,把无法自动裁决的事项交还给人。' +
        '待办是告知性的,不携带任何权限请求的 requestId,因此不会代替任何人作答。',
      {
        reasonCode: z.string().describe('稳定的结构化原因码,同一意图同一原因只会创建一条'),
        detail: z.string().describe('给人看的简短说明,不要包含 prompt/凭据/transcript 正文'),
      },
      async (args: { reasonCode: string; detail: string }) => {
        const blocked = guard(scope)
        if (blocked) return blocked
        const intent = getIntent(scope.intentId)!
        const requestId = `advisor:${scope.intentId}:${args.reasonCode}`
        if (getEventByRequestId(requestId)) {
          return ok({ requestId, created: false, reason: 'duplicate' })
        }
        createEvent({
          workspacePath: scope.workspacePath,
          sessionKind: 'work',
          sessionId: intent.lastWorkSessionId,
          title: redactSecrets(args.detail).slice(0, 200),
          requestId,
          toolName: null,
          toolInput: { intentId: scope.intentId, reason: args.reasonCode },
        })
        d.broadcastWaitUserEvents(scope.workspacePath)
        return ok({ requestId, created: true })
      },
    ),

    // ── Writes, confirmation required ──
    define(
      'reset_intent_session',
      '丢弃绑定意图当前的意图沟通会话,以新的引导输入开启一条全新会话(破坏性上下文替换,需人工确认)。',
      { userInput: z.string().describe('新会话的引导输入') },
      async (args: { userInput: string }) => {
        const blocked = guard(scope)
        if (blocked) return blocked
        return confirmed(scope, d, 'reset_intent_session', args, async () =>
          resetIntentSessionCore(scope, d, args.userInput),
        )
      },
    ),
    define(
      'reset_spec_session',
      '在已有 spec 文件上开启一条全新的 spec 编写会话,替换原会话上下文(破坏性,需人工确认)。',
      { userInput: z.string().describe('新会话的引导输入') },
      async (args: { userInput: string }) => {
        const blocked = guard(scope)
        if (blocked) return blocked
        return confirmed(scope, d, 'reset_spec_session', args, async () =>
          resetSpecSessionCore(scope, d, args.userInput),
        )
      },
    ),
    define(
      'update_intent_status',
      '流转绑定意图的状态(需人工确认)。只接受合法流转,且**不接受** done——' +
        '自动标记完成的唯一例外属于队列自身的评判+提交+推送路径。',
      {
        status: z.enum(STATUS_VALUES).describe('目标状态,不含 done'),
      },
      async (args: { status: (typeof STATUS_VALUES)[number] }) => {
        const blocked = guard(scope)
        if (blocked) return blocked
        // Re-checked here, not merely in the validator: the enum keeps `done`
        // off the wire, and this keeps it off even if the schema is bypassed.
        if ((args.status as IntentStatus) === 'done') {
          return denied('target_status_done_forbidden', '顾问不得把意图标记为 done', false, {
            targetStatus: 'done',
          })
        }
        return confirmed(scope, d, 'update_intent_status', args, async () => {
          const result = await applyIntentStatusChange(
            scope.workspacePath,
            scope.intentId,
            args.status,
            {
              broadcastIntents: d.broadcastIntents,
              publishStatusChanged: d.publishStatusChanged,
              actor: 'advisor',
            },
          )
          return result.success
            ? ok({ intentId: scope.intentId, from: result.fromStatus, to: args.status })
            : denied('illegal_status_transition', result.code, false, result.params)
        })
      },
    ),
    define(
      'create_pr',
      '为绑定意图创建 PR(需人工确认)。复用人工路径的全部前置校验:已有 PR 则幂等拒绝、' +
        '仅 worktree 模式、必须有分支、工作树必须与主干有差异;提交或推送失败时不会创建 PR。',
      {},
      async () => {
        const blocked = guard(scope)
        if (blocked) return blocked
        return confirmed(scope, d, 'create_pr', {}, async () => {
          const result = await createPrForIntent(scope.workspacePath, scope.intentId, {
            broadcastIntents: d.broadcastIntents,
            normalizeEvent: d.normalizeEvent,
            publishEvent: d.publishEvent,
            actor: 'advisor',
          })
          return result.success
            ? ok({ prId: result.prId, prUrl: result.prUrl })
            : denied('tool_failed', result.code, true, result.params)
        })
      },
    ),
    define(
      'sync_intent_pr_status',
      '按 forge 上的真实状态回填绑定意图的 PR 状态(需人工确认)。',
      {},
      async () => {
        const blocked = guard(scope)
        if (blocked) return blocked
        return confirmed(scope, d, 'sync_intent_pr_status', {}, async () => {
          const result = await syncIntentPrStatus({
            workspacePath: scope.workspacePath,
            intentId: scope.intentId,
            broadcastIntents: d.broadcastIntents,
          })
          return ok(result)
        })
      },
    ),
  ]
}

/**
 * The stable, ordered names of the advisor tool group — the list the HTTP route
 * hands Codex as its explicit `enabledTools` (Codex marks each one
 * required/approved, so a name missing here would be silently disabled).
 *
 * Derived from {@link buildAdvisorC3Tools} so it can never drift from what is
 * actually registered. This list is deliberately SEPARATE from
 * `AUTOMATION_C3_TOOL_NAMES`: ordinary automations do not gain these tools.
 */
export const ADVISOR_C3_TOOL_NAMES: readonly string[] = buildAdvisorC3Tools(
  { workspacePath: '', intentId: '', chainDepth: 0, sessionId: '' },
  null,
).map((t) => t.name)

/** The subset of the advisor group that must clear the write-approval queue. */
export const ADVISOR_CONFIRMED_TOOL_NAMES: readonly string[] = buildAdvisorC3Tools(
  { workspacePath: '', intentId: '', chainDepth: 0, sessionId: '' },
  null,
)
  .filter((t) => t.requiresConfirmation)
  .map((t) => t.name)
