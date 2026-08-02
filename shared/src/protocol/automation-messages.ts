/**
 * Automation, MCP manifest and wait-user-involve wire messages.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`, which is their only definition site. These arm
 * types are internal to the partition and are NOT part of the public
 * `@ccc/shared/protocol` surface.
 */

import type {
  Automation,
  AutomationExecutionLog,
  CreateAutomationInput,
  ToolManifestEntry,
  UpdateAutomationInput,
  WaitUserInvolveEvent,
  WaitUserInvolveStatus,
} from './automation.js'
import type { TranscriptItem } from './session.js'
import type { VendorId } from './vendor.js'

/** Create a automation in a workspace; server broadcasts `automations`. */
export type ClientCreateAutomation = {
  type: 'create_automation'
  workspaceId: string
  input: CreateAutomationInput
}

/** List automations in a workspace; server replies with `automations`. */
export type ClientListAutomations = { type: 'list_automations'; workspaceId: string }

/** Partial update of a automation; server broadcasts `automations`. */
export type ClientUpdateAutomation = {
  type: 'update_automation'
  automationId: string
  input: UpdateAutomationInput
}

/** Delete a automation; server broadcasts `automations`. */
export type ClientDeleteAutomation = { type: 'delete_automation'; automationId: string }

/** Get full automation detail with execution logs; server replies with `automation_detail`. */
export type ClientGetAutomationDetail = { type: 'get_automation_detail'; automationId: string }

/**
 * Read one `llm`-type execution's agent session transcript (read-only replay);
 * server replies with `execution_transcript`.
 */
export type ClientGetExecutionTranscript = {
  type: 'get_execution_transcript'
  automationId: string
  executionId: string
}

/** Manual trigger: execute a automation immediately (outside normal tick). */
export type ClientAutomationRunNow = { type: 'automation_run_now'; automationId: string }

/**
 * Request a vendor's tool manifest for automation form tool selection.
 * Server replies with `automation_tool_manifest`.
 */
export type ClientGetAutomationToolManifest = {
  type: 'get_automation_tool_manifest'
  vendor: VendorId
  workspaceId: string
}

/**
 * Request the project's wait-user-involve events — the server replies with
 * {@link wait_user_events}. An optional `status` filter narrows to one
 * lifecycle state (default: all).
 */
export type ClientListWaitUserEvents = {
  type: 'list_wait_user_events'
  workspaceId: string
  status?: WaitUserInvolveStatus
  cursorTime?: number
  cursorExcludeId?: string
  limit?: number
}

/** Update a wait-user-involve event lifecycle status. */
export type ClientUpdateWaitUserEvent = {
  type: 'update_wait_user_event'
  id: string
  status: WaitUserInvolveStatus
}

/** A workspace's automation list (reply to `list_automations` or broadcast after create/update/delete). */
export type ServerAutomations = { type: 'automations'; workspaceId: string; items: Automation[] }

/** Full automation detail with execution logs (reply to `get_automation_detail`). */
export type ServerAutomationDetail = {
  type: 'automation_detail'
  automation: Automation
  logs: AutomationExecutionLog[]
}

/**
 * One execution's agent session transcript (reply to `get_execution_transcript`).
 * `items` is empty for `command`-type or sessionless executions; `sessionId` is
 * null in that case.
 */
export type ServerExecutionTranscript = {
  type: 'execution_transcript'
  executionId: string
  sessionId: string | null
  items: TranscriptItem[]
}

/** Execution logs for a automation. */
export type ServerAutomationExecutionLogs = {
  type: 'automation_execution_logs'
  automationId: string
  items: AutomationExecutionLog[]
}

/** A vendor's tool manifest (reply to `get_automation_tool_manifest`). */
export type ServerAutomationToolManifest = {
  type: 'automation_tool_manifest'
  vendor: VendorId
  tools: ToolManifestEntry[]
}

/**
 * A project's wait-user-involve event list (reply to `list_wait_user_events`).
 * Paged replies carry `hasMore`; live todo broadcasts omit it and refresh the
 * pending set without representing a historical page.
 */
export type ServerWaitUserEvents = {
  type: 'wait_user_events'
  items: WaitUserInvolveEvent[]
  hasMore?: boolean
}
