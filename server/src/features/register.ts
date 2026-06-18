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
  deleteSession,
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
  deleteIntentSession,
  discussionToIntent,
  listIntentSessions,
  listIntentsHandler,
  newIntentChat,
  openIntentChat,
  refineIntent,
  renameIntentSession,
  setIntentAutomate,
  setIntentGitInfo,
  startAutomationHandler,
  startDevelopment,
  stopAutomationHandler,
  createPrHandler,
  updateIntentDepsHandler,
  updateIntentStatus,
} from './intents/index.js'
import { approveSpecHandler, writeSpecHandler } from './intents/spec.js'
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
  createScheduleHandler,
  deleteScheduleHandler,
  getExecutionTranscript,
  getScheduleDetailHandler,
  getScheduleToolManifest,
  getWorkspaceMcpConfig,
  listSchedulesHandler,
  saveWorkspaceMcpConfig,
  scheduleRunNow,
  updateScheduleHandler,
} from './schedules/index.js'
import { login, logout, setAdminPassword, removeAccount, setAdminAccount } from './auth/index.js'
import { listWaitUserEvents } from './user-involve/index.js'
import { getTimeRangeStatsHandler } from './workcenter/index.js'
import { resolveSkillApproval as resolveSkillApprovalImpl } from '../kernel/skill-loader/approval.js'
import { getSkillLinkStatus, installSkillHandler } from './skills/index.js'
import { listDirHandler, readFileHandler, searchCodesHandler } from './codes/index.js'
import { getLicense, refreshLicense, startLicenseActivation } from './license/index.js'

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
  list_dir: listDirHandler,
  read_file: readFileHandler,
  search_codes: searchCodesHandler,
  list_commands: listCommandsHandler,
  create_session: createSession,
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
  open_intent_chat: openIntentChat,
  new_intent_chat: newIntentChat,
  refine_intent: refineIntent,
  discussion_to_intent: discussionToIntent,
  list_intent_sessions: listIntentSessions,
  rename_intent_session: renameIntentSession,
  delete_intent_session: deleteIntentSession,
  start_development: startDevelopment,
  write_spec: writeSpecHandler,
  approve_spec: approveSpecHandler,
  update_intent_status: updateIntentStatus,
  set_intent_automate: setIntentAutomate,
  set_intent_git_info: setIntentGitInfo,
  update_intent_deps: updateIntentDepsHandler,
  start_automation: startAutomationHandler,
  stop_automation: stopAutomationHandler,
  create_pr: createPrHandler,
  // discussions
  list_discussions: listDiscussionsHandler,
  create_discussion: createDiscussionHandler,
  open_discussion: openDiscussion,
  start_discussion: startDiscussion,
  pause_discussion: pauseDiscussion,
  resume_discussion: resumeDiscussion,
  discussion_speak: discussionSpeak,
  continue_discussion: continueDiscussion,
  // schedules
  create_schedule: createScheduleHandler,
  list_schedules: listSchedulesHandler,
  update_schedule: updateScheduleHandler,
  delete_schedule: deleteScheduleHandler,
  get_schedule_detail: getScheduleDetailHandler,
  get_execution_transcript: getExecutionTranscript,
  schedule_run_now: scheduleRunNow,
  get_workspace_mcp_config: getWorkspaceMcpConfig,
  save_workspace_mcp_config: saveWorkspaceMcpConfig,
  get_schedule_tool_manifest: getScheduleToolManifest,
  // auth (ADR-0023 runtime slice: basic login + multi-account / unique admin)
  login,
  logout,
  set_admin_password: setAdminPassword,
  remove_account: removeAccount,
  set_admin_account: setAdminAccount,
  // wait user involve
  list_wait_user_events: listWaitUserEvents,
  // workcenter
  get_timerange_stats: getTimeRangeStatsHandler,
  // skill-load gates (mount layer 2/3)
  skill_load_approval_resolve: (_ctx, _conn, msg) => {
    resolveSkillApprovalImpl(msg.requestId, msg.decision)
  },
  // external skill install + link status (2026-06-12)
  get_skill_link_status: getSkillLinkStatus,
  install_skill: installSkillHandler,
  // product-license (ADR-0026): surface state + open browser-mediated binding
  get_license: getLicense,
  refresh_license: refreshLicense,
  start_license_activation: startLicenseActivation,
}

/** Assemble the startup handler registry from the exhaustive map. */
export function registerHandlers(): HandlerRegistry {
  return createHandlerRegistry(handlerMap)
}
