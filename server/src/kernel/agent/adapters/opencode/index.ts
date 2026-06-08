/**
 * OpenCode vendor adapter (ADR-0011, 2026-06-06-003) — the first FULL non-Claude
 * integration, assembled from its driver, the shared approval bridge, and its
 * session store, all talking to the c3-supervised OpenCode server via the
 * {@link OpencodeSupervisor}'s live client. The driver and the approval bridge
 * share one bridge instance so the driver can route `permission.*` events into it.
 *
 * The upper layer selects this by `VendorId === 'opencode'` and drives it through
 * the neutral {@link VendorAdapter} faces only.
 */
import type { VendorAdapter } from '../types.js'
import type { ToolManifestEntry } from '../types.js'
import { opencodeCapabilities } from './capabilities.js'
import { OpencodeDriver } from './driver.js'
import { OpencodeApprovalBridge, type OpencodeApprovalOptions } from './approval.js'
import { OpencodeSessionStore } from './session-store.js'
import { createOpencodeSkillLoader } from './skill.js'
import type { OpencodeSupervisor } from './supervisor.js'

export { opencodeCapabilities } from './capabilities.js'
export { createOpencodeSkillLoader } from './skill.js'
export { OpencodeDriver } from './driver.js'
export { OpencodeApprovalBridge } from './approval.js'
export { OpencodeSessionStore } from './session-store.js'
export { OpencodeTaskStore, type OpencodeTaskStoreOptions } from './task-store.js'
export { OpencodeStreamTranslator, messageToCanonical, partToBlock } from './translate.js'
export {
  OpencodeSupervisor,
  createOpencodeSupervisor,
  pickFreePort,
  defaultSpawnServer,
  type OpencodeSupervisorConfig,
  type SupervisorStatus,
  type SpawnedServer,
  type ServerSpawner,
} from './supervisor.js'

// ---------------------------------------------------------------------------
// OpenCode SDK known tool surface — tools are server-configured and dynamic
// (the OpenCode provider+model defines which tools are available at runtime).
// This static list covers the common subset; the full set depends on the
// server's active provider configuration.
//
// OpenCode uses lowercase tool names (the c3 adapter's partToBlock passes
// through the server's `part.tool` value as-is).
// ---------------------------------------------------------------------------

const SDK_READ_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'ls',
  'web_search',
  'web_fetch',
  'notebook_read',
  'TaskCreate',
  'TaskList',
  'TaskUpdate',
  'TaskGet',
])

const SDK_WRITE_TOOLS = new Set(['write', 'edit', 'bash', 'notebook_edit', 'agent'])

/**
 * Static tool manifest for OpenCode. Usable without an adapter instance
 * (no {@link OpencodeSupervisor} required), so callers like the schedules
 * feature handler can list tools without starting a server.
 */
export function listOpencodeTools(
  _workspacePath: string,
  _mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>,
): ToolManifestEntry[] {
  const entries: ToolManifestEntry[] = []
  for (const t of SDK_READ_TOOLS) entries.push({ name: t, isWrite: false })
  for (const t of SDK_WRITE_TOOLS) entries.push({ name: t, isWrite: true })
  return entries
}

/**
 * Build the OpenCode {@link VendorAdapter} over a started {@link OpencodeSupervisor}.
 * Each call yields fresh adapter instances; they pull the live client lazily from
 * the supervisor so a server restart (new client) is transparent to them.
 */
export function createOpencodeAdapter(
  supervisor: OpencodeSupervisor,
  approvalOpts?: OpencodeApprovalOptions,
): VendorAdapter {
  const getClient = () => supervisor.client()
  const approval = new OpencodeApprovalBridge(approvalOpts)
  return {
    vendor: 'opencode',
    capabilities: opencodeCapabilities,
    driver: new OpencodeDriver(getClient, approval),
    approval,
    sessions: new OpencodeSessionStore(getClient),
    skill: createOpencodeSkillLoader(),
    listTools: listOpencodeTools,
  }
}
