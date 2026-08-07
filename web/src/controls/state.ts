import { ref, computed } from 'vue'
import { actionablePermissionId } from '@/lib/permission'
import { type PendingItem } from '@/lib/pending-queue'
import {
  discussionPhase,
  showDiscussionStart,
  type DispatchView,
  type DiscussionPhase,
} from '@/lib/discussion-view'
import { emptyTaskModel, type TaskListModel } from '@/lib/task-list'
import { type CreatePrModel } from '@/lib/create-pr-view'
import type { DeliveryBranchInitState } from '@/lib/delivery-view'
import { type DevLaunchModel } from '@/lib/dev-launch-view'
import type { GateEscape } from '@/lib/gate-escape'
import { type SpecLaunchModel } from '@/lib/spec-launch-view'
import { type SessionRef } from '@/lib/tab-view'
import { type SessionSourceAction } from '@/lib/session-jump'
import { type PendingWorkSessionSelectRequest } from '@/lib/work-session-jump'
import type { CodeTab, CodesSearchResultView } from '@/lib/codes-view'
import type { ChatBody, ChatMsg, RunActivity } from '@/lib/chat-types'
import { agentNameAt } from '@/lib/agent-prefix'
import { deriveVendorAvailability } from '@/lib/vendor-runtime'
import { normalizePersonalized, readLocalPersonalized } from '@/lib/personalized-settings'
import type { DeepLinkTarget } from '@/lib/deep-link'
import type { SystemSettingsTarget } from '@/lib/action-descriptor'
import type {
  WorkflowStatus,
  QueueDetail,
  CodeDirEntry,
  CodeGitStatus,
  CodeSearchMode,
  CodexPolicy,
  DepType,
  AssociatedIntent,
  Delivery,
  DeliveryPr,
  DeliveryTransitionPlan,
  Discussion,
  GitActionFailureGuidance,
  ModeToken,
  VendorModeCatalog,
  Intent,
  IntentLog,
  IntentSessionInfo,
  UpdateStatus,
  PromptImage,
  PersonalizedSettings,
  WorkspaceSetting as WorkspaceSettingType,
  Automation,
  AutomationExecutionLog,
  ToolManifestEntry,
  AdapterCapability,
  SessionAgentSwitch,
  McpApiKeyMeta,
  ExternalMcpToolDescriptor,
  SessionBindingStats,
  SessionCapabilities,
  SandboxHostStatus,
  SessionInfo,
  SessionKind,
  SessionOwnerKind,
  SessionRunStatus,
  SessionStatus,
  SkillLinkStatus,
  SkillSupportState,
  ParkRecoveryStats,
  SlashCommandInfo,
  SysExtraMount,
  SystemSettings,
  TranscriptItem,
  VendorHostStatus,
  VendorId,
  VendorRuntimeStatus,
  WaitUserInvolveEvent,
  WorkspaceInfo,
  WorkspaceDashboardRow,
} from '@ccc/shared/protocol'
import type { UiError } from '@ccc/shared/ui-codes'
import { useTypedI18n } from '@/i18n'
import { useModeLabel, CLAUDE_MODE_FALLBACK } from '@/composables/useModeLabel'
import { useAuth } from '@/composables/useAuth'
import type { ApprovalRequest } from '@/components/SkillApprovalModal/SkillApprovalModal.vue'

export type TypedT = ReturnType<typeof useTypedI18n>['t']
export type ModeLabel = ReturnType<typeof useModeLabel>
export type AuthApi = ReturnType<typeof useAuth>

export interface StateDeps {
  t: TypedT
  modeLabel: ModeLabel
  auth: AuthApi
}

// localStorage keys for view-restore persistence (kept here so both state and
// the persistence installer share the single source).
export const VIEW_MODE_KEY = 'c3.viewMode'
export const REQ_PROJECT_KEY = 'c3.intentsProject'
export const DISC_PROJECT_KEY = 'c3.discussionsProject'
export const DISC_ID_KEY = 'c3.discussionId'
export const SCHED_PROJECT_KEY = 'c3.automationsProject'
export const CODES_PROJECT_KEY = 'c3.codesProject'
export const CURRENT_WS_KEY = 'c3.currentWorkspace'
export const WORK_SESSION_QUERY_START_TIME_KEY = 'work_session_query_start_time'
// Codes 内嵌 ChatColumn 的 per-workspace 持久化键前缀。实际键为
// `c3.codes.<workspaceId>.chatWidth` / `c3.codes.<workspaceId>.sessionId`
// (由 persistence.ts 的 codesKey 拼装),记住每个工作区最后一次的分隔条宽度与
// 内嵌会话 id。
export const CODES_CHAT_WIDTH_KEY = 'chatWidth'
export const CODES_CHAT_SESSION_KEY = 'sessionId'
// 内嵌 ChatColumn 分隔条宽度(像素):默认 / 最小 / 最大。像素而非比例,窗口缩放时
// 用户感知宽度更稳定。
export const CODES_CHAT_WIDTH_DEFAULT = 360
export const CODES_CHAT_WIDTH_MIN = 240
export const CODES_CHAT_WIDTH_MAX = 720

export type TabKey = 'console' | 'intents' | 'deliveries' | 'discussion' | 'automations' | 'codes'
export type SessionPageKind = Exclude<SessionKind, 'consensus'>

export const SESSION_PAGE_KINDS: readonly SessionPageKind[] = [
  'work',
  'intent',
  'spec',
  'spec_review',
  'discussion',
  'automation',
  'tool',
]

export function sessionCacheKey(workspaceId: string, sessionKind: SessionPageKind): string {
  return `${workspaceId}::${sessionKind}`
}

// 顶部「会话」tab 角标数值:当前工作区六类会话(work/intent/spec/discussion/
// automation/tool)进行中计数之和。与左侧列表六个 kind tab 角标同一数据源
// (sessionCounts),不引入新口径。tool 类在 showToolSessions 关闭时服务端本就
// 不推送(值为 0),自然不计入。和为 0 时上层 `v-if="tab.badgeCount"` 不渲染角标。
export function sumSessionCounts(counts: Record<SessionPageKind, number>): number {
  return SESSION_PAGE_KINDS.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0)
}

// 顶部「意图/讨论/自动化」tab 角标的初值:三类进行中条目数均为 0(0 时上层不渲染)。
export function emptyOwnerCounts(): Record<SessionOwnerKind, number> {
  return { intent: 0, discussion: 0, automation: 0 }
}

