/**
 * WebSocket wire protocol shared between server and web.
 * Path: /ws
 *
 * This file is the protocol barrel and the single assembly point for the two
 * message unions. Domain contracts live in `./protocol/*.ts` and are re-exported
 * here unchanged, so `@ccc/shared/protocol` stays the one public entry point.
 * Message payloads live in `./protocol/*-messages.ts`; a new message is one arm
 * added below plus its payload type in the owning domain module.
 */

export * from './protocol/agent-config.js'
export * from './protocol/auth.js'
export * from './protocol/automation.js'
export * from './protocol/code.js'
export * from './protocol/consensus.js'
export * from './protocol/delivery.js'
export * from './protocol/discussion.js'
export * from './protocol/intent.js'
export * from './protocol/session.js'
export * from './protocol/settings.js'
export * from './protocol/skill.js'
export * from './protocol/vendor.js'
export * from './protocol/workspace.js'

import type * as AuthMsg from './protocol/auth-messages.js'
import type * as AutomationMsg from './protocol/automation-messages.js'
import type * as CodeMsg from './protocol/code-messages.js'
import type * as DeliveryMsg from './protocol/delivery-messages.js'
import type * as DiscussionMsg from './protocol/discussion-messages.js'
import type * as IntentMsg from './protocol/intent-messages.js'
import type * as SessionMsg from './protocol/session-messages.js'
import type * as SettingsMsg from './protocol/settings-messages.js'
import type * as SkillMsg from './protocol/skill-messages.js'
import type * as WorkspaceMsg from './protocol/workspace-messages.js'

