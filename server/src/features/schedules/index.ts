/**
 * `schedules` feature handlers — slice 1/3 (ADR-0009).
 *
 * Schedule CRUD, detail/transcript reads, manual run, workspace MCP config, and
 * the write-approval queue. Broadcasts route through `ctx`; per-connection
 * replies through `conn`.
 */
import { resolve } from 'node:path'
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
import { triggerRunNow } from './scheduler.js'
import { readExecutionTranscript } from './transcript.js'
import { clampName, generateScheduleName } from './naming.js'
import type { ScheduleNameOverride } from './store.js'
import type { Handler } from '../../transport/handler-registry.js'
import type { ToolManifestEntry } from '@ccc/shared/protocol'
import { C3_MCP_TOOLS } from './mcp-freeze.js'
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
  // Name is auto-generated server-side from the task content; any
  // client-supplied name in config is ignored (stripped by the store).
  const generatedName = await generateScheduleName(msg.input)
  const created = createSchedule(msg.input, generatedName)
  ctx.broadcastSchedules(created.workspacePath)
}

export const listSchedulesHandler: Handler<'list_schedules'> = (_ctx, conn, msg) => {
  if (!isScheduleStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'schedule.dbUnavailable' } })
    return
  }
  const proj = resolve(msg.workspacePath)
  const items = listSchedules(proj)
  conn.send({ type: 'schedules', workspacePath: proj, items })
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
  // Reject an update that would leave an event-triggered schedule without a topic
  // (either switching to 'event' without a topic, or clearing an existing one).
  const nextTrigger = msg.input.triggerType ?? existing.triggerType
  const nextTopic = msg.input.eventTopic !== undefined ? msg.input.eventTopic : existing.eventTopic
  if (nextTrigger === 'event' && !nextTopic) {
    conn.send({ type: 'error', error: { code: 'schedule.invalidEventTrigger' } })
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
  ctx.broadcastSchedules(existing.workspacePath)
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
  deleteScheduleStore(msg.scheduleId)
  ctx.broadcastSchedules(existing.workspacePath)
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
    if (s) ctx.broadcastSchedules(s.workspacePath)
  })
}

export const getWorkspaceMcpConfig: Handler<'get_workspace_mcp_config'> = (_ctx, conn, msg) => {
  if (!isScheduleStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'schedule.dbUnavailable' } })
    return
  }
  const config = storeGetWorkspaceMcpConfig(msg.workspacePath)
  conn.send({ type: 'workspace_mcp_config', workspacePath: msg.workspacePath, config })
}

export const saveWorkspaceMcpConfig: Handler<'save_workspace_mcp_config'> = (_ctx, conn, msg) => {
  if (!isScheduleStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'schedule.dbUnavailable' } })
    return
  }
  storeSaveWorkspaceMcpConfig(msg.workspacePath, msg.config)
  conn.send({
    type: 'workspace_mcp_config',
    workspacePath: msg.workspacePath,
    config: storeGetWorkspaceMcpConfig(msg.workspacePath),
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
  const mcpConfig = storeGetWorkspaceMcpConfig(msg.workspacePath)
  const hasMcp = Object.keys(mcpConfig.mcpServers).length > 0
  const mcpServers = hasMcp ? mcpConfig.mcpServers : undefined

  let tools: ToolManifestEntry[]
  switch (msg.vendor) {
    case 'claude':
      tools = createClaudeAdapter().listTools(msg.workspacePath, mcpServers)
      break
    case 'codex':
      tools = createCodexAdapter().listTools(msg.workspacePath, mcpServers)
      break
    default:
      // Unknown vendor — fallback to a minimal SDK set
      tools = createClaudeAdapter().listTools(msg.workspacePath)
  }

  // Always append in-process c3 MCP tools so the user can select them
  // regardless of vendor or workspace MCP config. These live outside the
  // workspace MCP config (defined in features/intents/save-tool.ts), so
  // the vendor adapter's listTools() never includes them.
  tools.push(...C3_MCP_TOOLS)

  conn.send({ type: 'schedule_tool_manifest', vendor: msg.vendor, tools })
}
