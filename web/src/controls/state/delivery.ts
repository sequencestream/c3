import { ref, computed } from 'vue'
import { actionablePermissionId } from '@/lib/permission'
import { type PendingItem } from '@/lib/pending-queue'
import {
  discussionPhase,
  discussionLaunchAction,
  type DispatchView,
  type DiscussionPhase,
  type DiscussionLaunchAction,
} from '@/lib/discussion-view'
import { emptyTaskModel, type TaskListModel } from '@/lib/task-list'
import { type CreateIntentModel } from '@/lib/create-intent-view'
import { type CreatePrModel } from '@/lib/create-pr-view'
import type { DeliveryBranchInitState } from '@/lib/delivery-view'
import { type DevLaunchModel } from '@/lib/dev-launch-view'
import type { GateEscape } from '@/lib/gate-escape'
import type { WorktreeBaselineNotice } from '@/lib/worktree-baseline'
import { type SpecLaunchModel } from '@/lib/spec-launch-view'
import { type SessionRef } from '@/lib/tab-view'
import { type SessionSourceAction } from '@/lib/session-jump'
import { type PendingWorkSessionSelectRequest } from '@/lib/work-session-jump'
import type { FileTab, FilesSearchResultView } from '@/lib/files-view'
import type { ChatBody, ChatMsg, RunActivity } from '@/lib/chat-types'
import { agentNameAt } from '@/lib/agent-prefix'
import { deriveVendorAvailability } from '@/lib/vendor-runtime'
import { normalizePersonalized, readLocalPersonalized } from '@/lib/personalized-settings'
import type { DeepLinkTarget } from '@/lib/deep-link'
import type { SystemSettingsTarget } from '@/lib/action-descriptor'
import type {
  WorkflowStatus,
  QueueDetail,
  FileEntry,
  FileGitStatus,
  FileSearchMode,
  CodexPolicy,
  DepType,
  AssociatedIntent,
  Delivery,
  DeliveryLog,
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
  SelfUpdateState,
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
  WorkspaceMemoryListItem,
  SlashCommandInfo,
  SysExtraMount,
  SystemSettings,
  TranscriptItem,
  VendorHostStatus,
  VendorId,
  VendorRuntimeStatus,
  WaitUserInvolveEvent,
  UserWorkspaceAccessAccount,
  WorkspaceInfo,
  WorkspaceDashboardRow,
  ImRobot,
  ImRobotTurnLog,
  ImIdentityBinding,
  ImIdentityChallengeCreated,
  ImIdentityChallengeSummary,
  ImGroupWorkspaceGrant,
  AppRegistrationManualSetupReason,
  AppRegistrationFailedReason,
} from '@ccc/shared/protocol'
import type { UiError } from '@ccc/shared/ui-codes'
import type { ApprovalRequest } from '@/components/SkillApprovalModal/SkillApprovalModal.vue'
import type { ProviderProbeState } from '@/lib/model-provider'

import {
  type TabKey,
  type WorkcenterPage,
  type SessionPageKind,
  type WorkspaceDirectoryPickerState,
  type FeishuAppRegistrationState,
  type MyImIdentityView,
  idleFeishuAppRegistration,
  emptyDirectoryPicker,
  sumSessionCounts,
  emptyOwnerCounts,
  runningSessionsFingerprint,
  runningSessionsFingerprintOf,
  sessionCacheKey,
  VIEW_MODE_KEY,
} from './types'

export function buildDeliverySlice() {
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
  /**
   * Delivery lifecycle logs, cached per DELIVERY id — the 「日志」 tab's content.
   * A missing key means "never fetched, or invalidated", which is exactly what
   * makes the tab lazy AND refreshable: every `delivery_detail` frame (the reply
   * to every delivery write) drops the key, so an open tab re-fetches at once and
   * a closed one re-fetches the next time it is opened.
   *
   * Keyed rather than flat so a reply that arrives after the user moved to
   * another delivery lands under ITS own id and can never be rendered as the open
   * delivery's trail.
   */
  const deliveryLogsById = ref<Record<string, DeliveryLog[]>>({})
  /**
   * The delivery id whose log fetch is in flight, or `null`. Deliberately an id
   * and not a boolean: a bare flag set by one delivery would render as 「加载中」
   * on the delivery the user switched to.
   */
  const deliveryLogsLoading = ref<string | null>(null)

  /**
   * The one-shot follow-up owed to a 「当前意图独立交付」 click: which intent the
   * next `create_delivery_result` must be linked to (and whose branch must then
   * be initialized). `null` = no standalone create in flight, which is also what
   * keeps a plain delivery-page create from being chained onto — and what makes
   * a second click a no-op while the first is still travelling.
   */
  const pendingStandaloneDelivery = ref<{ workspaceName: string; intentId: string } | null>(null)

  return {
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
    deliveryLogsById,
    deliveryLogsLoading,
    pendingStandaloneDelivery,
  } as const
}

export type DeliverySlice = ReturnType<typeof buildDeliverySlice>
