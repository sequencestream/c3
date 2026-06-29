import type { createWsClient } from '@/lib/ws'
import type { PermissionMsg } from '@/lib/chat-types'
import type { PendingItem } from '@/lib/pending-queue'
import type {
  ClientToServer,
  CodeSearchHit,
  CodexPolicy,
  CreateScheduleInput,
  IntentStatus,
  ModeToken,
  PromptImage,
  Schedule,
  ServerToClient,
  SessionRunStatus,
  SessionInfo,
  SystemSettings,
  UiLang,
  UpdateScheduleInput,
  WaitUserInvolveEvent,
  WaitUserInvolveStatus,
  WorkspaceInfo,
  WorkspaceSetting as WorkspaceSettingType,
} from '@ccc/shared/protocol'
import type { AppState, AuthApi, DepType, TypedT } from './state'
import type { DevLaunchEvent } from '@/lib/dev-launch-view'
import type { SpecLaunchEvent } from '@/lib/spec-launch-view'

export type WsClient = ReturnType<typeof createWsClient>

// Runtime plumbing attached to the shared ctx by `useAppController`.
export interface AppRuntime {
  // The live WS client, (re)assigned on (re)connect; null before the first connect.
  client: WsClient | null
  // Send a message over the live client (no-op when not connected).
  send(msg: ClientToServer): void
  // Force a fresh handshake (used after login mints a token).
  reconnect(): void
  // The typed i18n translator (bound to the component composer) + auth store.
  t: TypedT
  auth: AuthApi
}

// Every method attached to the ctx by the domain installers. Listing them here
// keeps the cross-module call surface a compile-time contract (no `any` escape).
export interface AppMethods {
  // persistence
  readStoredWorkspace(): string | null
  persistCurrentWorkspace(): void
  persistViewMode(): void
  maybeRestoreIntents(list: WorkspaceInfo[]): void
  maybeRestoreDiscussions(list: WorkspaceInfo[]): void
  maybeRestoreSchedules(list: WorkspaceInfo[]): void
  maybeRestoreCodes(list: WorkspaceInfo[]): void

  // product license (ADR-0026): open LS sign-in to get a key
  activateLicense(): void
  // product license (PL-R7): actively sync the term via one heartbeat now
  refreshLicense(): void

  // message handler
  handleMessage(msg: ServerToClient): void
  applyStatuses(statuses: SessionRunStatus[]): void
  notifyAwaitingPermission(id: string): void

  // session / workspace / tab navigation
  refreshSessions(path: string | null): void
  selectSessionKind(kind: import('./state').SessionPageKind): void
  ensureSessions(path: string | null): void
  loadMoreSessions(path: string | null): void
  selectWorkspace(path: string): void
  addWorkspace(path: string): void
  removeWorkspace(path: string): void
  openNewSession(path: string): void
  confirmNewSession(agentId: string | null): void
  openSettingsFromPicker(): void
  selectSession(path: string, sessionId: string): void
  jumpSessionSource(path: string, session: SessionInfo): void
  onSelectTab(key: string): void
  enterConsole(): void
  switchToConsoleTab(): void
  bindConsoleSession(): void
  clearViewedSession(): void
  deleteSession(path: string, sessionId: string): void
  renameSession(path: string, sessionId: string, title: string): void
  openDevSession(sessionId: string): void

  // intents
  openIntents(path: string): void
  // Jump from a work session's title bar to its linked intent: switch to the intents
  // tab for `path` and request Intents.vue select `intentId` once its list lands.
  openLinkedIntent(path: string, intentId: string): void
  setIntentFilter(status: IntentStatus | null): void
  refineIntent(intentId: string): void
  writeSpec(intentId: string): void
  approveSpec(intentId: string): void
  /** Open an intent's spec-authoring session in the detail's `spec session` tab. */
  openSpecSession(intentId: string): void
  /**
   * Fetch the intent's `spec.md` for the detail's `spec` tab. Specs live OUTSIDE
   * the workspace under the centralized root, so this sends `read_spec` (keyed by
   * intent id); `specPath` is the awaited absolute reply path.
   */
  readIntentSpec(intentId: string, specPath: string): void
  /** Reset the intent's refine session: new input + intent content → fresh session. */
  resetIntentSession(intentId: string, userInput: string): void
  /** Reset the intent's spec session: new input + current spec content → fresh session. */
  resetSpecSession(intentId: string, userInput: string): void
  startDevelopment(intentId: string, hasUnfinishedDeps: boolean): void
  /** Fold one dev-launch overlay event through the reducer + handle close side-effects. */
  dispatchDevLaunch(ev: DevLaunchEvent): void
  /**
   * After a Start-Dev `ready` close, arm the ~1s delayed jump: flip to the console
   * tab and select the intent's newly-launched work session (`lastDevSessionId`).
   * No-op when the intent has no dev session id yet.
   */
  armWorkSessionJump(intentId: string): void
  /** Consume the one-shot pending work-session select once the target lands in the list. */
  consumePendingWorkSessionSelect(): void
  dispatchSpecLaunch(ev: SpecLaunchEvent): void
  setIntentStatus(intentId: string, status: IntentStatus): void
  setIntentAutomate(intentId: string, automateOn: boolean): void
  updateIntentDeps(intentId: string, deps: { dependsOnId: string; depType: DepType }[]): void
  createPr(intentId: string): void
  startAutomation(): void
  stopAutomation(): void
  newIntentChat(): void
  selectIntentSession(sessionId: string): void
  renameIntentSession(sessionId: string, title: string): void
  deleteIntentSession(sessionId: string): void

