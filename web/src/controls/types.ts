import type { createWsClient } from '@/lib/ws'
import type { PermissionMsg } from '@/lib/chat-types'
import type { PendingItem } from '@/lib/pending-queue'
import type {
  ActionTarget,
  ClientToServer,
  CodeGitStatus,
  CodeSearchHit,
  CodexPolicy,
  CreateAutomationInput,
  CreateIntentBase,
  DeliveryStatus,
  GitActionFailureGuidance,
  IntentSpecMode,
  IntentStatus,
  ModeToken,
  PromptImage,
  Automation,
  ServerToClient,
  SessionRunStatus,
  SessionInfo,
  SystemSettings,
  UiLang,
  UiTheme,
  UpdateAutomationInput,
  WaitUserInvolveEvent,
  WaitUserInvolveStatus,
  WorkspaceInfo,
  WorkspaceScopeMode,
  WorkspaceSetting as WorkspaceSettingType,
  QueueControlAction,
} from '@ccc/shared/protocol'
import type { AppState, AuthApi, DepType, TypedT } from './state'
import type { CreateIntentEvent } from '@/lib/create-intent-view'
import type { CreatePrEvent } from '@/lib/create-pr-view'
import type { DevLaunchEvent } from '@/lib/dev-launch-view'
import type { SpecLaunchEvent } from '@/lib/spec-launch-view'
import type { ShareTarget } from '@/lib/share-link'
import type { StandaloneDeliveryRequest } from '@/lib/delivery-view'

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
  maybeRestoreAutomations(list: WorkspaceInfo[]): void
  maybeRestoreCodes(list: WorkspaceInfo[]): void
  // Codes 内嵌 ChatColumn 的 per-workspace localStorage 持久化(best-effort)。
  readCodesChatWidth(workspaceName: string): number
  persistCodesChatWidth(workspaceName: string, px: number): void
  readCodesSessionId(workspaceName: string): string | null
  persistCodesSessionId(workspaceName: string, id: string | null): void

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
  addWorkspace(payload: { workspaceName: string; path: string }): void
  /** 请服务端在自己所在主机弹一次原生目录对话框,结果落在 `workspaceDirectoryPicker`。 */
  selectWorkspaceDirectory(): void
  removeWorkspace(workspaceName: string): void
  openNewSession(path: string): void
  confirmNewSession(agentId: string | null): void
  openSettingsFromPicker(): void
  openActionTarget(target: ActionTarget): void
  clearActionTarget(): void
  /**
   * View a session in the console. `row` is the clicked list row when the caller
   * has one: its real `sessionKind` / owner decide the open path (a `spec_review`
   * row is routed to `open_spec_review_session`, never to `select_session`). With
   * no row the loaded lists are searched for one.
   */
  selectSession(path: string, sessionId: string, row?: SessionInfo): void
  openWorkcenterSession(input: {
    workspaceName: string
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
  /**
   * Select an intent's latest work session INLINE for IntentDetail's work-session tab:
   * fill the global active session via `select_session` WITHOUT entering the console
   * (no top-level tab switch, no console pointer pin). The embedded ChatColumn binds
   * once the `session_selected` reply aligns `activeSession`. `openDevSession` above
   * keeps the old jump-to-works behaviour for external entry points.
   */
  selectWorkSession(sessionId: string): void

  // intents
  openIntents(path: string): void
  // Jump from a work session's title bar to its linked intent: switch to the intents
  // tab for `path` and request Intents.vue select `intentId` once its list lands.
  openLinkedIntent(path: string, intentId: string): void
  setIntentFilter(status: IntentStatus | null): void
  refineIntent(intentId: string): void
  writeSpec(intentId: string): void
  approveSpec(intentId: string): void
  /** Revoke a spec approval (human or machine); returns the intent to awaiting-approval. */
  revokeSpecApproval(intentId: string): void
  /** Open an intent's spec-authoring session in the detail's `spec session` tab. */
  openSpecSession(intentId: string): void
  /**
   * Open an intent's spec-REVIEW session for read-only replay (detail review tab /
   * aggregated「规范」list row). Resolved server-side from the intent's own
   * `specReviewSessionId`; never falls back to `select_session`. `workspaceName`
   * defaults to the intents page's current workspace.
   */
  openSpecReviewSession(intentId: string, workspaceName?: string): void
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
  startDevelopment(
    intentId: string,
    hasUnfinishedDeps: boolean,
    opts?: {
      /** Which delivery this session develops against; omit to let the server resolve it. */
      deliveryId?: string
      /** One-shot dependency-gate override — only ever set from the escape dialog. */
      forceDependencyGate?: boolean
    },
  ): void
  /** Execute one of the two explicit exits from a worktree baseline mismatch. */
  repairIntentWorktree(intentId: string, mode: 'rebuild' | 'merge'): void
  /** 「同步主线」— merge `origin/<base_branch>` into an integrating delivery's branch. */
  syncDeliveryMainline(deliveryId: string): void
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
  deleteIntent(intentId: string): void
  /** Directly edit an intent's markdown body (only `draft` / `todo`; server-gated). */
  updateIntentContent(intentId: string, content: string): void
  /**
   * Directly overwrite an intent's centralized spec Markdown source (server-gated:
   * spec exists, not started, no live spec session). Sends `update_spec_content`
   * then re-reads via `read_spec` so the spec tab renders the saved content.
   */
  saveSpecContent(intentId: string, content: string): void
  setIntentAutomate(intentId: string, automateOn: boolean): void
  /**
   * Set (or clear) an intent's per-intent spec-mode override. `null` restores
   * inheritance of the workspace `sddEnabled`; the value is always sent
   * explicitly, so it never means "leave as is". Fire-and-forget: the resolved
   * `effectiveSpecMode` comes back with the next `intents` broadcast.
   */
  setIntentSpecMode(intentId: string, mode: IntentSpecMode | null): void
  updateIntentDeps(intentId: string, deps: { dependsOnId: string; depType: DepType }[]): void
  /**
   * Create a PR for an intent. `deliveryId` names the delivery whose branch the
   * PR targets; omitted means the workspace's main branch. The server re-resolves
   * and re-validates it either way — the argument only carries the choice the UI
   * could already see.
   */
  createPr(intentId: string, deliveryId?: string): void
  /**
   * Re-run the intent action a Git/forge failure came from, on the user's
   * explicit request. It re-enters the SAME entry point (`startDevelopment` /
   * `createPr`) with its confirmations, progress overlay and server gates intact
   * — a retry is a new attempt, never a bypass.
   */
  retryIntentAction(guidance: GitActionFailureGuidance): void
  /** Fold one create-PR overlay event through the reducer + handle close side-effects. */
  dispatchCreatePr(ev: CreatePrEvent): void
  syncIntentPrStatus(intentId: string): void
  startWorkflow(): void
  stopWorkflow(): void

  // automation queue page (deterministic scheduling kernel)
  openQueuePage(): void
  closeQueuePage(): void
  refreshQueueDetail(): void
  queueControl(action: QueueControlAction, intentId?: string): void
  selectIntentSession(sessionId: string): void
  /**
   * Create one intent. The payload (from the create dialog) also carries the
   * first turn of its session and the chosen base branch; omitting it keeps the
   * blank registration older callers rely on.
   */
  createIntent(payload?: { content: string; base: CreateIntentBase }): void
  /**
   * Fold one create-intent overlay event through the reducer + handle close
   * side-effects. Only the with-content path has an overlay to fold into; a
   * blank registration completes at once and never arms one.
   */
  dispatchCreateIntent(ev: CreateIntentEvent): void
  /** Open the create dialog (and refresh the deliveries it picks from). */
  openCreateIntentDialog(): void
  /** Cancel the create dialog. A successful create closes it from the handler. */
  closeCreateIntentDialog(): void
  startIntentSession(intentId: string, text: string, images: PromptImage[]): void

  // deliveries (交付作为集成单元, ADR-0036)
  openDeliveries(path: string): void
  openDelivery(deliveryId: string): void
  createDelivery(payload: {
    title: string
    description?: string
    startDate?: number | null
    endDate?: number | null
  }): void
  updateDelivery(payload: {
    deliveryId: string
    title?: string
    description?: string
    startDate?: number | null
    endDate?: number | null
  }): void
  cancelDelivery(deliveryId: string): void
  transitionDelivery(to: DeliveryStatus, confirmVerified?: boolean): void
  /** Explicit, retryable remote-branch init for the open delivery. */
  initDeliveryBranch(payload: { mode: 'create' | 'bind'; branchName: string }): void
  /** Manual cleanup of a TERMINAL delivery's local branch reference. */
  cleanupDeliveryBranch(deliveryId: string): void
  /** Open the delivery PR (「交付分支 → 主线」); the server adopts an existing one. */
  createDeliveryPr(deliveryId: string): void
  /** Pull the delivery PR's live forge facts and let the server settle them. */
  syncDeliveryPr(deliveryId: string): void
  /** Link an intent to the open delivery (association edge only — no PR is re-targeted). */
  linkIntentToDelivery(intentId: string): void
  /** Unlink an intent from the open delivery; the server closes its unmerged PR first. */
  unlinkIntentFromDelivery(intentId: string): void
  /** Open a delivery's detail from the intent page's "关联交付" link (switches tab). */
  openDeliveryFromIntent(workspaceName: string, deliveryId: string): void

  // Intent-side delivery entries. Same wire messages as the delivery page's, but
  // every id is explicit: the intent page acts on ITS workspace and a delivery
  // the user just picked, not on the delivery tab's open delivery.
  /** Fetch a workspace's deliveries so the intent-side link picker has candidates. */
  loadDeliveriesForLink(workspaceName: string): void
  linkIntentDelivery(workspaceName: string, deliveryId: string, intentId: string): void
  unlinkIntentDelivery(workspaceName: string, deliveryId: string, intentId: string): void
  /** Branch init for an explicitly named delivery (the standalone-delivery chain's last step). */
  initDeliveryBranchFor(
    workspaceName: string,
    deliveryId: string,
    branchName: string,
    mode: 'create' | 'bind',
  ): void
  /**
   * 「当前意图独立交付」: create a delivery for this intent alone. Sends only the
   * create; the link + branch init are chained off `create_delivery_result`.
   */
  createStandaloneDelivery(payload: StandaloneDeliveryRequest): void
  onDeliveryMobileBack(targetKey: string): void

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
  /** Bind the global active session to a discussion's research session (研究会话 tab). */
  openResearchSession(sessionId: string): void

  // automations
  openAutomations(path: string): void
  onSelectAutomation(id: string): void
  onLoadExecutionSession(executionId: string): void
  onSelectExecution(id: string): void
  onAutomationMobileBack(targetKey: string): void
  onToggleAutomationEnabled(id: string, enabled: boolean): void
  /** Flip the workspace-level automation gate for the current automations workspace. */
  setAutomationEnabled(enabled: boolean): void
  runNowAutomation(id: string): void
  openAutomationForm(target: Automation | null): void
  createAutomation(input: CreateAutomationInput): void
  createAutomationFromTemplate(templateId: string): void
  importAutomations(inputs: CreateAutomationInput[]): void
  updateAutomation(id: string, input: UpdateAutomationInput): void
  deleteAutomation(id: string): void
  onLoadAutomationToolManifest(vendor: string): void

  // codes (read-only file browser)
  openCodes(workspaceName: string): void
  loadCodesDir(rel: string): void
  refreshCodesTree(): void
  /** Request the workspace Git-status snapshot (coalesced while one is in flight). */
  requestCodesGitStatus(): void
  /** Adopt a `code_git_status` reply (authoritative replace for the current workspace). */
  applyCodeGitStatus(workspaceName: string, files: Record<string, CodeGitStatus>): void
  toggleCodesDir(rel: string): void
  openCodeFile(path: string, line?: number): void
  closeCodeTab(path: string): void
  setCodesActiveTab(path: string): void
  setCodesSearchMode(mode: 'filename' | 'content'): void
  runCodeSearch(): void
  openCodeSearchHit(hit: CodeSearchHit): void
  /** Navigate to a file from a markdown code link: switch to codes tab, expand ancestors, open file. */
  navigateToCodeFile(path: string, line?: number): void
  // Codes 内嵌 ChatColumn:空态「+ 新建」/ 标题栏「↻ 重置」都创建一个普通 work
  // session(不弹 agent 选择弹窗,沿用 workspace 默认 agent)。
  createCodesChatSession(workspaceName: string): void
  resetCodesChatSession(workspaceName: string): void

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
  openPersonalizedSetting(): void
  openWorkspaceSetting(): void
  saveWorkspaceSetting(config: WorkspaceSettingType): void
  /** Read-only refresh of the workspace-setting page's local observation section. */
  loadParkRecoveryStats(): void
  querySkillLinkStatus(): void
  installSkill(skillId: string): void
  saveSettings(settings: SystemSettings): void
  /** Probe runnable vendors and persist a system-mode agent for each without one. */
  autoConfigureAgents(): void
  setAdminPassword(payload: { username: string; password: string; currentPassword?: string }): void
  removeAccount(payload: { username: string }): void
  setAdminAccount(payload: { username: string }): void
  /** Load THIS identity's own external-MCP keys (metadata only). */
  fetchMyMcpApiKeys(): void
  /** Mint a key for this identity; the reply carries its plaintext exactly once. */
  createMyMcpApiKey(payload: { name: string }): void
  /** Replace one of my keys' secrets in place — same key, new secret, no grace period. */
  resetMyMcpApiKey(payload: { id: string }): void
  /** Revoke one of my keys — effective on that key's very next request. */
  revokeMyMcpApiKey(payload: { id: string }): void
  /** Drop the one-time plaintext from memory; after this it is unrecoverable. */
  dismissMyMcpApiKeyReveal(): void
  /** Load the account × workspace access roster (administrator-only server-side). */
  fetchUserWorkspaceAccess(): void
  /** Replace ONE account's workspace policy with the complete submitted set. */
  saveUserWorkspaceAccess(payload: {
    subject: string
    mode: WorkspaceScopeMode
    workspaces: string[]
  }): void
  /** Refresh the current workspace's read-only effective-accessor list. */
  fetchWorkspaceAccessors(): void
  /** Close the system-settings panel. */
  closeSettings(): void
  /** Close the personalized-settings page, dropping any still-revealed plaintext key. */
  closePersonalizedSetting(): void
  /** Jump from the workspace-setting page to system settings (baseUrl). */
  openSettingsFromWorkspaceSetting(): void
  /** Jump from the personal key page to system settings (baseUrl). */
  openSettingsFromPersonalizedSetting(): void
  fetchPersonalizedSettings(): void
  setLocale(next: UiLang): void
  setTheme(next: UiTheme): void
  /** Set the console UI font scale (percent, 70–120) live and persist it for the identity. */
  setFontScale(next: number): void
  setViewMode(mode: 'workspace' | 'workcenter'): void
  approveSkillLoad(requestId: string): void
  cancelSkillLoad(requestId: string): void
  dismissSkillApproval(): void

  // self-update (顶栏「重启以更新」)
  /** Start or retry staging the newest release. */
  startSelfUpdate(): void
  /** Swap in the staged binary and restart the server (drops every connection). */
  applySelfUpdate(): void
  /** Abandon the in-flight download or discard the staged package. */
  cancelSelfUpdate(): void

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
  // workcenter dashboard
  /** Switch the Workcenter page-internal nav; loads the newly-active page. */
  setWorkcenterPage(page: 'dashboard' | 'notifications'): void
  /** (Re)fetch the cross-workspace Dashboard snapshot; coalesces while one is in flight. */
  loadDashboard(): void
  /** Refresh the Dashboard only when it is the active view (domain-broadcast hook). */
  maybeRefreshDashboard(): void
  /** Set one workspace row's automation gate directly from its switch (admin only). */
  toggleWorkspaceAutomation(workspaceName: string, enabled: boolean): void
}

// The shared controller context: reactive state + runtime plumbing + all the
// domain methods. Installers read state/other-methods off this object so any
// cross-domain call resolves through late binding (definition order doesn't
// matter), while staying fully typed.
export type AppCtx = AppState & AppRuntime & AppMethods
