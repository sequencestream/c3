/**
 * `automations` feature handlers — slice 1/3 (ADR-0009).
 *
 * Automation CRUD, detail/transcript reads, manual run, workspace MCP config, and
 * the write-approval queue. Broadcasts route through `ctx`; per-connection
 * replies through `conn`.
 */
import { resolveWorkspaceRoot, pathToId } from '../../state.js'
import {
  createAutomation,
  deleteAutomation as deleteAutomationStore,
  getAutomation,
  getAutomationDetail,
  getWorkspaceMcpConfig as storeGetWorkspaceMcpConfig,
  isStoreAvailable as isAutomationStoreAvailable,
  listAutomations,
  saveWorkspaceMcpConfig as storeSaveWorkspaceMcpConfig,
  updateAutomation as updateAutomationStore,
} from './store.js'
import { triggerRunNow, cancelInFlight } from './engine.js'
import { readExecutionTranscript } from './transcript.js'
import { clampName, generateAutomationName } from './naming.js'
import type { AutomationNameOverride } from './store.js'
import type { Handler } from '../../transport/handler-registry.js'
import { requireAdmin } from '../auth/authz.js'
import type { ToolManifestEntry } from '@ccc/shared/protocol'
import { isValidAutomationMaxWallClockMs, normalizeGenericEventFilters } from '@ccc/shared'
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

/** An LLM automation must bind a real enabled agent of its persisted vendor. */
function automationAgentError(
  type: 'command' | 'llm',
  vendor: string,
  agentId: string | null | undefined,
): UiErrorCode | null {
  if (type !== 'llm') return null
  if (!agentId) return 'automation.agentRequired'
  const agent = loadSettings().agents.find((candidate) => candidate.id === agentId)
  if (!agent) return 'automation.agentNotFound'
  if (agent.enabled === false) return 'automation.agentDisabled'
  if (agent.vendor !== vendor) return 'automation.agentVendorMismatch'
  return null
}

export const createAutomationHandler: Handler<'create_automation'> = async (ctx, conn, msg) => {
  if (!isAutomationStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'automation.dbUnavailable' } })
    return
  }
  // An event-triggered automation whose subscription rows all lack a valid event
  // type is a dead task (it can never match), so reject it up front rather than
  // persisting a no-op or silently widening it to "matches every type".
  const createdFilters =
    (msg.input.triggerType ?? 'cron') === 'event'
      ? normalizeGenericEventFilters(msg.input.eventFilters)
      : null
  if ((msg.input.triggerType ?? 'cron') === 'event' && !createdFilters) {
    conn.send({ type: 'error', error: { code: 'automation.invalidEventTrigger' } })
    return
  }
  // The run-lifecycle sessionKind filter is optional: an absent/empty value means
  // "every session kind" and is accepted as-is. A non-empty value stays an exact
  // whitelist (validated to legal SessionKind values at the store boundary).
  if (
    msg.input.maxWallClockMs !== undefined &&
    !isValidAutomationMaxWallClockMs(msg.input.maxWallClockMs)
  ) {
    conn.send({ type: 'error', error: { code: 'automation.invalidMaxWallClockMs' } })
    return
  }
  // Only `'paused'` may be requested as an explicit initial status (the import
  // path uses it to land paused atomically). Reject any other value so a client
  // cannot bypass the create-then-active lifecycle rule.
  if (msg.input.initialStatus !== undefined && msg.input.initialStatus !== 'paused') {
    conn.send({ type: 'error', error: { code: 'automation.invalidInitialStatus' } })
    return
  }
  const agentError = automationAgentError(msg.input.type, msg.input.vendor, msg.input.agentId)
  if (agentError) {
    conn.send({ type: 'error', error: { code: agentError } })
    return
  }
  // Name is normally auto-generated server-side from the task content (any
  // client-supplied name in config is stripped by the store). An import supplies
  // an explicit `initialName` to preserve the exported title — honour it directly
  // and skip the LLM naming call.
  const importedName = typeof msg.input.initialName === 'string' ? msg.input.initialName.trim() : ''
  const generatedName = importedName
    ? clampName(importedName)
    : await generateAutomationName(msg.input)
  const created = createAutomation(msg.input, generatedName)
  ctx.broadcastAutomations(resolveWorkspaceRoot(created.workspaceId)!)
}

export const listAutomationsHandler: Handler<'list_automations'> = (_ctx, conn, msg) => {
  if (!isAutomationStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'automation.dbUnavailable' } })
    return
  }
  const proj = resolveWorkspaceRoot(msg.workspaceId)!
  const items = listAutomations(proj)
  conn.send({ type: 'automations', workspaceId: pathToId(proj)!, items })
}

