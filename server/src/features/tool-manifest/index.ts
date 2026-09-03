/**
 * The vendor tool manifest — the ONE declaration source every permission grid
 * and every runtime freeze reads.
 *
 * Two surfaces consume it: the automation form and the chat-robot form. They
 * share vendor tools and the common c3 catalog, while usage-specific entries are
 * selected by the request scope. A manifest that lived inside
 * `features/automations` would have made the robot's copy either an import across
 * a domain that does not own it, or a second list free to drift — and a drifting
 * classification is exactly how a write tool ends up rendered as read-only.
 *
 * The list is STATIC: a vendor adapter's `listTools()` plus c3's own MCP
 * catalogue, never a live probe of an MCP server. Unknown vendors advertise
 * nothing rather than borrowing another vendor's tools, because the failure mode
 * of a lookup miss has to be "offers nothing", never "offers everything".
 */
import type { ToolManifestEntry, ToolManifestScope, VendorId } from '@ccc/shared/protocol'
import { VENDOR_IDS, isC3McpTool } from '@ccc/shared/protocol'
import type { Handler } from '../../transport/handler-registry.js'
import { createClaudeAdapter } from '../../kernel/agent/adapters/claude/index.js'
import { createCodexAdapter } from '../../kernel/agent/adapters/codex/index.js'
import { createCursorAdapter } from '../../kernel/agent/adapters/cursor/index.js'
import { resolveWorkspaceRoot } from '../../state.js'
import { getWorkspaceMcpConfig as storeGetWorkspaceMcpConfig } from '../automations/store.js'

/**
 * c3's common MCP tools, offered in both usage scopes regardless of workspace
 * MCP configuration: they are served over c3's loopback HTTP MCP route, not by
 * a user-configured server, so no adapter's `listTools()` knows about them.
 *
 * Being listed here only makes a tool SELECTABLE. Nothing is attached to a run
 * that did not tick it — an automation's freeze intersects against it, and a
 * robot turn registers only the ticked subset on its MCP binding.
 */
export const C3_MCP_TOOLS: readonly ToolManifestEntry[] = [
  { name: 'mcp__c3__find_intents', isWrite: false },
  { name: 'mcp__c3__view_intent', isWrite: false },
  { name: 'mcp__c3__save_intents', isWrite: true },
  { name: 'mcp__c3__save_intent_directly', isWrite: true },
  { name: 'mcp__c3__submit_spec_review', isWrite: true },
  // PR-status sync triggers server-side forge derivation and persists terminal
  // PR states — a write, not a read (the model supplies no status value; only the
  // forge verdict lands in the ledger).
  { name: 'mcp__c3__sync_intent_pr_status', isWrite: true },
  { name: 'mcp__c3__publish_event', isWrite: true },
  // Delivery tools: READ-ONLY on purpose. A delivery status write funnels through
  // the state machine and its guards, so there is no delivery write tool to select
  // here — a run observes deliveries, a human (or a forge fact) moves them.
  { name: 'mcp__c3__find_deliveries', isWrite: false },
  { name: 'mcp__c3__view_delivery', isWrite: false },
  // Discussion tools: find/view are read-only; start/continue drive an
  // orchestration run and are writes.
  { name: 'mcp__c3__find_discussions', isWrite: false },
  { name: 'mcp__c3__view_discussion', isWrite: false },
  { name: 'mcp__c3__start_discussion', isWrite: true },
  { name: 'mcp__c3__continue_discussion', isWrite: true },
  // Session launcher tool: starts spec or work sessions — a write operation.
  { name: 'mcp__c3__start_session_for_intent', isWrite: true },
]

/** c3 MCP capabilities that only make sense for an IM caller. */
export const ROBOT_ONLY_C3_MCP_TOOLS: readonly ToolManifestEntry[] = [
  { name: 'mcp__c3__list_workspaces', isWrite: false },
]

/** The complete selectable c3 MCP surface for a robot permission grid. */
export const ROBOT_C3_MCP_TOOLS: readonly ToolManifestEntry[] = [
  ...C3_MCP_TOOLS,
  ...ROBOT_ONLY_C3_MCP_TOOLS,
]

/** Whether an allowlist explicitly selected any in-process c3 MCP capability. */
export function hasSelectedC3McpTool(toolAllowlist: readonly string[]): boolean {
  return C3_MCP_TOOLS.some((tool) => toolAllowlist.includes(tool.name))
}

