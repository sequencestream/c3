import type {
  ImIdentityBinding,
  ImIdentityChallengeSummary,
  SessionKind,
  SessionOwnerKind,
  SessionRunStatus,
  SessionStatus,
} from '@ccc/shared/protocol'
import type { UiError } from '@ccc/shared/ui-codes'
import { useTypedI18n } from '@/i18n'
import { useModeLabel } from '@/composables/useModeLabel'
import { useAuth } from '@/composables/useAuth'
import type {
  AppRegistrationFailedReason,
  AppRegistrationManualSetupReason,
} from '@ccc/shared/protocol'

export type TypedT = ReturnType<typeof useTypedI18n>['t']
export type ModeLabel = ReturnType<typeof useModeLabel>
export type AuthApi = ReturnType<typeof useAuth>

export type MyImIdentityView = {
  bindings: ImIdentityBinding[]
  pendingChallenges: ImIdentityChallengeSummary[]
  noAuthLocalHint: boolean
}

/** UI phase of the one-click Feishu app registration, mirrored from the wire. */
export type FeishuRegistrationPhase =
  | 'idle'
  | 'starting'
  | 'waiting_scan'
  | 'slow_down'
  | 'configuring'
  | 'ready'
  | 'manual_setup_required'
  | 'failed'

/**
 * Per-connection one-click registration view state. Credentials from a
 * terminal result live here in memory until the form is saved or closed.
 */
export interface FeishuAppRegistrationState {
  requestId: string | null
  phase: FeishuRegistrationPhase
  verificationUrl: string | null
  expiresAt: number | null
  appId: string | null
  appSecret: string | null
  manualSetupReason: AppRegistrationManualSetupReason | null
  failedReason: AppRegistrationFailedReason | null
  detail: string | null
}

export function idleFeishuAppRegistration(): FeishuAppRegistrationState {
  return {
    requestId: null,
    phase: 'idle',
    verificationUrl: null,
    expiresAt: null,
    appId: null,
    appSecret: null,
    manualSetupReason: null,
    failedReason: null,
    detail: null,
  }
}

/** True while a request is in flight and the form must lock its credentials. */
export function isFeishuRegistrationActive(s: FeishuAppRegistrationState): boolean {
  return (
    s.phase === 'starting' ||
    s.phase === 'waiting_scan' ||
    s.phase === 'slow_down' ||
    s.phase === 'configuring'
  )
}

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
export const FILES_PROJECT_KEY = 'c3.filesProject'
export const CURRENT_WS_KEY = 'c3.currentWorkspace'
export const WORK_SESSION_QUERY_START_TIME_KEY = 'work_session_query_start_time'
export const FILES_CHAT_WIDTH_KEY = 'chatWidth'
export const FILES_CHAT_SESSION_KEY = 'sessionId'
export const FILES_CHAT_WIDTH_DEFAULT = 360
export const FILES_CHAT_WIDTH_MIN = 240
export const FILES_CHAT_WIDTH_MAX = 720

export type TabKey = 'console' | 'intents' | 'deliveries' | 'discussion' | 'automations' | 'files'

/** The pages the workcenter view can show, in top-bar order. */
export type WorkcenterPage = 'notifications' | 'dashboard' | 'robots'

export type SessionPageKind = Exclude<SessionKind, 'consensus' | 'robot'>

export const SESSION_PAGE_KINDS: readonly SessionPageKind[] = [
  'work',
  'intent',
  'spec',
  'spec_review',
  'discussion',
  'automation',
  'tool',
]

export function sessionCacheKey(workspaceName: string, sessionKind: SessionPageKind): string {
  return `${workspaceName}::${sessionKind}`
}

export interface WorkspaceDirectoryPickerState {
  requestId: string | null
  pending: boolean
  error: UiError | null
  selection: { path: string } | null
}

export function emptyDirectoryPicker(): WorkspaceDirectoryPickerState {
  return { requestId: null, pending: false, error: null, selection: null }
}

export function sumSessionCounts(counts: Record<SessionPageKind, number>): number {
  return SESSION_PAGE_KINDS.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0)
}

export function emptyOwnerCounts(): Record<SessionOwnerKind, number> {
  return { intent: 0, discussion: 0, automation: 0 }
}

export function runningSessionsFingerprint(statuses: Record<string, SessionStatus>): string {
  return Object.keys(statuses)
    .filter((id) => statuses[id] !== 'idle')
    .sort()
    .join(',')
}

export function runningSessionsFingerprintOf(statuses: SessionRunStatus[]): string {
  return statuses
    .filter((s) => s.status !== 'idle')
    .map((s) => s.sessionId)
    .sort()
    .join(',')
}
