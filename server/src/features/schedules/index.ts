/**
 * `schedules` feature handlers — slice 1/3 (ADR-0009).
 *
 * Schedule CRUD, detail/transcript reads, manual run, workspace MCP config, and
 * the write-approval queue. Broadcasts route through `ctx`; per-connection
 * replies through `conn`.
 */
import { resolveWorkspaceRoot, pathToId } from '../../state.js'
import {
  createSchedule,
  deleteSchedule as deleteScheduleStore,
  getSchedule,
  getScheduleDetail,
  getWorkspaceMcpConfig as storeGetWorkspaceMcpConfig,
  isStoreAvailable as isScheduleStoreAvailable,
  listSchedules,
  saveWorkspaceMcpConfig as storeSaveWorkspaceMcpConfig,
  updateSchedule as updateScheduleStore,
} from './store.js'
import { triggerRunNow, cancelInFlight } from './scheduler.js'
import { readExecutionTranscript } from './transcript.js'
import { clampName, generateScheduleName } from './naming.js'
import type { ScheduleNameOverride } from './store.js'
import type { Handler } from '../../transport/handler-registry.js'
import { requireAdmin } from '../auth/authz.js'
import { isValidScheduleMaxWallClockMs, type ToolManifestEntry } from '@ccc/shared/protocol'
import { C3_MCP_TOOLS } from './mcp-freeze.js'
import { loadSettings } from '../../kernel/config/index.js'
import type { UiErrorCode } from '@ccc/shared/ui-codes'
// Static tool listing (no I/O needed) — the only adapter path that can create
// lightweight instances without a supervisor or registry probe.
import { createClaudeAdapter } from '../../kernel/agent/adapters/claude/index.js'
import { createCodexAdapter } from '../../kernel/agent/adapters/codex/index.js'

/**
 * Read a client-supplied `config.name`. Returns:
 * - `undefined` when the key is absent (the update preserves the existing name);
 * - the string (possibly empty) when present — `''` signals "clear → re-derive".
 */
function readConfigName(config: unknown): string | undefined {
  if (config && typeof config === 'object' && 'name' in config) {
    const v = (config as Record<string, unknown>).name
    return typeof v === 'string' ? v : undefined
  }
  return undefined
}

/** An LLM schedule must bind a real enabled agent of its persisted vendor. */
function scheduleAgentError(
  type: 'command' | 'llm',
  vendor: string,
  agentId: string | null | undefined,
): UiErrorCode | null {
  if (type !== 'llm') return null
  if (!agentId) return 'schedule.agentRequired'
  const agent = loadSettings().agents.find((candidate) => candidate.id === agentId)
  if (!agent) return 'schedule.agentNotFound'
  if (agent.enabled === false) return 'schedule.agentDisabled'
  if (agent.vendor !== vendor) return 'schedule.agentVendorMismatch'
  return null
}

export const createScheduleHandler: Handler<'create_schedule'> = async (ctx, conn, msg) => {
  if (!isScheduleStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'schedule.dbUnavailable' } })
    return
  }
  // An event-triggered schedule with no topic is a dead task (it can never match
  // a lifecycle event), so reject it up front rather than persisting a no-op.
  if ((msg.input.triggerType ?? 'cron') === 'event' && !msg.input.eventTopic) {
    conn.send({ type: 'error', error: { code: 'schedule.invalidEventTrigger' } })
    return
  }
  if (
    msg.input.maxWallClockMs !== undefined &&
    !isValidScheduleMaxWallClockMs(msg.input.maxWallClockMs)
  ) {
    conn.send({ type: 'error', error: { code: 'schedule.invalidMaxWallClockMs' } })
    return
  }
  const agentError = scheduleAgentError(msg.input.type, msg.input.vendor, msg.input.agentId)
  if (agentError) {
    conn.send({ type: 'error', error: { code: agentError } })
    return
  }
  // Name is auto-generated server-side from the task content; any
  // client-supplied name in config is ignored (stripped by the store).
  const generatedName = await generateScheduleName(msg.input)
  const created = createSchedule(msg.input, generatedName)
  ctx.broadcastSchedules(resolveWorkspaceRoot(created.workspaceId)!)
}