// Client → Server
export type ClientToServer =
  | SessionMsg.ClientUserPrompt
  | SessionMsg.ClientPermissionResponse
  | SessionMsg.ClientSetMode
  | SessionMsg.ClientSetSessionAgent
  | WorkspaceMsg.ClientAddWorkspace
  | WorkspaceMsg.ClientRemoveWorkspace
  | SessionMsg.ClientListSessions
  | SessionMsg.ClientGetSessionCounts
  | SessionMsg.ClientCreateSession
  | SessionMsg.ClientCreateWorkSession
  | SessionMsg.ClientDeleteSession
  | SessionMsg.ClientSelectSession
  | SessionMsg.ClientRenameSession
  | CodeMsg.ClientListDir
  | CodeMsg.ClientReadFile
  | CodeMsg.ClientGetCodeGitStatus
  | CodeMsg.ClientSearchCodes
  | SessionMsg.ClientStopRun
  | SessionMsg.ClientRebindView
  | SessionMsg.ClientListCommands
  | SettingsMsg.ClientGetSettings
  | SettingsMsg.ClientSaveSettings
  | SettingsMsg.ClientGetPersonalizedSettings
  | SettingsMsg.ClientSavePersonalizedSettings
  | SettingsMsg.ClientListMcpApiKeys
  | SettingsMsg.ClientCreateMcpApiKey
  | SettingsMsg.ClientUpdateMcpApiKey
  | SettingsMsg.ClientRevokeMcpApiKey
  | AuthMsg.ClientLogin
  | AuthMsg.ClientLogout
  | AuthMsg.ClientSetAdminPassword
  | AuthMsg.ClientRemoveAccount
  | AuthMsg.ClientSetAdminAccount
  | WorkspaceMsg.ClientLoadWorkspaceSetting
  | WorkspaceMsg.ClientSaveWorkspaceSetting
  | IntentMsg.ClientListIntents
  | IntentMsg.ClientCreateIntent
  | IntentMsg.ClientStartIntentSession
  | IntentMsg.ClientOpenIntentSession
  | IntentMsg.ClientListIntentSessions
  | IntentMsg.ClientListIntentLogs
  | IntentMsg.ClientRenameIntentSession
  | IntentMsg.ClientDeleteIntentSession
  | IntentMsg.ClientDeleteIntent
  | IntentMsg.ClientNewIntentSession
  | IntentMsg.ClientRefineIntent
  | IntentMsg.ClientDiscussionToIntent
  | IntentMsg.ClientStartDevelopment
  | IntentMsg.ClientWriteSpec
  | IntentMsg.ClientApproveSpec
  | IntentMsg.ClientRevokeSpecApproval
  | IntentMsg.ClientOpenSpecSession
  | IntentMsg.ClientOpenSpecReviewSession
  | IntentMsg.ClientResetIntentSession
  | IntentMsg.ClientResetSpecSession
  | IntentMsg.ClientReadSpec
  | IntentMsg.ClientUpdateSpecContent
  | IntentMsg.ClientUpdateIntentContent
  | IntentMsg.ClientUpdateIntentStatus
  | IntentMsg.ClientSetIntentAutomate
  | IntentMsg.ClientUpdateIntentDeps
  | IntentMsg.ClientSetIntentGitInfo
  | IntentMsg.ClientStartWorkflow
  | IntentMsg.ClientStopWorkflow
  | IntentMsg.ClientGetQueueDetail
  | IntentMsg.ClientGetParkRecoveryStats
  | IntentMsg.ClientQueueControl
  | IntentMsg.ClientCreatePr
  | IntentMsg.ClientSyncIntentPrStatus
  | DeliveryMsg.ClientListDeliveries
  | DeliveryMsg.ClientCreateDelivery
  | DeliveryMsg.ClientGetDeliveryDetail
  | DeliveryMsg.ClientUpdateDelivery
  | DeliveryMsg.ClientCancelDelivery
  | DeliveryMsg.ClientTransitionDelivery
  | DeliveryMsg.ClientInitDeliveryBranch
  | DeliveryMsg.ClientCleanupDeliveryBranch
  | DeliveryMsg.ClientLinkIntentToDelivery
  | DeliveryMsg.ClientUnlinkIntentFromDelivery
  | DiscussionMsg.ClientListDiscussions
  | DiscussionMsg.ClientCreateDiscussion
  | DiscussionMsg.ClientOpenDiscussion
  | DiscussionMsg.ClientStartDiscussion
  | DiscussionMsg.ClientPauseDiscussion
  | DiscussionMsg.ClientResumeDiscussion
  | DiscussionMsg.ClientDiscussionSpeak
  | DiscussionMsg.ClientContinueDiscussion
  | SessionMsg.ClientRequestSessionStatus
  | AutomationMsg.ClientCreateAutomation
  | AutomationMsg.ClientListAutomations
  | AutomationMsg.ClientUpdateAutomation
  | AutomationMsg.ClientDeleteAutomation
  | AutomationMsg.ClientGetAutomationDetail
  | AutomationMsg.ClientGetExecutionTranscript
  | AutomationMsg.ClientAutomationRunNow
  | WorkspaceMsg.ClientGetWorkspaceMcpConfig
  | WorkspaceMsg.ClientSaveWorkspaceMcpConfig
  | AutomationMsg.ClientGetAutomationToolManifest
  | SkillMsg.ClientSkillLoadApprovalResolve
  | SkillMsg.ClientGetSkillLinkStatus
  | SkillMsg.ClientInstallSkill
  | AutomationMsg.ClientListWaitUserEvents
  | AutomationMsg.ClientUpdateWaitUserEvent
  | WorkspaceMsg.ClientGetTimerangeStats
  | WorkspaceMsg.ClientGetWorkspaceDashboard
  | WorkspaceMsg.ClientSetWorkspacesAutomationEnabled
  | SessionMsg.ClientPing