export const updateAutomationHandler: Handler<'update_automation'> = async (ctx, conn, msg) => {
  if (!isAutomationStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'automation.dbUnavailable' } })
    return
  }
  const existing = getAutomation(msg.automationId)
  if (!existing) {
    conn.send({ type: 'error', error: { code: 'automation.notFound' } })
    return
  }
  const nextVendor = msg.input.vendor ?? existing.vendor
  const nextAgentId = msg.input.agentId !== undefined ? msg.input.agentId : existing.agentId
  const agentError = automationAgentError(existing.type, nextVendor, nextAgentId)
  if (agentError) {
    conn.send({ type: 'error', error: { code: agentError } })
    return
  }
  // Reject an update that would leave an event-triggered automation without a
  // valid subscription (either switching to 'event' without rows, or clearing the
  // existing ones). Use the patch's rows if present, else the stored ones.
  const nextTrigger = msg.input.triggerType ?? existing.triggerType
  const nextFilters = normalizeGenericEventFilters(
    msg.input.eventFilters !== undefined ? msg.input.eventFilters : existing.eventFilters,
  )
  if (nextTrigger === 'event' && !nextFilters) {
    conn.send({ type: 'error', error: { code: 'automation.invalidEventTrigger' } })
    return
  }
  // The run-lifecycle sessionKind filter is optional: clearing it (or never
  // setting one) means "every session kind" and is accepted; a non-empty value
  // stays an exact whitelist.
  if (
    msg.input.maxWallClockMs !== undefined &&
    !isValidAutomationMaxWallClockMs(msg.input.maxWallClockMs)
  ) {
    conn.send({ type: 'error', error: { code: 'automation.invalidMaxWallClockMs' } })
    return
  }
  // Unlike create, update accepts a client-supplied `config.name`: a non-empty
  // title becomes a sticky user-set name (auto-naming never overrides it); an
  // empty title (cleared) reverts to a freshly-derived auto name. When the key
  // is absent (body-only edit, status toggle…) the store preserves the existing
  // name + provenance.
  let nameOverride: AutomationNameOverride | undefined
  if (msg.input.config !== undefined) {
    const clientName = readConfigName(msg.input.config)
    if (clientName !== undefined) {
      const trimmed = clientName.trim()
      if (trimmed) {
        nameOverride = { name: clampName(trimmed), source: 'user' }
      } else {
        const regenerated = await generateAutomationName({
          type: existing.type,
          config: msg.input.config,
        })
        nameOverride = { name: regenerated, source: 'auto' }
      }
    }
  }
  updateAutomationStore(msg.automationId, msg.input, nameOverride)
  ctx.broadcastAutomations(resolveWorkspaceRoot(existing.workspaceId)!)
}

export const deleteAutomationHandler: Handler<'delete_automation'> = (ctx, conn, msg) => {
  if (!isAutomationStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'automation.dbUnavailable' } })
    return
  }
  const existing = getAutomation(msg.automationId)
  if (!existing) {
    conn.send({ type: 'error', error: { code: 'automation.notFound' } })
    return
  }
  // Stop any in-flight execution before the row vanishes (SCH-R7 / SCH-R14):
  // a hard delete drops the automation and its logs, so the running execution
  // must be un-tracked first. Event-triggered automations carry no per-automation
  // subscription to detach — the dispatcher re-queries the store on every
  // lifecycle event, so removing the row is itself the unbind.
  cancelInFlight(msg.automationId)
  deleteAutomationStore(msg.automationId)
  ctx.broadcastAutomations(resolveWorkspaceRoot(existing.workspaceId)!)
}

export const getAutomationDetailHandler: Handler<'get_automation_detail'> = (_ctx, conn, msg) => {
  if (!isAutomationStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'automation.dbUnavailable' } })
    return
  }
  const detail = getAutomationDetail(msg.automationId)
  if (!detail.automation) {
    conn.send({ type: 'error', error: { code: 'automation.notFound' } })
    return
  }
  conn.send({
    type: 'automation_detail',
    automation: detail.automation,
    logs: detail.logs,
  })
}

export const getExecutionTranscript: Handler<'get_execution_transcript'> = async (
  _ctx,
  conn,
  msg,
) => {
  if (!isAutomationStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'automation.dbUnavailable' } })
    return
  }
  const transcript = await readExecutionTranscript(msg.executionId)
  if (!transcript) {
    conn.send({ type: 'error', error: { code: 'automation.executionNotFound' } })
    return
  }
  conn.send({
    type: 'execution_transcript',
    executionId: msg.executionId,
    sessionId: transcript.sessionId,
    items: transcript.items,
  })
}

export const automationRunNow: Handler<'automation_run_now'> = (ctx, conn, msg) => {
  if (!isAutomationStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'automation.dbUnavailable' } })
    return
  }
  void triggerRunNow(msg.automationId).then(() => {
    const s = getAutomation(msg.automationId)
    if (s) ctx.broadcastAutomations(resolveWorkspaceRoot(s.workspaceId)!)
  })
}

export const getWorkspaceMcpConfig: Handler<'get_workspace_mcp_config'> = (_ctx, conn, msg) => {
  if (!isAutomationStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'automation.dbUnavailable' } })
    return
  }
  const proj = resolveWorkspaceRoot(msg.workspaceId)!
  const config = storeGetWorkspaceMcpConfig(proj)
  conn.send({ type: 'workspace_mcp_config', workspaceId: msg.workspaceId, config })
}

export const saveWorkspaceMcpConfig: Handler<'save_workspace_mcp_config'> = (_ctx, conn, msg) => {
  // Workspace MCP config is admin-only too (ADR-0023 authz; full coverage).
  if (!requireAdmin(conn)) return
  if (!isAutomationStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'automation.dbUnavailable' } })
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
 * MCP namespace prefixes. Used by the automation form to let the user select which
 * tools a automation's execution may use.
 *
 * The tools are a **static** pre-judged list — not a runtime MCP server probe —
 * following the same classification convention as `freezeTools()` in the
 * dispatcher. This is intentionally lightweight: the handlers create temporary
 * adapter instances for listing because the method requires no I/O.
 */
export const getAutomationToolManifest: Handler<'get_automation_tool_manifest'> = (
  _ctx,
  conn,
  msg,
) => {
  if (!isAutomationStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'automation.dbUnavailable' } })
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

  // Always append c3 MCP tools so the user can select them regardless of vendor
  // or workspace MCP config. These live outside the workspace MCP config (c3's own
  // tools, served over the loopback HTTP MCP route), so the vendor adapter's
  // listTools() never includes them.
  tools.push(...C3_MCP_TOOLS)

  conn.send({ type: 'automation_tool_manifest', vendor: msg.vendor, tools })
}