export const listSchedulesHandler: Handler<'list_schedules'> = (_ctx, conn, msg) => {
  if (!isScheduleStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'schedule.dbUnavailable' } })
    return
  }
  const proj = resolveWorkspaceRoot(msg.workspaceId)!
  const items = listSchedules(proj)
  conn.send({ type: 'schedules', workspaceId: pathToId(proj)!, items })
}

export const updateScheduleHandler: Handler<'update_schedule'> = async (ctx, conn, msg) => {
  if (!isScheduleStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'schedule.dbUnavailable' } })
    return
  }
  const existing = getSchedule(msg.scheduleId)
  if (!existing) {
    conn.send({ type: 'error', error: { code: 'schedule.notFound' } })
    return
  }
  const nextVendor = msg.input.vendor ?? existing.vendor
  const nextAgentId = msg.input.agentId !== undefined ? msg.input.agentId : existing.agentId
  const agentError = scheduleAgentError(existing.type, nextVendor, nextAgentId)
  if (agentError) {
    conn.send({ type: 'error', error: { code: agentError } })
    return
  }
  // Reject an update that would leave an event-triggered schedule without a topic
  // (either switching to 'event' without a topic, or clearing an existing one).
  const nextTrigger = msg.input.triggerType ?? existing.triggerType
  const nextTopic = msg.input.eventTopic !== undefined ? msg.input.eventTopic : existing.eventTopic
  if (nextTrigger === 'event' && !nextTopic) {
    conn.send({ type: 'error', error: { code: 'schedule.invalidEventTrigger' } })
    return
  }
  if (
    msg.input.maxWallClockMs !== undefined &&
    !isValidScheduleMaxWallClockMs(msg.input.maxWallClockMs)
  ) {
    conn.send({ type: 'error', error: { code: 'schedule.invalidMaxWallClockMs' } })
    return
  }
  // Unlike create, update accepts a client-supplied `config.name`: a non-empty
  // title becomes a sticky user-set name (auto-naming never overrides it); an
  // empty title (cleared) reverts to a freshly-derived auto name. When the key
  // is absent (body-only edit, status toggle…) the store preserves the existing
  // name + provenance.
  let nameOverride: ScheduleNameOverride | undefined
  if (msg.input.config !== undefined) {
    const clientName = readConfigName(msg.input.config)
    if (clientName !== undefined) {
      const trimmed = clientName.trim()
      if (trimmed) {
        nameOverride = { name: clampName(trimmed), source: 'user' }
      } else {
        const regenerated = await generateScheduleName({
          type: existing.type,
          config: msg.input.config,
        })
        nameOverride = { name: regenerated, source: 'auto' }
      }
    }
  }
  updateScheduleStore(msg.scheduleId, msg.input, nameOverride)
  ctx.broadcastSchedules(resolveWorkspaceRoot(existing.workspaceId)!)
}

export const deleteScheduleHandler: Handler<'delete_schedule'> = (ctx, conn, msg) => {
  if (!isScheduleStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'schedule.dbUnavailable' } })
    return
  }
  const existing = getSchedule(msg.scheduleId)
  if (!existing) {
    conn.send({ type: 'error', error: { code: 'schedule.notFound' } })
    return
  }
  // Stop any in-flight execution before the row vanishes (SCH-R7 / SCH-R14):
  // a hard delete drops the schedule and its logs, so the running execution
  // must be un-tracked first. Event-triggered schedules carry no per-schedule
  // subscription to detach — the dispatcher re-queries the store on every
  // lifecycle event, so removing the row is itself the unbind.
  cancelInFlight(msg.scheduleId)
  deleteScheduleStore(msg.scheduleId)
  ctx.broadcastSchedules(resolveWorkspaceRoot(existing.workspaceId)!)
}

export const getScheduleDetailHandler: Handler<'get_schedule_detail'> = (_ctx, conn, msg) => {
  if (!isScheduleStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'schedule.dbUnavailable' } })
    return
  }
  const detail = getScheduleDetail(msg.scheduleId)
  if (!detail.schedule) {
    conn.send({ type: 'error', error: { code: 'schedule.notFound' } })
    return
  }
  conn.send({
    type: 'schedule_detail',
    schedule: detail.schedule,
    logs: detail.logs,
  })
}