// Server → Client
export type ServerToClient =
  | SessionMsg.ServerReady
  | SessionMsg.ServerSessionStatus
  | SettingsMsg.ServerUpdateStatus
  | WorkspaceMsg.ServerWorkspaces
  | SessionMsg.ServerSessions
  | SessionMsg.ServerSessionCounts
  | CodeMsg.ServerDirListed
  | CodeMsg.ServerFileRead
  | CodeMsg.ServerCodeGitStatus
  | CodeMsg.ServerCodesSearched
  | SessionMsg.ServerSessionSelected
  | SessionMsg.ServerSessionStarted
  | SessionMsg.ServerSessionAgentChanged
  | SessionMsg.ServerModeChanged
  | SessionMsg.ServerCommands
  | SettingsMsg.ServerSettings
  | SettingsMsg.ServerPersonalizedSettings
  | SettingsMsg.ServerMcpApiKeys
  | WorkspaceMsg.ServerWorkspaceSetting
  | AuthMsg.ServerLoginResult
  | AuthMsg.ServerAdminPasswordResult
  | AuthMsg.ServerAccountOpResult
  | AuthMsg.ServerUnauthenticated
  | IntentMsg.ServerIntents
  | IntentMsg.ServerCreateIntentResult
  | IntentMsg.ServerDevLaunchProgress
  | IntentMsg.ServerSpecLaunchProgress
  | IntentMsg.ServerIntentSessions
  | IntentMsg.ServerIntentLogsList
  | IntentMsg.ServerWorkflowStatus
  | IntentMsg.ServerQueueDetail
  | IntentMsg.ServerParkRecoveryStats
  | IntentMsg.ServerCreatePrResponse
  | IntentMsg.ServerCreatePrProgress
  | IntentMsg.ServerSyncIntentPrStatusResponse
  | DeliveryMsg.ServerDeliveries
  | DeliveryMsg.ServerCreateDeliveryResult
  | DeliveryMsg.ServerDeliveryDetail
  | DeliveryMsg.ServerDeliveryTransitionFailed
  | DeliveryMsg.ServerDeliveryBranchInitProgress
  | DeliveryMsg.ServerDeliveryBranchInitResult
  | DiscussionMsg.ServerDiscussions
  | DiscussionMsg.ServerDiscussionDetail
  | DiscussionMsg.ServerDiscussionMessage
  | DiscussionMsg.ServerDiscussionRunStatus
  | DiscussionMsg.ServerDiscussionDispatchStatus
  | DiscussionMsg.ServerResearchMessage
  | DiscussionMsg.ServerResearchRunStatus
  | SessionMsg.ServerUserText
  | SessionMsg.ServerAssistantText
  | SessionMsg.ServerNotice
  | SessionMsg.ServerToolUse
  | SessionMsg.ServerToolResult
  | SessionMsg.ServerTaskList
  | SessionMsg.ServerTaskCreated
  | SessionMsg.ServerTaskUpdated
  | SessionMsg.ServerTaskDeleted
  | SessionMsg.ServerPermissionRequest
  | SessionMsg.ServerConsensusAuto
  | SessionMsg.ServerTurnEnd
  | SessionMsg.ServerTeamUpgraded
  | SessionMsg.ServerAgentFailed
  | SessionMsg.ServerAllAgentsFailed
  | SessionMsg.ServerError
  | AutomationMsg.ServerAutomations
  | AutomationMsg.ServerAutomationDetail
  | AutomationMsg.ServerExecutionTranscript
  | AutomationMsg.ServerAutomationExecutionLogs
  | WorkspaceMsg.ServerWorkspaceMcpConfig
  | AutomationMsg.ServerAutomationToolManifest
  | AutomationMsg.ServerWaitUserEvents
  | SkillMsg.ServerSkillLoadApprovalRequest
  | WorkspaceMsg.ServerTimerangeStats
  | WorkspaceMsg.ServerWorkspaceDashboard
  | WorkspaceMsg.ServerWorkspacesAutomationResult
  | SkillMsg.ServerSkillLinkStatus
  | SkillMsg.ServerSkillInstallResult
  | SessionMsg.ServerPong
