import type { createWsClient } from '@/lib/ws'
import type { PermissionMsg } from '@/lib/chat-types'
import type { PendingItem } from '@/lib/pending-queue'
import type {
  ClientToServer,
  CodeSearchHit,
  CodexPolicy,
  CreateAutomationInput,
  IntentStatus,
  ModeToken,
  PromptImage,
  Automation,
  ServerToClient,
  SessionRunStatus,
  SessionInfo,
  SystemSettings,
  UiLang,
  UpdateAutomationInput,
  WaitUserInvolveEvent,
  WaitUserInvolveStatus,
  WorkspaceInfo,
  WorkspaceSetting as WorkspaceSettingType,
} from '@ccc/shared/protocol'
import type { AppState, AuthApi, DepType, TypedT } from './state'
import type { DevLaunchEvent } from '@/lib/dev-launch-view'
import type { SpecLaunchEvent } from '@/lib/spec-launch-view'
import type { ShareTarget } from '@/lib/share-link'

export type WsClient = ReturnType<typeof createWsClient>

/** The `simulate_automation_trigger` client message (for the diagnostic panel action). */
export type SimulateAutomationTriggerMsg = Extract<
  ClientToServer,
  { type: 'simulate_automation_trigger' }
>

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
  maybeRestoreAutomations(list: WorkspaceInfo[]): void
  maybeRestoreCodes(list: WorkspaceInfo[]): void
  // Codes 内嵌 ChatColumn 的 per-workspace localStorage 持久化(best-effort)。
  readCodesChatWidth(workspaceId: string): number
  persistCodesChatWidth(workspaceId: string, px: number): void
  readCodesSessionId(workspaceId: string): string | null
  persistCodesSessionId(workspaceId: string, id: string | null): void

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
  removeWorkspace(workspaceId: string): void
  openNewSession(path: string): void
  confirmNewSession(agentId: string | null): void
  openSettingsFromPicker(): void
  selectSession(path: string, sessionId: string): void
  openWorkcenterSession(input: {
    workspaceId: string
    sessionKind: string | null | undefined
    sessionId: string | null
    title?: string | null
    updatedAt?: number | null
  }): void
  jumpSessionSource(path: string, session: SessionInfo): void
  jumpActiveSessionSource(): void
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
  /** Fetch the intent's lifecycle-log entries for the detail's changelog tab. */
  listIntentLogs(intentId: string): void
  /** Reset the intent's refine session: new input + intent content → fresh session. */
  resetIntentSession(intentId: string, userInput: string): void
  /** Reset the intent's spec session: new input + current spec content → fresh session. */
  resetSpecSession(intentId: string, userInput: string): void
  startDevelopment(intentId: string, hasUnfinishedDeps: boolean): void
  /** Fold one dev-launch overlay event through the reducer + handle close side-effects. */
  dispatchDevLaunch(ev: DevLaunchEvent): void
  /**
   * After a Start-Dev `ready` close, arm the ~1s delayed jump: flip to the console
   * tab and select the intent's newly-launched work session (`lastWorkSessionId`)
   * once the intent projection and work-session row are both available.
   */
  armWorkSessionJump(intentId: string): void
  /** Consume the one-shot pending work-session select once the target lands in the list. */
  consumePendingWorkSessionSelect(refreshOnResolvedTarget?: boolean): void
  dispatchSpecLaunch(ev: SpecLaunchEvent): void
  setIntentStatus(intentId: string, status: IntentStatus): void
  /** Directly edit an intent's markdown body (only `draft` / `todo`; server-gated). */
  updateIntentContent(intentId: string, content: string): void
  setIntentAutomate(intentId: string, automateOn: boolean): void
  updateIntentDeps(intentId: string, deps: { dependsOnId: string; depType: DepType }[]): void
  createPr(intentId: string): void
  syncIntentPrStatus(intentId: string): void
  startWorkflow(): void
  stopWorkflow(): void
  selectIntentSession(sessionId: string): void
  newIntentSession(): void

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

  // automations
  openAutomations(path: string): void
  onSelectAutomation(id: string): void
  onLoadExecutionSession(executionId: string): void
  onSelectExecution(id: string): void
  onAutomationMobileBack(targetKey: string): void
  onToggleAutomationEnabled(id: string, enabled: boolean): void
  runNowAutomation(id: string): void
  openAutomationForm(target: Automation | null): void
  createAutomation(input: CreateAutomationInput): void
  createAutomationFromTemplate(templateId: string): void
  updateAutomation(id: string, input: UpdateAutomationInput): void
  deleteAutomation(id: string): void
  onLoadAutomationToolManifest(vendor: string): void
  simulateAutomationTrigger(input: Omit<SimulateAutomationTriggerMsg, 'type'>): void

  // codes (read-only file browser)
  openCodes(workspaceId: string): void
  loadCodesDir(rel: string): void
  refreshCodesTree(): void
  toggleCodesDir(rel: string): void
  openCodeFile(path: string, line?: number): void
  closeCodeTab(path: string): void
  setCodesActiveTab(path: string): void
  setCodesSearchMode(mode: 'filename' | 'content'): void
  runCodeSearch(): void
  openCodeSearchHit(hit: CodeSearchHit): void
  // Codes 内嵌 ChatColumn:空态「+ 新建」/ 标题栏「↻ 重置」都创建一个普通 work
  // session(不弹 agent 选择弹窗,沿用 workspace 默认 agent)。
  createCodesChatSession(workspaceId: string): void
  resetCodesChatSession(workspaceId: string): void

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

  // share (三处标题栏的「分享」按钮:拼深链 + 写剪贴板 + toast)
  shareLink(target: ShareTarget): void

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