  // discussions
  openDiscussions(path: string): void
  openDiscussion(discussionId: string): void
  onDiscussionMobileBack(targetKey: string): void
  createDiscussion(payload: {
    type: string
    goal: string
    context: string
    participantAgentIds: string[]
    organizerAgentId: string
  }): void
  startDiscussion(): void
  pauseDiscussion(): void
  resumeDiscussion(): void
  convertDiscussionToIntent(): void
  submitDiscussionInput(): void

  // schedules
  openSchedules(path: string): void
  onSelectSchedule(id: string): void
  onLoadExecutionSession(executionId: string): void
  onSelectExecution(id: string): void
  onScheduleMobileBack(targetKey: string): void
  onToggleScheduleEnabled(id: string, enabled: boolean): void
  runNowSchedule(id: string): void
  openScheduleForm(target: Schedule | null): void
  createSchedule(input: CreateScheduleInput): void
  createScheduleFromTemplate(templateId: string): void
  updateSchedule(id: string, input: UpdateScheduleInput): void
  deleteSchedule(id: string): void
  onLoadScheduleToolManifest(vendor: string): void

  // codes (read-only file browser)
  openCodes(workspaceId: string): void
  loadCodesDir(rel: string): void
  toggleCodesDir(rel: string): void
  openCodeFile(path: string, line?: number): void
  closeCodeTab(path: string): void
  setCodesActiveTab(path: string): void
  setCodesSearchMode(mode: 'filename' | 'content'): void
  runCodeSearch(): void
  openCodeSearchHit(hit: CodeSearchHit): void

  // chat / queue
  onSubmit(text: string, images?: PromptImage[]): void
  onContinue(): void
  stopRun(): void
  refreshStatus(): void
  setMode(next: ModeToken): void
  setCodexPolicy(policy: CodexPolicy): void
  onSetSessionAgent(agentId: string): void
  respond(m: PermissionMsg, decision: 'allow' | 'deny'): void
  submitAsk(m: PermissionMsg, answers: Record<string, string>): void
  listCommands(): void
  onEnqueue(text: string, images?: PromptImage[]): void
  onDeleteQueued(id: number): void
  onEditQueued(item: PendingItem): void
  flushIfReady(): void

  // settings / skills / view mode
  openSettings(): void
  openWorkspaceSetting(): void
  saveWorkspaceSetting(config: WorkspaceSettingType): void
  querySkillLinkStatus(): void
  installSkill(skillId: string): void
  saveSettings(settings: SystemSettings): void
  setAdminPassword(payload: { username: string; password: string; currentPassword?: string }): void
  removeAccount(payload: { username: string }): void
  setAdminAccount(payload: { username: string }): void
  setLocale(next: UiLang): void
  setViewMode(mode: 'workspace' | 'workcenter'): void
  approveSkillLoad(requestId: string): void
  cancelSkillLoad(requestId: string): void
  dismissSkillApproval(): void

  // workcenter
  respondWorkcenter(event: WaitUserInvolveEvent, decision: 'allow' | 'deny'): void
  submitAskWorkcenter(event: WaitUserInvolveEvent, answers: Record<string, string>): void
  jumpToSource(event: WaitUserInvolveEvent): void
  /** Re-fetch the first WorkCenter event page for a status. */
  reloadWorkcenter(status?: WaitUserInvolveStatus): void
  /** Fetch the next WorkCenter event page using the last visible row as cursor. */
  loadMoreWorkcenter(
    status: WaitUserInvolveStatus | undefined,
    cursorTime: number,
    cursorExcludeId: string,
  ): void
  /** Mark a todo event done from the WorkCenter list. */
  markDoneWorkcenter(eventId: string): void
}

// The shared controller context: reactive state + runtime plumbing + all the
// domain methods. Installers read state/other-methods off this object so any
// cross-domain call resolves through late binding (definition order doesn't
// matter), while staying fully typed.
export type AppCtx = AppState & AppRuntime & AppMethods