export const getExecutionTranscript: Handler<'get_execution_transcript'> = async (
  _ctx,
  conn,
  msg,
) => {
  if (!isScheduleStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'schedule.dbUnavailable' } })
    return
  }
  const transcript = await readExecutionTranscript(msg.executionId)
  if (!transcript) {
    conn.send({ type: 'error', error: { code: 'schedule.executionNotFound' } })
    return
  }
  conn.send({
    type: 'execution_transcript',
    executionId: msg.executionId,
    sessionId: transcript.sessionId,
    items: transcript.items,
  })
}

export const scheduleRunNow: Handler<'schedule_run_now'> = (ctx, conn, msg) => {
  if (!isScheduleStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'schedule.dbUnavailable' } })
    return
  }
  void triggerRunNow(msg.scheduleId).then(() => {
    const s = getSchedule(msg.scheduleId)
    if (s) ctx.broadcastSchedules(resolveWorkspaceRoot(s.workspaceId)!)
  })
}

export const getWorkspaceMcpConfig: Handler<'get_workspace_mcp_config'> = (_ctx, conn, msg) => {
  if (!isScheduleStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'schedule.dbUnavailable' } })
    return
  }
  const proj = resolveWorkspaceRoot(msg.workspaceId)!
  const config = storeGetWorkspaceMcpConfig(proj)
  conn.send({ type: 'workspace_mcp_config', workspaceId: msg.workspaceId, config })
}

export const saveWorkspaceMcpConfig: Handler<'save_workspace_mcp_config'> = (_ctx, conn, msg) => {
  // Workspace MCP config is admin-only too (ADR-0023 authz; full coverage).
  if (!requireAdmin(conn)) return
  if (!isScheduleStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'schedule.dbUnavailable' } })
    return
  }
  const proj2 = resolveWorkspaceRoot(msg.workspaceId)!
  storeSaveWorkspaceMcpConfig(proj2, msg.config)
  conn.send({
    type: 'workspace_mcp_config',
    workspaceId: msg.workspaceId,
    config: storeGetWorkspaceMcpConfig(proj2),
  })
}

/**
 * Return a vendor's tool manifest: SDK built-in tools + (for Claude) workspace
 * MCP namespace prefixes. Used by the schedule form to let the user select which
 * tools a schedule's execution may use.
 *
 * The tools are a **static** pre-judged list — not a runtime MCP server probe —
 * following the same classification convention as `freezeTools()` in the
 * dispatcher. This is intentionally lightweight: the handlers create temporary
 * adapter instances for listing because the method requires no I/O.
 */
export const getScheduleToolManifest: Handler<'get_schedule_tool_manifest'> = (_ctx, conn, msg) => {
  if (!isScheduleStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'schedule.dbUnavailable' } })
    return
  }
  const proj3 = resolveWorkspaceRoot(msg.workspaceId)!
  const mcpConfig = storeGetWorkspaceMcpConfig(proj3)
  const hasMcp = Object.keys(mcpConfig.mcpServers).length > 0
  const mcpServers = hasMcp ? mcpConfig.mcpServers : undefined

  let tools: ToolManifestEntry[]
  switch (msg.vendor) {
    case 'claude':
      tools = createClaudeAdapter().listTools(msg.workspaceId, mcpServers)
      break
    case 'codex':
      tools = createCodexAdapter().listTools(msg.workspaceId, mcpServers)
      break
    default:
      // Unknown vendor — fallback to a minimal SDK set
      tools = createClaudeAdapter().listTools(msg.workspaceId)
  }

  // Always append in-process c3 MCP tools so the user can select them
  // regardless of vendor or workspace MCP config. These live outside the
  // workspace MCP config (defined in features/intents/save-tool.ts), so
  // the vendor adapter's listTools() never includes them.
  tools.push(...C3_MCP_TOOLS)

  conn.send({ type: 'schedule_tool_manifest', vendor: msg.vendor, tools })
}
