/**
 * Feature handler assembly — slice 1/3 (ADR-0009).
 *
 * Builds the EXHAUSTIVE `HandlerMap` from the per-feature handler modules and
 * returns a `HandlerRegistry`. Because the map is typed `HandlerMap`
 * (`{ [K in ClientToServer['type']]: Handler<K> }`), omitting any message type
 * is a COMPILE-TIME error — `pnpm typecheck` is the missed-handler gate.
 *
 * The map is assembled once at startup (`createHandlerRegistry`); per-connection
 * state stays on `Conn`, shared services on `KernelContext` — both injected at
 * dispatch time, not captured here.
 */
import {
  createHandlerRegistry,
  type HandlerMap,
  type HandlerRegistry,
} from '../transport/handler-registry.js'
import { ping, requestSessionStatus } from './meta/index.js'
import {
  getSettings,
  loadWorkspaceSettingHandler,
  saveSettingsHandler,
  saveWorkspaceSettingHandler,
} from './settings/index.js'
import { permissionResponse } from './permissions/index.js'
import { addWorkspaceHandler, removeWorkspaceHandler } from './workspaces/index.js'
import {
  createSession,
  createWorkSession,
  deleteSession,
  getSessionCounts,
  listCommandsHandler,
  listSessions,
  renameSession,
  selectSession,
  setMode,
  setSessionAgentHandler,
  rebindViewHandler,
  stopRunHandler,
  userPrompt,
} from './works/index.js'
import {
  deleteIntent,
  deleteIntentSession,
  createIntent,
  startIntentSession,
  discussionToIntent,
  listIntentLogsHandler,
  listIntentSessions,
  listIntentsHandler,
  newIntentSession,
  openIntentSession,
  openSpecSession,
  refineIntent,
  resetIntentSession,
  renameIntentSession,
  setIntentAutomate,
  setIntentGitInfo,
  startWorkflowHandler,
  startDevelopment,
  stopWorkflowHandler,
  createPrHandler,
  syncIntentPrStatusHandler,
  updateIntentContent,
  updateIntentDepsHandler,
  updateIntentStatus,
} from './intents/index.js'
import {
  approveSpecHandler,
  readSpecHandler,
  resetSpecSessionHandler,
  updateSpecContentHandler,
  writeSpecHandler,
} from './intents/spec.js'
import {
  continueDiscussion,
  createDiscussionHandler,
  discussionSpeak,
  listDiscussionsHandler,
  openDiscussion,
  pauseDiscussion,
  resumeDiscussion,
  startDiscussion,
} from './discussions/index.js'
import {
  createAutomationHandler,
  deleteAutomationHandler,
  getExecutionTranscript,
  getAutomationDetailHandler,
  getAutomationToolManifest,
  getWorkspaceMcpConfig,
  listAutomationsHandler,
  saveWorkspaceMcpConfig,
  automationRunNow,
  updateAutomationHandler,
} from './automations/index.js'
import { login, logout, setAdminPassword, removeAccount, setAdminAccount } from './auth/index.js'
import { listWaitUserEvents, updateWaitUserEvent } from './user-involve/index.js'
import { startRetentionCleanup } from './user-involve/store.js'
import {
  getTimeRangeStatsHandler,
  getWorkspaceDashboardHandler,
  setWorkspacesAutomationEnabledHandler,
} from './workcenter/index.js'
import { resolveSkillApproval as resolveSkillApprovalImpl } from '../kernel/skill-loader/approval.js'
import { getSkillLinkStatus, installSkillHandler } from './skills/index.js'
import {
  getCodeGitStatusHandler,
  listDirHandler,
  readFileHandler,
  searchCodesHandler,
} from './codes/index.js'

/**
 * The complete handler map. One entry per `ClientToServer['type']` — the
 * `HandlerMap` type makes a missing one a compile error (the exhaustiveness
 * gate from ADR-0009).
 */