// 「哪些会话正在跑」的指纹:非 idle 会话 id 的有序串。session_status 是全量快照,
// 逐条比较指纹即可判断运行集合是否真的变化 —— 变了才向服务端重新要一次权威计数,
// 避免对无关状态重播产生请求风暴。
export function runningSessionsFingerprint(statuses: Record<string, SessionStatus>): string {
  return Object.keys(statuses)
    .filter((id) => statuses[id] !== 'idle')
    .sort()
    .join(',')
}

// session_status 帧(数组形态)的同一指纹,用于与当前状态映射比较。
export function runningSessionsFingerprintOf(statuses: SessionRunStatus[]): string {
  return statuses
    .filter((s) => s.status !== 'idle')
    .map((s) => s.sessionId)
    .sort()
    .join(',')
}

/**
 * Create the full reactive state surface of the app controller: every ref,
 * computed, and pure (state-only) helper used by App.vue and the action
 * installers. Holds NO methods that talk to the server — those are attached by
 * the domain installers onto the shared `ctx`.
 */
export function createState(deps: StateDeps) {
  const { t, modeLabel, auth } = deps

  const messages = ref<ChatMsg[]>([])
  const status = ref<'connecting' | 'open' | 'closed'>('connecting')

  // Authentication (ADR-0023). Purely reactive: `auth.status` stays 'unknown'
  // until the server emits `unauthenticated` (login gate) or a login succeeds.
  const authStatus = computed(() => auth.status.value)
  // Live run status per session (sidebar badges + input lock for the viewed one).
  const sessionStatus = ref<Record<string, SessionStatus>>({})
  // The viewed session's permission mode, a vendor-native ModeToken (2026-06-07-012).
  const mode = ref<ModeToken>('default')
  // Codex dual-policy config (2026-06-08), when the active session is codex.
  const codexPolicy = ref<CodexPolicy | null>(null)

  // Mutable counters (non-reactive) for chat message ids + queue item ids.
  const counters = { nextId: 1, nextQueueId: 1 }
  // Non-reactive flags shared across installers.
  // `pendingConsoleBind`: a workspace switch or session-kind switch cleared the
  // chat column and is waiting for the current workspace+kind's `list_sessions`
  // reply to bind its first session.
  const flags = { viewModeFirstWorkcenter: true, pendingConsoleBind: false }

  // "Current task list" of the viewed session (server-derived, pushed over the
  // `task_*` wire path). Reset on session_selected, then filled from those messages.
  const taskModel = ref<TaskListModel>(emptyTaskModel())

  // Sidebar / session state
  const workspaces = ref<WorkspaceInfo[]>([])
  const sessionsByWorkspace = ref<Record<string, SessionInfo[]>>({})
  const activeSessionKind = ref<SessionPageKind>('work')
  const sessionCounts = ref<Record<SessionPageKind, number>>({
    work: 0,
    intent: 0,
    spec: 0,
    spec_review: 0,
    discussion: 0,
    automation: 0,
    tool: 0,
  })
  // 当前工作区「进行中条目数」(按 owner 去重,服务端权威)。与 sessionCounts 同一帧
  // 送达,但语义是条目而非会话:一个意图/讨论/自动化只要有任一会话在跑就计 1。
  // 驱动顶部「意图/讨论/自动化」三个 tab 的角标。
  const ownerRunningCounts = ref<Record<SessionOwnerKind, number>>(emptyOwnerCounts())
  // Per-workspace cursor-pagination state (SR-R14), parallel to the session
  // arrays above. `hasMore` drives the "load more" button; `exhausted` flips it
  // to a "Fully loaded" hint; `loadingMore` guards a double click;
  // `pendingSince` remembers the `since` of an in-flight `window` refresh so its
  // reply can keep loaded-more rows below that boundary.
  const sessionPagingByWorkspace = ref<
    Record<
      string,
      { hasMore: boolean; exhausted: boolean; loadingMore: boolean; pendingSince?: number }
    >
  >({})
  // The single global "current workspace" the sidebar reflects; decoupled from the
  // viewed session's workspace (`activeWorkspace`). Persisted to localStorage.
  const currentWorkspace = ref<string | null>(null)
  const activeWorkspace = ref<string | null>(null)
  const activeSession = ref<string | null>(null)
  const activeTitle = ref<string>('')

  // WorkCenter: pending user-involve events for event list.
  const workcenterEvents = ref<WaitUserInvolveEvent[]>([])
  const workcenterHasMore = ref(false)
  const workcenterLoading = ref(false)
  const workcenterAppendNext = ref(false)
  const workcenterPendingCount = computed(
    () => workcenterEvents.value.filter((event) => event.status === 'todo').length,
  )

  // Workcenter page-internal nav: which page the workcenter view is showing.
  const workcenterPage = ref<'dashboard' | 'notifications'>('notifications')

  // Workcenter Dashboard: the cross-workspace snapshot + its per-row gate feedback.
  const dashboardRows = ref<WorkspaceDashboardRow[]>([])
  const dashboardLoading = ref(false)
  // The whole snapshot failed to refresh; the last good rows are kept on screen.
  const dashboardError = ref<UiError | null>(null)
  // Workspace ids whose per-row automation toggle is in flight (its switch is busy).
  const dashboardPending = ref<Set<string>>(new Set())
  // A coalesced refresh was requested while a request was in flight — run once after.
  const dashboardRefreshPending = ref(false)

  // The 「会话」(console) tab remembers its OWN last-viewed session, independent of
  // the 「需求」tab's comm session — so switching tabs never crosses chat content.
  const consoleSession = ref<SessionRef | null>(null)

  const hasActiveSession = computed(() => activeSession.value !== null)
  // Sessions of the current workspace (the only ones the sidebar lists).
  const currentSessions = computed<SessionInfo[]>(
    () =>
      (currentWorkspace.value &&
        sessionsByWorkspace.value[
          sessionCacheKey(currentWorkspace.value, activeSessionKind.value)
        ]) ||
      [],
  )
  // Pagination flags of the current workspace's session window (SR-R14): drive
  // the sidebar's "load more" button / "Fully loaded" hint.
  const currentSessionPaging = computed<{ hasMore: boolean; exhausted: boolean }>(() => {
    const p =
      currentWorkspace.value &&
      sessionPagingByWorkspace.value[
        sessionCacheKey(currentWorkspace.value, activeSessionKind.value)
      ]
    return { hasMore: p ? p.hasMore : false, exhausted: p ? p.exhausted : false }
  })

  // Status of one session (idle when unknown).
  function statusOf(sessionId: string): SessionStatus {
    return sessionStatus.value[sessionId] ?? 'idle'
  }

  // The viewed session is "running" (input locked) whenever it isn't idle.
  const running = computed(
    () => hasActiveSession.value && statusOf(activeSession.value as string) !== 'idle',
  )

  // The viewed session's agent run is in the transient socket-disconnect hold
  // (SessionStatus `reconnecting`, AVAIL-7).
  const reconnecting = computed(
    () => hasActiveSession.value && statusOf(activeSession.value as string) === 'reconnecting',
  )

  // Sessions upgraded to a persistent agent team (server `team_upgraded`).
  const teamSessions = ref<Set<string>>(new Set())
  const activeIsTeam = computed(
    () => hasActiveSession.value && teamSessions.value.has(activeSession.value as string),
  )

  // ---- Pending send queue (ordinary sessions, client-side only) ----
  const pendingQueues = ref<Record<string, PendingItem[]>>({})
  // The active page container (Sessions / Intents) exposes `prefill`; this ref
  // binds to whichever is mounted so queue-edit can fold text back into the composer.
  const composer = ref<{
    prefill: (text: string, images?: PromptImage[]) => void
  } | null>(null)

  const currentQueue = computed<PendingItem[]>(() =>
    activeSession.value ? (pendingQueues.value[activeSession.value] ?? []) : [],
  )

  function setQueue(sessionId: string, items: PendingItem[]): void {
    pendingQueues.value = { ...pendingQueues.value, [sessionId]: items }
  }

  // The one permission the user can still act on, or null.
  const actionablePermId = computed<string | null>(() =>
    actionablePermissionId(
      messages.value,
      hasActiveSession.value && statusOf(activeSession.value as string) === 'awaiting_permission',
    ),
  )

  // Fine-grained activity of the viewed session, inferred from the event stream.
  const activity = ref<RunActivity>({ phase: 'idle' })

  // Per-session "danger state" flag (AS-R19).
  const sideEffectPendingBySession = ref<Record<string, boolean>>({})
  const sideEffectPending = computed(
    () =>
      hasActiveSession.value && !!sideEffectPendingBySession.value[activeSession.value as string],
  )
  function clearSideEffectPending(sessionId: string): void {
    if (!sideEffectPendingBySession.value[sessionId]) return
    const next = { ...sideEffectPendingBySession.value }
    delete next[sessionId]
    sideEffectPendingBySession.value = next
  }

  // Which agent the viewed session is really running (stored as the session's
  // CHAIN INDEX, anchored at the session's bound agent).
  const currentAgentIndexBySession = ref<Record<string, number>>({})
  const currentAgentName = computed(() =>
    activeSession.value
      ? agentNameAt(
          serverSettings.value,
          activeAgentSwitch.value?.current.id,
          currentAgentIndexBySession.value[activeSession.value] ?? 0,
        )
      : '',
  )

  // Available commands/skills for the active session's cwd (fetched lazily on the
  // first `/`). Cleared on session switch.
  const availableCommands = ref<SlashCommandInfo[]>([])

  // ---- Update availability ----
  // Server-detected "is a newer c3 release available?" snapshot (seeded on `ready`,
  // refreshed by `update_status`). The header shows an upgrade hint only when
  // `available === true && latestVersion`; otherwise it renders nothing.
  const updateStatus = ref<UpdateStatus>({
    available: false,
    latestVersion: null,
    checkedAt: null,
  })

  // ---- View mode (workspace / workcenter) ----
  const viewMode = ref<'workspace' | 'workcenter'>('workspace')
  // 切到 workcenter 前记住的标签页,切回 workspace 时恢复。
  const savedTab = ref<TabKey>('intents')

  // Null means the authoritative server settings have not arrived yet. Navigation
  // treats that state as safely hidden and only restores console after the reply.
  const serverSettings = ref<SystemSettings | null>(null)

  // ---- Top-bar tabs ----
  // 顶部 tab 数据源。意图/讨论/自动化 三个 tab 的角标是「进行中条目数」(owner 去重),
  // 「会话」tab 的角标是六类进行中会话数之和 —— 两套口径并存,互不替代。角标的无障碍
  // 文案按 tab 各自的 key 取,不再共用「会话」文案。
  const HEADER_TABS = computed<
    { key: TabKey; label: string; badgeCount?: number; badgeAriaLabel?: string }[]
  >(() => {
    const owners = ownerRunningCounts.value
    const tabs: { key: TabKey; label: string; badgeCount?: number; badgeAriaLabel?: string }[] = [
      {
        key: 'intents',
        label: t('nav.tab.intents.label'),
        badgeCount: owners.intent,
        badgeAriaLabel: t('nav.tab.intents.ariaLabel', { count: owners.intent }),
      },
      {
        key: 'deliveries',
        label: t('nav.tab.delivery.label'),
        badgeCount: deliveriesNeedsAction.value[currentWorkspace.value ?? ''] ?? 0,
        badgeAriaLabel: t('nav.tab.delivery.ariaLabel', {
          count: deliveriesNeedsAction.value[currentWorkspace.value ?? ''] ?? 0,
        }),
      },
      {
        key: 'discussion',
        label: t('nav.tab.discussion.label'),
        badgeCount: owners.discussion,
        badgeAriaLabel: t('nav.tab.discussion.ariaLabel', { count: owners.discussion }),
      },
      {
        key: 'automations',
        label: t('nav.tab.automations.label'),
        badgeCount: owners.automation,
        badgeAriaLabel: t('nav.tab.automations.ariaLabel', { count: owners.automation }),
      },
      { key: 'codes', label: t('nav.tab.codes.label') },
    ]
    if (serverSettings.value?.showSessionsPage === true) {
      const running = sumSessionCounts(sessionCounts.value)
      tabs.push({
        key: 'console',
        label: t('nav.tab.console.label'),
        badgeCount: running,
        badgeAriaLabel: t('nav.tab.console.ariaLabel', { count: running }),
      })
    }
    return tabs
  })
  const activeTab = ref<TabKey>('intents')
  const intentsProject = ref<string | null>(null)
  const intents = ref<Record<string, Intent[]>>({})

  // ---- Delivery view (read path) ----
  // 交付列表 + 角标数按工作区缓存。角标数由服务端按「需要用户处理」规则计算
  // (deliveryRequiresAction),随 `deliveries` 帧下发 —— 不是计划总数,客户端不重算。
  const deliveriesProject = ref<string | null>(null)
  const deliveries = ref<Record<string, Delivery[]>>({})
  const currentDeliveries = computed<Delivery[]>(() =>
    deliveriesProject.value ? (deliveries.value[deliveriesProject.value] ?? []) : [],
  )
  const deliveriesNeedsAction = ref<Record<string, number>>({})
  const activeDeliveryId = ref<string | null>(null)
  const activeDelivery = ref<Delivery | null>(null)
  /** The server-computed transition plan for the open delivery (never re-derived client-side). */
  const activeDeliveryPlan = ref<DeliveryTransitionPlan | null>(null)
  /**
   * Intents linked to the open delivery, as the server listed them. Each row's
   * `prStatus` is that intent's PR toward THIS delivery — never its global PR
   * state — so the list is server truth and is never recombined client-side.
   */
  const activeDeliveryIntents = ref<AssociatedIntent[]>([])
  /**
   * How far mainline is ahead of the open delivery's branch (server-computed,
   * fetch-free). `null` = not applicable / undeterminable; `> 0` drives the
   * 「主线领先」 hint and makes 「同步主线」 the obvious next action.
   */
  const activeDeliveryMainlineAhead = ref<number | null>(null)
  /**
   * How far the open delivery's branch is ahead of mainline (server-computed,
   * fetch-free); the mirror of `activeDeliveryMainlineAhead`. `null` = unknown /
   * not applicable; `> 0` proves the delivery branch carries commits the merge
   * would actually ship, i.e. 「创建交付 PR」 has a real diff to open.
   */
  const activeDeliveryBranchAhead = ref<number | null>(null)
  /** In-flight 「同步主线」 phase for the open delivery; null = idle. */
  const activeDeliverySyncPhase = ref<'fetching' | 'merging' | 'pushing' | null>(null)
  /**
   * The open delivery's latest delivery PR (「交付分支 → 主线」), as the server
   * listed it; `null` when none was opened. Never derived client-side — whether a
   * delivery is merged, blocked or conflicting is forge truth the server settled.
   */
  const activeDeliveryPr = ref<DeliveryPr | null>(null)
  /** Whether a `create_delivery_pr` / `sync_delivery_pr` round trip is in flight. */
  const activeDeliveryPrBusy = ref(false)
  /**
   * Deliveries whose detail already auto-synced its PR once in this page session
   * (the 「进页自动同步一次」 rule). Re-entering a delivery clears its entry, so
   * the sync happens once per open rather than once per process — and never on
   * every `delivery_detail` frame, which the sync's own reply would turn into a
   * loop.
   */
  const autoSyncedDeliveryPrs = ref<Set<string>>(new Set())
  /**
   * In-flight branch-init state for the open delivery (phase progress). `null`
   * = no init running. Set when the init is sent, advanced by the server's
   * progress frames, cleared on the result frame or an init error.
   */
  const activeDeliveryBranchInit = ref<DeliveryBranchInitState | null>(null)

  const currentIntents = computed<Intent[]>(() =>
    intentsProject.value ? (intents.value[intentsProject.value] ?? []) : [],
  )
  /**
   * The delivery page's intent pool (its link picker) — keyed by the DELIVERY
   * workspace, not the intents tab's. The two tabs can sit on different
   * workspaces, and the picker must offer the delivery's own.
   */
  const deliveryLinkIntents = computed<Intent[]>(() =>
    deliveriesProject.value ? (intents.value[deliveriesProject.value] ?? []) : [],
  )
  /**
   * The mirror image for the intent page's 「关联交付」 picker — the deliveries of
   * the INTENTS workspace, which may differ from the delivery tab's. Fed by the
   * same `deliveries` frame (keyed by workspace), so the picker stays fresh on
   * broadcast without the intent page owning a second cache.
   */
  const intentLinkDeliveries = computed<Delivery[]>(() =>
    intentsProject.value ? (deliveries.value[intentsProject.value] ?? []) : [],
  )
  /**
   * The one-shot follow-up owed to a 「当前意图独立交付」 click: which intent the
   * next `create_delivery_result` must be linked to (and whose branch must then
   * be initialized). `null` = no standalone create in flight, which is also what
   * keeps a plain delivery-page create from being chained onto — and what makes
   * a second click a no-op while the first is still travelling.
   */
  const pendingStandaloneDelivery = ref<{ workspaceId: string; intentId: string } | null>(null)

  // Per-workspace SDD master switch, rebroadcast with every intent list. Drives
  // the SDD-aware intent action button (Write Spec / Approve Spec / Start Work)
  // without a separate workspace-setting fetch.
  const intentsSdd = ref<Record<string, boolean>>({})
  const currentIntentsSdd = computed<boolean>(() =>
    intentsProject.value ? (intentsSdd.value[intentsProject.value] ?? false) : false,
  )

  // Per-project automation-orchestrator status (server pushes `workflow_status`).
  const automation = ref<Record<string, WorkflowStatus>>({})
  const currentWorkflow = computed<WorkflowStatus | null>(() =>
    intentsProject.value ? (automation.value[intentsProject.value] ?? null) : null,
  )

  // Per-project queue detail (server pushes `queue_detail` after every pass and
  // every manual control). Kept apart from `automation` on purpose: the status
  // frame stays a compact button summary, this is the per-intent explanation.
  const queueDetail = ref<Record<string, QueueDetail>>({})
  const currentQueueDetail = computed<QueueDetail | null>(() =>
    intentsProject.value ? (queueDetail.value[intentsProject.value] ?? null) : null,
  )
  /** Whether the intents view is showing the queue page instead of the list. */
  const queuePageOpen = ref(false)

  // ---- Intent session list (middle column) ----
  const intentSessions = ref<Record<string, IntentSessionInfo[]>>({})
  const currentIntentSessions = computed<IntentSessionInfo[]>(() =>
    intentsProject.value ? (intentSessions.value[intentsProject.value] ?? []) : [],
  )
  const intentSessionRunStates = ref<Record<string, 'running'>>({})
  const selectedIntentSessionId = ref<string | null>(null)

  // ---- Intent-detail spec document (the `spec` tab content) ----
  // Content of the selected intent's `spec.md`, fetched via `read_file` and
  // routed by the matching `file_read` reply. `pendingSpecRel` tracks the
  // workspace-relative path we are awaiting so a stale codes `file_read` for a
  // different file never overwrites it.
  const intentSpecContent = ref<string | null>(null)
  const intentSpecLoading = ref(false)
  const pendingSpecRel = ref<string | null>(null)

  // ---- Intent lifecycle logs (the detail's changelog tab content) ----
  // Cached per intent id; filled by the `intent_logs_list` reply of a lazy
  // `list_intent_logs` request sent when the changelog tab is first opened.
  const intentLogsById = ref<Record<string, IntentLog[]>>({})
  const intentLogsLoading = ref(false)

  // ---- Discussion view (read path) ----
  const discussionsProject = ref<string | null>(null)
  const discussions = ref<Record<string, Discussion[]>>({})
  const currentDiscussions = computed<Discussion[]>(() =>
    discussionsProject.value ? (discussions.value[discussionsProject.value] ?? []) : [],
  )
  const activeDiscussionId = ref<string | null>(null)
  const activeDiscussion = ref<Discussion | null>(null)
  const discussionMessages = ref<ChatMsg[]>([])
  const discussionMaxSeq = ref(0)
  const discussionRunState = ref<Record<string, 'running' | 'paused'>>({})
  const researchState = ref<Record<string, 'running'>>({})
  const researchMessages = ref<ChatMsg[]>([])
  const researchMaxSeq = ref(0)
  const discussionDispatch = ref<Record<string, DispatchView>>({})
  // Draft for the discussion composer (human speak / follow-up question).
  const discussionInput = ref('')

  // The open discussion's live run-state ('running' | 'paused' | undefined).
  const activeDiscussionRunState = computed<'running' | 'paused' | undefined>(() =>
    activeDiscussionId.value ? discussionRunState.value[activeDiscussionId.value] : undefined,
  )
  // The open discussion's transient dispatch (in-flight/failed) status.
  const activeDiscussionDispatch = computed<DispatchView>(() => {
    const id = activeDiscussionId.value
    return (id && discussionDispatch.value[id]) || { pending: [], errors: [] }
  })
  // Whether the open discussion's research run is live.
  const activeResearchLive = computed<boolean>(() =>
    activeDiscussionId.value ? researchState.value[activeDiscussionId.value] === 'running' : false,
  )
  // Right-pane phase: the live research stream, or the discussion stream.
  const activeDiscussionPhase = computed<DiscussionPhase>(() =>
    discussionPhase(activeResearchLive.value),
  )
  // Manual Start fallback visibility.
  const showStart = computed<boolean>(() => {
    const d = activeDiscussion.value
    if (!d) return false
    const discussionLive =
      activeDiscussionRunState.value !== undefined ||
      d.status === 'in_progress' ||
      d.status === 'completed'
    return showDiscussionStart(d.status, activeResearchLive.value, discussionLive)
  })

  // ---- Automations view (read path) ----
  const automationsProject = ref<string | null>(null)
  const automations = ref<Record<string, Automation[]>>({})
  const currentAutomations = computed<Automation[]>(() =>
    automationsProject.value ? (automations.value[automationsProject.value] ?? []) : [],
  )
  const selectedAutomationId = ref<string | null>(null)
  const selectedAutomation = computed<Automation | null>(() => {
    if (!selectedAutomationId.value || !automationsProject.value) return null
    return currentAutomations.value.find((s) => s.id === selectedAutomationId.value) ?? null
  })
  const automationLogs = ref<Record<string, AutomationExecutionLog[]>>({})
  const selectedAutomationLogs = computed<AutomationExecutionLog[]>(() =>
    selectedAutomationId.value ? (automationLogs.value[selectedAutomationId.value] ?? []) : [],
  )
  const executionTranscripts = ref<Record<string, TranscriptItem[]>>({})
  const selectedExecutionId = ref<string | null>(null)
  const selectedExecution = computed<AutomationExecutionLog | null>(() => {
    if (!selectedExecutionId.value) return null
    return selectedAutomationLogs.value.find((l) => l.id === selectedExecutionId.value) ?? null
  })

  // ---- Automations workspace gate (WorkspaceSetting.automationEnabled) ----
  // A snapshot of the automations workspace's full setting, bound to
  // `automationsProject`. Held separately from `currentWorkspaceSetting` (the
  // settings panel's snapshot) and tagged with the workspace it belongs to, so a
  // late `workspace_setting` reply for a previous workspace never leaks the wrong
  // gate value into the current view.
  const automationWorkspaceSetting = ref<WorkspaceSettingType | null>(null)
  const automationWorkspaceSettingId = ref<string | null>(null)
  // True while a gate save is awaiting the server echo; disables the toggle so a
  // double-flip cannot race. The snapshot captured before an optimistic flip, so
  // a server-side rejection can roll the toggle back to the last confirmed value.
  const automationEnabledSaving = ref(false)
  const automationSettingBeforeSave = ref<WorkspaceSettingType | null>(null)
  // The gate value for the CURRENT automations workspace: available (a boolean)
  // only when the held snapshot matches `automationsProject`; `null` while loading
  // or right after a workspace switch (toggle renders disabled until it resolves).
  const automationEnabled = computed<boolean | null>(() => {
    const path = automationsProject.value
    if (!path || automationWorkspaceSettingId.value !== path || !automationWorkspaceSetting.value) {
      return null
    }
    return automationWorkspaceSetting.value.automationEnabled ?? true
  })

  // Automation-form tool manifest: cached per vendor, cleared on form close.
  const automationToolManifest = ref<Record<string, ToolManifestEntry[] | null>>({})
  const automationToolManifestLoading = ref(false)
  const automationToolManifestError = ref<string | null>(null)

  // Automation save-in-progress flag: drives the "Saving…" overlay that blocks
  // interaction while the server processes a create/update (2-4s typical latency).
  const automationSaving = ref(false)

  // The modal serves both create (target = null) and edit (target = a automation).
  const automationFormOpen = ref(false)
  const automationFormTarget = ref<Automation | null>(null)

  // ---- Codes view (read-only file browser) ----
  // The workspace id whose tree/tabs are loaded. Reset when it changes.
  const codesProject = ref<string | null>(null)
  // Lazy directory cache: rel path ('' = root) → immediate children. Absent = not loaded yet.
  const codesDirs = ref<Record<string, CodeDirEntry[]>>({})
  // Expanded directory rel paths (reassigned on mutation so Vue tracks the Set).
  const codesExpanded = ref<Set<string>>(new Set())
  // Directories with an in-flight `list_dir`.
  const codesLoadingDirs = ref<Set<string>>(new Set())
  // Authoritative workspace Git-status snapshot: changed-file path → flags.
  // Replaced wholesale on each `code_git_status`; empty = clean / non-git / error.
  const codesGitStatus = ref<Record<string, CodeGitStatus>>({})
  // Open file tabs, in tab order. Refresh clears them (no persistence by design).
  const codesTabs = ref<CodeTab[]>([])
  // The focused tab's path, or null when none are open.
  const codesActivePath = ref<string | null>(null)
  // Search box: mode toggle + query + glob filter + bounded result set
  // (null = no search yet). `pattern` defaults to `*` (all files).
  const codesSearchMode = ref<CodeSearchMode>('filename')
  const codesSearchQuery = ref('')
  const codesSearchPattern = ref('*')
  const codesSearchResult = ref<CodesSearchResultView | null>(null)
  const codesSearchLoading = ref(false)

  const codesActiveTab = computed<CodeTab | null>(
    () => codesTabs.value.find((tab) => tab.path === codesActivePath.value) ?? null,
  )
  // Codes 内嵌 ChatColumn 的「每工作区最后一次会话」指针(workspaceId → sessionId),
  // 作为持久化到内存的运行时镜像:openCodes 恢复时优先读 localStorage,该 ref 供
  // create/reset 后即时判定 create-vs-reset 按钮态,避免反复读 localStorage。与 Works
  // 的 consoleSession 是两个独立指针,互不覆盖。
  const codesBoundSessionId = ref<Record<string, string>>({})

  // ---- System settings (agent config) ----
  const settingsOpen = ref(false)
  // 一次性定位目标:某个派生的 ActionDescriptor 要求打开系统设置并落到具体位置。
  // 面板消费后由 App 清空(与 automationFormTarget / requestedIntentSubTab 同一套
  // 「一次性目标」模式),因此重开设置页不会再跳回上一次的 agent 行。
  const settingsTarget = ref<SystemSettingsTarget | null>(null)
  const hostStatus = ref<VendorHostStatus[]>([])
  // 服务端给出的、覆盖全部 vendor 的运行时可用性;旧服务端不发此字段,故可为 null。
  const vendorRuntime = ref<Record<VendorId, VendorRuntimeStatus> | null>(null)
  // 全前端唯一的「vendor 能不能跑」判定:所有门控点读它,不各自解读 hostStatus,
  // 也不按 vendor 名分支(旧服务端的回落规则收敛在 deriveVendorAvailability 内)。
  const vendorAvailability = computed(() =>
    deriveVendorAvailability(vendorRuntime.value ?? undefined, hostStatus.value),
  )
  const sandboxStatus = ref<SandboxHostStatus | null>(null)
  const bindingStats = ref<SessionBindingStats | null>(null)
  const sessionCapabilities = ref<Record<VendorId, SessionCapabilities> | null>(null)
  const skillSupport = ref<Record<VendorId, SkillSupportState> | null>(null)
  const vendorCapabilities = ref<Record<VendorId, Record<AdapterCapability, boolean>> | null>(null)
  const vendorModes = ref<Record<VendorId, VendorModeCatalog> | null>(null)
  // ---- External MCP API keys (workspace settings) ----
  // The roster is the CURRENT workspace's keys (metadata only, no plaintext).
  // `mcpApiKeyCreated` holds the ONE reply that ever carries a plaintext key: it
  // lives in memory for this page view so the user can copy it, and is cleared on
  // dismiss / page close. Nothing writes it to storage, so a refresh loses it
  // permanently — which is the promise the server makes. `mcpApiKeyCatalog` is the
  // server's externally-grantable tool list, rendered into the scope pickers.
  const mcpApiKeys = ref<McpApiKeyMeta[]>([])
  const mcpApiKeyCatalog = ref<ExternalMcpToolDescriptor[]>([])
  const mcpApiKeyCreated = ref<{ meta: McpApiKeyMeta; key: string } | null>(null)

  const skillApprovalRequest = ref<ApprovalRequest | null>(null)
  const skillLinkStatuses = ref<SkillLinkStatus[]>([])
  const installingSkillIds = ref<string[]>([])

  // ---- Personalized setting ----
  // The third settings class: per-person preferences, reachable by every account
  // (no admin gate). Seeded from this browser's own record so the first paint and a
  // no-account session already show the right language; replaced by the server echo
  // once an account answers.
  const personalizedSettingOpen = ref(false)
  const personalizedSettings = ref<PersonalizedSettings>(
    normalizePersonalized(readLocalPersonalized()),
  )

  // ---- Workspace setting ----
  const workspaceSettingOpen = ref(false)
  const currentWorkspaceSetting = ref<WorkspaceSettingType | null>(null)
  const detectedMainBranch = ref<string | null>(null)
  // Read-only: the FIXED, centralized SDD spec root the server resolved for the
  // workspace (`~/.c3/specs/<project-path-segment>`). Displayed, never editable.
  const resolvedSpecRoot = ref<string | null>(null)
  // Read-only: the workspace-scoped built-in sandbox allow set the server resolved
  // (project directory ro, specs root rw). Displayed next to editable extraMounts.
  const sysExtraMounts = ref<SysExtraMount[]>([])
  // ---- Local observation (park recovery) ----
  // Read-only counts for the workspace-setting page's observation section. Kept
  // OUTSIDE `currentWorkspaceSetting` on purpose: it is derived measurement, not
  // configuration, so it must never join a settings draft or a save payload.
  // `null` stats + `null` error = never loaded / cleared on workspace switch.
  const parkRecoveryStats = ref<ParkRecoveryStats | null>(null)
  const parkRecoveryError = ref<UiError | null>(null)
  const parkRecoveryLoading = ref(false)

  // ---- New-session agent picker (the "+" modal) ----
  const newSessionOpen = ref(false)
  const newSessionWorkspace = ref<string | null>(null)
  const activeVendor = ref<VendorId | null>(null)
  // Whether the active session's vendor exposes the SDK task surface (`taskStore`).
  const taskStoreAvailable = computed(() => {
    const caps = vendorCapabilities.value
    const vendor = activeVendor.value
    if (!caps || !vendor) return true
    return caps[vendor]?.taskStore ?? true
  })
  const activeAgentSwitch = ref<SessionAgentSwitch | null>(null)
  // The active session's title-bar source action (jump target + label family),
  // derived on `session_selected` from its owner metadata (+ the legacy
  // `linkedIntentId` compat field); null ⇒ no source button. Refreshed/cleared on
  // every (re)select, same lifecycle as `activeVendor`.
  const activeSessionSource = ref<SessionSourceAction | null>(null)
  // 当前活动会话的**真实** kind(来自列表投影行或 session_selected),与左栏的显示分类
  // activeSessionKind 不同:「规范」分类同时列出 spec 与 spec_review 两种真实 kind。
  // 只读呈现必须按真实 kind 判定,否则规范撰写会话会被一起锁死。null = 未知(按可写处理,
  // 服务端仍有 kind 门禁兜底)。
  const activeSessionRealKind = ref<SessionKind | null>(null)
  // 活动会话是否只能回放:spec_review 会话由系统运行并产出结论,人不能续跑。
  const activeSessionReadonly = computed<boolean>(
    () => activeSessionRealKind.value === 'spec_review',
  )
  // One-shot request to select a specific intent on the intents page (set by the
  // title-bar jump button, consumed + cleared by Intents.vue once applied).
  const requestedIntentId = ref<string | null>(null)
  // One-shot request to select a specific work session on the console tab. It can
  // wait first for the intent's last work session id, then for that work row.
  const requestedWorkSessionId = ref<PendingWorkSessionSelectRequest | null>(null)
  // One-shot request to force IntentDetail to switch to a specific sub-tab (set by
  // the WorkCenter jump-to-source, the post-Start-Work jump, and the
  // action-descriptor `intent-spec` deep link; consumed + cleared by IntentDetail
  // once applied). `'spec'` opens the document tab (approval checkpoint).
  const requestedIntentSubTab = ref<
    'intentSession' | 'specSession' | 'specReviewSession' | 'workSession' | 'spec' | null
  >(null)
  // One-shot request to select a specific WorkCenter wait-user event (set by the
  // action-descriptor `workcenter-event` deep link; consumed + cleared by
  // WorkCenter.vue once the event is visible in the list).
  const requestedWorkcenterEventId = ref<string | null>(null)
  // One-shot request to force IntentMergedList to switch to a specific tab (set by
  // the WorkCenter jump-to-source when no intent matches the session id).
  const requestedMergedTab = ref<'intents' | 'sessions' | null>(null)
  // One-shot request to open a specific standalone intent (chat) session on the
  // intents page (set by the title-bar source button when an intent session has no
  // owning intent to select). Consumed + cleared by Intents.vue once applied: it
  // flips the right column to the standalone chat bound to the active session.
  const requestedIntentSessionId = ref<string | null>(null)

  // ---- Deep link (URL hash routing) ----
  // One-shot pending deep link parsed from `location.hash` at startup, consumed
  // by the `ready` handler once workspaces are available. Not persisted to
  // localStorage — survives only the first `ready` after app mount.
  const pendingDeepLink = ref<DeepLinkTarget | null>(null)
  // A deep link whose target id was fulfilled by the corresponding server reply.
  // Kept as a set so the same link is never re-triggered (unlikely but defensive).
  const deepLinkFulfilled = ref<Set<string>>(new Set())
  // Timer handle for the deep link fulfillment timeout (cleanup on unload).
  const deepLinkTimers: { timeout: ReturnType<typeof setTimeout> | null } = { timeout: null }
  function clearPendingDeepLink(): void {
    pendingDeepLink.value = null
    if (deepLinkTimers.timeout) clearTimeout(deepLinkTimers.timeout)
    deepLinkTimers.timeout = null
  }

  // The mode-picker options for the viewed session.
  const modeOptions = computed(() => {
    const vendor = activeVendor.value
    const catalog = vendor ? vendorModes.value?.[vendor] : undefined
    const list = catalog
      ? catalog.modes.map((m) => ({ token: m.token, labelCode: m.labelCode }))
      : CLAUDE_MODE_FALLBACK
    return list.map((m) => ({ value: m.token, label: modeLabel(m.labelCode) }))
  })

  // The time zone automation cron fields are interpreted in for the live preview.
  const automationTimezone = computed(
    () => serverSettings.value?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  )

  // ---- Toast (transient, auto-dismissing global toast) ----
  const toast = ref<string | null>(null)
  // Intent action failures need an explicit acknowledgement, unlike transient toast feedback.
  const intentActionError = ref<string | null>(null)
  // The targeted Git/forge repair guidance for the SAME failure, when the server
  // classified one. Set and cleared together with the message above so the dialog
  // can never show one failure's text next to another failure's retry button.
  const intentActionErrorGuidance = ref<GitActionFailureGuidance | null>(null)
  const intentActionErrorSeq = ref(0)
  /**
   * The ESCAPE a refused launch left the user, when it left one (see
   * `lib/gate-escape.ts`). Held next to — never merged into — the plain error
   * above: the message states the fact, this states what the user may do about
   * it, and only one dialog is shown for a given refusal.
   */
  const intentGateEscape = ref<{ escape: GateEscape; message: string } | null>(null)
  const createIntentPending = ref(false)
  const intentPrSync = ref<
    Record<string, { state: 'syncing' | 'success' | 'error'; message: string }>
  >({})
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  function showToast(text: string): void {
    toast.value = text
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toast.value = null), 4000)
  }
  function showIntentActionError(
    text: string,
    guidance: GitActionFailureGuidance | null = null,
  ): void {
    intentActionError.value = text
    intentActionErrorGuidance.value = guidance
  }
  function closeIntentActionError(): void {
    intentActionError.value = null
    intentActionErrorGuidance.value = null
  }
  function showIntentGateEscape(escape: GateEscape, message: string): void {
    intentGateEscape.value = { escape, message }
  }
  function closeIntentGateEscape(): void {
    intentGateEscape.value = null
  }

  // ---- Dev-launch startup overlay (App-global, like the toast) ----
  // Tracks a manual `start_development` launch so a blocking overlay can show
  // its coarse progress immediately. null = no launch in flight / overlay closed.
  // The minimum-dwell + safety-timeout timers
  // live in this non-reactive holder so both intent-actions (arming) and the
  // message handler / close helper (clearing) share one source.
  const devLaunch = ref<DevLaunchModel | null>(null)
  const specLaunch = ref<SpecLaunchModel | null>(null)
  // `jump` is the post-`ready` delayed jump-to-work-session timer; it lives here
  // so a new launch / overlay close cancels a stale pending jump.
  const devLaunchTimers: {
    dwell: ReturnType<typeof setTimeout> | null
    safety: ReturnType<typeof setTimeout> | null
    jump: ReturnType<typeof setTimeout> | null
  } = { dwell: null, safety: null, jump: null }
  function clearDevLaunchTimers(): void {
    if (devLaunchTimers.dwell) clearTimeout(devLaunchTimers.dwell)
    if (devLaunchTimers.safety) clearTimeout(devLaunchTimers.safety)
    if (devLaunchTimers.jump) clearTimeout(devLaunchTimers.jump)
    devLaunchTimers.dwell = null
    devLaunchTimers.safety = null
    devLaunchTimers.jump = null
  }
  function closeDevLaunch(): void {
    clearDevLaunchTimers()
    devLaunch.value = null
  }
  const specLaunchTimers: {
    dwell: ReturnType<typeof setTimeout> | null
    safety: ReturnType<typeof setTimeout> | null
  } = { dwell: null, safety: null }
  function clearSpecLaunchTimers(): void {
    if (specLaunchTimers.dwell) clearTimeout(specLaunchTimers.dwell)
    if (specLaunchTimers.safety) clearTimeout(specLaunchTimers.safety)
    specLaunchTimers.dwell = null
    specLaunchTimers.safety = null
  }
  function closeSpecLaunch(): void {
    clearSpecLaunchTimers()
    specLaunch.value = null
  }

  // ---- Create-PR progress overlay (App-global, same shape as the dev launch) ----
  // Tracks a manual `create_pr` run so the blocking overlay can show its four
  // stages immediately. null = nothing in flight / overlay closed.
  const createPrProgress = ref<CreatePrModel | null>(null)
  const createPrTimers: {
    dwell: ReturnType<typeof setTimeout> | null
    safety: ReturnType<typeof setTimeout> | null
  } = { dwell: null, safety: null }
  function clearCreatePrTimers(): void {
    if (createPrTimers.dwell) clearTimeout(createPrTimers.dwell)
    if (createPrTimers.safety) clearTimeout(createPrTimers.safety)
    createPrTimers.dwell = null
    createPrTimers.safety = null
  }

  // ---- Pure (state-only) message-append helpers ----
  function add(m: ChatBody): void {
    messages.value.push({ ...m, id: counters.nextId++ } as ChatMsg)
  }

  // Resolve a session title from the loaded session lists (fallback when unknown).
  function sessionTitleById(id: string): string {
    for (const list of Object.values(sessionsByWorkspace.value)) {
      const s = list.find((x) => x.sessionId === id)
      if (s) return s.title
    }
    return t('session.fallback.label')
  }

  return {
    // primitives / runtime helpers
    counters,
    flags,
    add,
    setQueue,
    statusOf,
    clearSideEffectPending,
    showToast,
    showIntentActionError,
    closeIntentActionError,
    showIntentGateEscape,
    closeIntentGateEscape,
    sessionTitleById,
    devLaunchTimers,
    clearDevLaunchTimers,
    closeDevLaunch,
    specLaunchTimers,
    clearSpecLaunchTimers,
    closeSpecLaunch,
    createPrTimers,
    clearCreatePrTimers,
    clearPendingDeepLink,
    // refs
    messages,
    status,
    sessionStatus,
    mode,
    codexPolicy,
    taskModel,
    workspaces,
    sessionsByWorkspace,
    sessionPagingByWorkspace,
    currentWorkspace,
    activeWorkspace,
    activeSession,
    activeTitle,
    workcenterEvents,
    workcenterHasMore,
    workcenterLoading,
    workcenterAppendNext,
    workcenterPage,
    dashboardRows,
    dashboardLoading,
    dashboardError,
    dashboardPending,
    dashboardRefreshPending,
    consoleSession,
    teamSessions,
    pendingQueues,
    composer,
    activity,
    sideEffectPendingBySession,
    currentAgentIndexBySession,
    availableCommands,
    updateStatus,
    viewMode,
    savedTab,
    activeTab,
    intentsProject,
    intents,
    automation,
    queueDetail,
    queuePageOpen,
    intentSessions,
    intentSessionRunStates,
    selectedIntentSessionId,
    intentSpecContent,
    intentSpecLoading,
    pendingSpecRel,
    intentLogsById,
    intentLogsLoading,
    discussionsProject,
    discussions,
    activeDiscussionId,
    activeDiscussion,
    discussionMessages,
    discussionMaxSeq,
    discussionRunState,
    researchState,
    researchMessages,
    researchMaxSeq,
    discussionDispatch,
    discussionInput,
    automationsProject,
    automations,
    selectedAutomationId,
    automationLogs,
    executionTranscripts,
    selectedExecutionId,
    automationWorkspaceSetting,
    automationWorkspaceSettingId,
    automationEnabled,
    automationEnabledSaving,
    automationSettingBeforeSave,
    automationToolManifest,
    automationToolManifestLoading,
    automationToolManifestError,
    automationSaving,
    automationFormOpen,
    automationFormTarget,
    codesProject,
    codesDirs,
    codesExpanded,
    codesLoadingDirs,
    codesGitStatus,
    codesTabs,
    codesActivePath,
    codesSearchMode,
    codesSearchQuery,
    codesSearchPattern,
    codesSearchResult,
    codesSearchLoading,
    codesBoundSessionId,
    settingsOpen,
    settingsTarget,
    serverSettings,
    hostStatus,
    vendorRuntime,
    vendorAvailability,
    sandboxStatus,
    bindingStats,
    mcpApiKeys,
    mcpApiKeyCatalog,
    mcpApiKeyCreated,
    sessionCapabilities,
    skillSupport,
    vendorCapabilities,
    vendorModes,
    skillApprovalRequest,
    skillLinkStatuses,
    installingSkillIds,
    personalizedSettingOpen,
    personalizedSettings,
    workspaceSettingOpen,
    currentWorkspaceSetting,
    detectedMainBranch,
    resolvedSpecRoot,
    sysExtraMounts,
    parkRecoveryStats,
    parkRecoveryError,
    parkRecoveryLoading,
    newSessionOpen,
    newSessionWorkspace,
    activeVendor,
    activeAgentSwitch,
    activeSessionSource,
    activeSessionRealKind,
    activeSessionReadonly,
    requestedIntentId,
    requestedWorkSessionId,
    requestedIntentSubTab,
    requestedWorkcenterEventId,
    requestedMergedTab,
    requestedIntentSessionId,
    pendingDeepLink,
    deepLinkFulfilled,
    deepLinkTimers,
    toast,
    intentActionError,
    intentActionErrorGuidance,
    intentActionErrorSeq,
    intentGateEscape,
    createIntentPending,
    intentPrSync,
    devLaunch,
    specLaunch,
    createPrProgress,
    // computeds
    authStatus,
    workcenterPendingCount,
    hasActiveSession,
    currentSessions,
    activeSessionKind,
    sessionCounts,
    ownerRunningCounts,
    currentSessionPaging,
    running,
    reconnecting,
    activeIsTeam,
    currentQueue,
    actionablePermId,
    sideEffectPending,
    currentAgentName,
    HEADER_TABS,
    currentIntents,
    intentsSdd,
    currentIntentsSdd,
    currentWorkflow,
    currentQueueDetail,
    deliveriesProject,
    deliveries,
    currentDeliveries,
    deliveriesNeedsAction,
    activeDeliveryId,
    activeDelivery,
    activeDeliveryPlan,
    activeDeliveryIntents,
    activeDeliveryMainlineAhead,
    activeDeliveryBranchAhead,
    activeDeliverySyncPhase,
    activeDeliveryPr,
    activeDeliveryPrBusy,
    autoSyncedDeliveryPrs,
    activeDeliveryBranchInit,
    deliveryLinkIntents,
    intentLinkDeliveries,
    pendingStandaloneDelivery,
    currentIntentSessions,
    currentDiscussions,
    activeDiscussionRunState,
    activeDiscussionDispatch,
    activeResearchLive,
    activeDiscussionPhase,
    showStart,
    currentAutomations,
    selectedAutomation,
    selectedAutomationLogs,
    selectedExecution,
    codesActiveTab,
    taskStoreAvailable,
    modeOptions,
    automationTimezone,
  }
}

export type AppState = ReturnType<typeof createState>

// Re-export DepType so action installers can reference it without re-importing
// the shared protocol path (keeps the update-deps signature in one place).
export type { DepType }