/** The robot c3 MCP tools an allowlist selected, as bare names (`find_intents`, …). */
export function selectedRobotC3McpToolNames(toolAllowlist: readonly string[]): string[] {
  return ROBOT_C3_MCP_TOOLS.filter((tool) => toolAllowlist.includes(tool.name)).map((tool) =>
    tool.name.replace('mcp__c3__', ''),
  )
}

/** MCP server definitions as the adapters' `listTools` accepts them. */
type McpServerDefs = Record<
  string,
  { command: string; args?: string[]; env?: Record<string, string> }
>

/**
 * A vendor's built-in tools, as the adapter declares them. `mcpServers` adds that
 * workspace's `mcp__<server>__` namespace prefixes. An unknown vendor gets an
 * empty list — never another vendor's set.
 */
export function vendorSdkTools(
  vendor: string,
  workspaceName?: string,
  mcpServers?: McpServerDefs,
): ToolManifestEntry[] {
  switch (vendor) {
    case 'claude':
      return createClaudeAdapter().listTools(workspaceName ?? '', mcpServers)
    case 'codex':
      return createCodexAdapter().listTools(workspaceName ?? '', mcpServers)
    case 'cursor':
      return createCursorAdapter().listTools(workspaceName ?? '', mcpServers)
    default:
      return []
  }
}

/**
 * A vendor's LOCAL write/execution tools — the subset whose selection actually
 * needs a writable sandbox on the host.
 *
 * This is deliberately narrower than "every entry classified as a write". A c3
 * MCP write tool (`save_intents`, `start_discussion`, …) executes inside the c3
 * server behind its own domain guards; it writes nothing through the agent's
 * process, so it must never be what upgrades a codex turn from the native
 * `read-only` sandbox to `workspace-write`. Same for a workspace MCP namespace
 * prefix, whose tools also run out-of-process.
 */
export function vendorLocalWriteTools(vendor: string): Set<string> {
  return new Set(
    vendorSdkTools(vendor)
      .filter((t) => t.isWrite && !t.name.startsWith('mcp__'))
      .map((t) => t.name),
  )
}

/**
 * Whether an allowlist selects at least one of the vendor's local write/exec
 * tools — the ONLY thing that may open a writable native sandbox. Pseudo-entries
 * (`network-access`) and c3 MCP tools are excluded by construction.
 */
export function selectsLocalWriteTool(vendor: string, toolAllowlist: readonly string[]): boolean {
  const local = vendorLocalWriteTools(vendor)
  return toolAllowlist.some((name) => local.has(name))
}

/**
 * Build one vendor's manifest. With a `workspaceName`, that workspace's
 * configured MCP servers contribute their namespace prefixes. The explicit
 * usage scope then selects either the common c3 catalog or the robot catalog;
 * omitted scope uses the narrower automation surface for compatibility.
 */
export function buildToolManifest(
  vendor: string,
  workspaceName?: string,
  scope: ToolManifestScope = 'automation',
): ToolManifestEntry[] {
  let mcpServers: McpServerDefs | undefined
  if (workspaceName) {
    const root = resolveWorkspaceRoot(workspaceName)
    if (root) {
      const config = storeGetWorkspaceMcpConfig(root)
      if (Object.keys(config.mcpServers).length > 0) mcpServers = config.mcpServers
    }
  }
  // An unknown vendor advertises nothing at all — not even c3's tools, which it
  // would have no loopback MCP transport to reach.
  if (!isKnownVendor(vendor)) return []
  const c3Tools = scope === 'robot' ? ROBOT_C3_MCP_TOOLS : C3_MCP_TOOLS
  return [...vendorSdkTools(vendor, workspaceName, mcpServers), ...c3Tools]
}

function isKnownVendor(vendor: string): vendor is VendorId {
  return (VENDOR_IDS as readonly string[]).includes(vendor)
}

/** Reply with a vendor's tool manifest for a permission grid. */
export const getToolManifest: Handler<'get_tool_manifest'> = (_ctx, conn, msg) => {
  conn.send({
    type: 'tool_manifest',
    vendor: msg.vendor,
    tools: buildToolManifest(msg.vendor, msg.workspaceName, msg.scope),
    // Echo the asking grid so the web layer routes the reply to the right cache.
    scope: msg.scope,
  })
}

// Re-exported for callers that only need the prefix predicate alongside the
// catalogue, so they do not import from two modules to classify one name.
export { isC3McpTool }