export const handlerMap: HandlerMap = {
  // meta
  ping,
  request_session_status: requestSessionStatus,
  // settings
  get_settings: getSettings,
  save_settings: saveSettingsHandler,
  load_workspace_setting: loadWorkspaceSettingHandler,
  save_workspace_setting: saveWorkspaceSettingHandler,
  // permissions
  permission_response: permissionResponse,
  // workspaces
  add_workspace: addWorkspaceHandler,
  remove_workspace: removeWorkspaceHandler,
  // sessions
  list_sessions: listSessions,
  get_session_counts: getSessionCounts,
  list_dir: listDirHandler,
  read_file: readFileHandler,
  get_code_git_status: getCodeGitStatusHandler,
  search_codes: searchCodesHandler,
  list_commands: listCommandsHandler,
  create_session: createSession,
  create_work_session: createWorkSession,
  select_session: selectSession,
  delete_session: deleteSession,
  rename_session: renameSession,
  set_mode: setMode,
  set_session_agent: setSessionAgentHandler,
  stop_run: stopRunHandler,
  rebind_view: rebindViewHandler,
  user_prompt: userPrompt,
  // intents
  list_intents: listIntentsHandler,
  create_intent: createIntent,
  start_intent_session: startIntentSession,
  open_intent_session: openIntentSession,
  new_intent_session: newIntentSession,
  refine_intent: refineIntent,
  discussion_to_intent: discussionToIntent,
  list_intent_sessions: listIntentSessions,
  list_intent_logs: listIntentLogsHandler,
  rename_intent_session: renameIntentSession,
  delete_intent_session: deleteIntentSession,
  delete_intent: deleteIntent,
  start_development: startDevelopment,
  write_spec: writeSpecHandler,
  approve_spec: approveSpecHandler,
  open_spec_session: openSpecSession,
  reset_intent_session: resetIntentSession,
  reset_spec_session: resetSpecSessionHandler,
  read_spec: readSpecHandler,
  update_spec_content: updateSpecContentHandler,
  update_intent_content: updateIntentContent,
  update_intent_status: updateIntentStatus,
  set_intent_automate: setIntentAutomate,
  set_intent_git_info: setIntentGitInfo,
  update_intent_deps: updateIntentDepsHandler,
  start_workflow: startWorkflowHandler,
  stop_workflow: stopWorkflowHandler,
  create_pr: createPrHandler,
  sync_intent_pr_status: syncIntentPrStatusHandler,
  // discussions
  list_discussions: listDiscussionsHandler,
  create_discussion: createDiscussionHandler,
  open_discussion: openDiscussion,
  start_discussion: startDiscussion,
  pause_discussion: pauseDiscussion,
  resume_discussion: resumeDiscussion,
  discussion_speak: discussionSpeak,
  continue_discussion: continueDiscussion,
  // automations
  create_automation: createAutomationHandler,
  list_automations: listAutomationsHandler,
  update_automation: updateAutomationHandler,
  delete_automation: deleteAutomationHandler,
  get_automation_detail: getAutomationDetailHandler,
  get_execution_transcript: getExecutionTranscript,
  automation_run_now: automationRunNow,
  get_workspace_mcp_config: getWorkspaceMcpConfig,
  save_workspace_mcp_config: saveWorkspaceMcpConfig,
  get_automation_tool_manifest: getAutomationToolManifest,
  // auth (ADR-0023 runtime slice: basic login + multi-account / unique admin)
  login,
  logout,
  set_admin_password: setAdminPassword,
  remove_account: removeAccount,
  set_admin_account: setAdminAccount,
  // wait user involve
  list_wait_user_events: listWaitUserEvents,
  update_wait_user_event: updateWaitUserEvent,
  // workcenter
  get_timerange_stats: getTimeRangeStatsHandler,
  get_workspace_dashboard: getWorkspaceDashboardHandler,
  set_workspaces_automation_enabled: setWorkspacesAutomationEnabledHandler,
  // skill-load gates (mount layer 2/3)
  skill_load_approval_resolve: (_ctx, _conn, msg) => {
    resolveSkillApprovalImpl(msg.requestId, msg.decision)
  },
  // external skill install + link status (2026-06-12)
  get_skill_link_status: getSkillLinkStatus,
  install_skill: installSkillHandler,
}

/** Assemble the startup handler registry from the exhaustive map. */
export function registerHandlers(): HandlerRegistry {
  startRetentionCleanup()
  return createHandlerRegistry(handlerMap)
}
