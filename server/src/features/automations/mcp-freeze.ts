/**
 * Static tool list freeze — resolved before every automation execution.
 *
 * Rule chain (highest priority first):
 *   1. Workspace-level denylist             (subtraction, global)
 *   2. Automation-level toolDenylist           (subtraction, automation-scoped)
 *   3. Automation-level toolAllowlist          (intersection, empty = no restriction)
 *
 * The result is a frozen snapshot of effective tools + read/write classification
 * that the execution's `canUseTool` callback uses to allow/deny/queue.
 * NOTE: the read-only/write policy is now applied in the dispatcher's
 * `createPermissionHandler` based on vendor + mode, not here.
 */

import type { WorkspaceMcpConfig } from '@ccc/shared/protocol'
import { AUTOMATION_NETWORK_ACCESS_TOOL } from '@ccc/shared/protocol'

// ---------------------------------------------------------------------------
// Read/write classification
// ---------------------------------------------------------------------------

/**
 * Built-in SDK tools that are considered read-only.
 */
const SDK_READ_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TaskCreate',
  'TaskList',
  'TaskUpdate',
  'TaskGet',
])

/**
 * Built-in SDK tools that are considered write operations.
 */
const SDK_WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Agent', 'Bash'])

/**
 * MCP server tool name prefixes and patterns that indicate a read-only tool.
 * The naming convention for in-process MCP servers (e.g. mcp__c3__find_intents):
 * - Prefix `mcp__<server>__` is the SDK MCP tool naming scheme
 * - After the double-underscore prefix, the tool's actual name is checked
 */
const READ_MCP_PREFIXES = [
  'get_',
  'find_',
  'search_',
  'list_',
  'read_',
  'view_',
  'show_',
  'fetch_',
  'resolve_',
]

/**
 * In-process c3 MCP tools shown in the automation allowlist UI. They are injected
 * into a Claude execution only when that automation explicitly selects one.
 *
 * These are defined in `features/intents/save-tool.ts` under the `c3` MCP
 * server name. They live outside the workspace MCP config (they're in-process,
 * not user-configured), so they're explicitly registered both here in
 * `freezeTools()` and in the automation form's tool manifest handler.
 *
 * Fully-qualified SDK names: `mcp__c3__find_intents`, `mcp__c3__view_intent`,
 * `mcp__c3__save_intents`.
 */
export const C3_MCP_TOOLS: readonly FrozenToolEntry[] = [
  { name: 'mcp__c3__find_intents', isWrite: false },
  { name: 'mcp__c3__view_intent', isWrite: false },
  { name: 'mcp__c3__save_intents', isWrite: true },
  { name: 'mcp__c3__save_intent_pr_info', isWrite: true },
  { name: 'mcp__c3__save_intent_directly', isWrite: true },
  { name: 'mcp__c3__publish_event', isWrite: true },
  // Discussion tools (automation LLM execution): find/view are read-only;
  // start/continue drive an orchestration run and are writes.
  { name: 'mcp__c3__find_discussions', isWrite: false },
  { name: 'mcp__c3__view_discussion', isWrite: false },
  { name: 'mcp__c3__start_discussion', isWrite: true },
  { name: 'mcp__c3__continue_discussion', isWrite: true },
]

/** Whether a automation explicitly selected any in-process c3 MCP capability. */
export function hasSelectedC3McpTool(toolAllowlist: readonly string[]): boolean {
  return C3_MCP_TOOLS.some((tool) => toolAllowlist.includes(tool.name))
}

/**
 * Whether a automation selected the `network-access` pseudo-entry. Orthogonal to
 * the real tool set: the dispatcher reads this to decide the codex sandbox's raw
 * network flag, while {@link freezeTools} strips the same marker so it never
 * participates in read/write classification or the permission grid.
 */
export function hasSelectedNetworkAccess(toolAllowlist: readonly string[]): boolean {
  return toolAllowlist.includes(AUTOMATION_NETWORK_ACCESS_TOOL)
}

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface FrozenToolEntry {
  /** Tool name as the SDK knows it (e.g. 'Read', 'mcp__c3__find_intents'). */
  name: string
  /** Whether this tool is classified as a write operation. */
  isWrite: boolean
}

export interface FrozenToolSet {
  tools: FrozenToolEntry[]
  writeToolNames: Set<string>
  readToolNames: Set<string>
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

/**
 * Classify a single tool name as read or write.
 * Conservative: tools that can't be classified are treated as write.
 */
function classifyTool(toolName: string): 'read' | 'write' {
  if (SDK_READ_TOOLS.has(toolName)) return 'read'
  if (SDK_WRITE_TOOLS.has(toolName)) return 'write'

  // MCP tool naming: mcp__<server>__<tool_name>
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    // parts[0] = 'mcp', parts[1] = server name, rest = tool name
    // SDK format: mcp__server__tool_name
    const actualName = parts.slice(2).join('__')
    for (const prefix of READ_MCP_PREFIXES) {
      if (actualName.startsWith(prefix)) return 'read'
    }
    return 'write' // conservative: default to write
  }

  return 'write' // conservative: unknown tools default to write
}

// ---------------------------------------------------------------------------
// Tool set composition
// ---------------------------------------------------------------------------

/**
 * Compute the final effective tool list for a automation execution.
 *
 * @param automationAllowlist - Automation-level toolAllowlist (empty = no restriction beyond denylist)
 * @param automationDenylist  - Automation-level toolDenylist
 * @param workspaceConfig   - Workspace-level MCP config (mcpServers + denylist)
 * @returns Frozen tool set
 */
export function freezeTools(
  automationAllowlist: string[],
  automationDenylist: string[],
  workspaceConfig: WorkspaceMcpConfig,
): FrozenToolSet {
  // Collect all known tool names:
  // - SDK built-ins (the universal set)
  // - MCP server tools (from workspace config)
  const knownTools = new Set<string>()

  // Add SDK built-ins
  for (const t of SDK_READ_TOOLS) knownTools.add(t)
  for (const t of SDK_WRITE_TOOLS) knownTools.add(t)

  // Add in-process c3 MCP tools (always available, not in workspace config)
  for (const t of C3_MCP_TOOLS) knownTools.add(t.name)

  // Add MCP server tools (from workspace config)
  for (const [serverName, _serverConfig] of Object.entries(workspaceConfig.mcpServers)) {
    // We don't know what tools the MCP server provides at freeze time
    // (that would require connecting and introspecting, which is expensive).
    // Instead, we register the MCP server's "namespace" — the permission
    // handler will match against the `mcp__<server>__` prefix pattern.
    // Any tool starting with `mcp__<server>__` is considered in-scope.
    const namespacePrefix = `mcp__${serverName}__`
    knownTools.add(namespacePrefix)
  }

  // Apply denylist (subtraction, highest priority)
  const combinedDenylist = new Set([...(workspaceConfig.denylist ?? []), ...automationDenylist])

  // Strip reserved pseudo-entries (e.g. `network-access`) before the intersection:
  // they are capability flags, not tools, so they must not restrict the real set.
  // Without this, an allowlist of only `network-access` would read as "non-empty"
  // and collapse the frozen set to empty instead of the intended "no restriction".
  const realAllowlist = automationAllowlist.filter(
    (item) => item !== AUTOMATION_NETWORK_ACCESS_TOOL,
  )

  // Apply allowlist (intersection) — empty = no restriction
  const hasAllowlist = realAllowlist.length > 0

  const entries: FrozenToolEntry[] = []
  const writeNames = new Set<string>()
  const readNames = new Set<string>()

  for (const item of knownTools) {
    // Check denylist
    if (combinedDenylist.has(item)) continue

    // Check allowlist (if specified)
    if (hasAllowlist && !realAllowlist.includes(item)) continue

    // Classify
    const isWrite = classifyTool(item) === 'write'

    entries.push({ name: item, isWrite })
    if (isWrite) {
      writeNames.add(item)
    } else {
      readNames.add(item)
    }
  }

  return {
    tools: entries,
    writeToolNames: writeNames,
    readToolNames: readNames,
  }
}

/**
 * Check if a tool name matched a namespace prefix (for MCP server tools).
 * E.g., hasNamespaceMatch('mcp__c3__save_intents', frozenSet) → true
 * if 'mcp__c3__' is in the frozen set.
 */
export function matchesFrozenTool(toolName: string, frozen: FrozenToolSet): boolean {
  if (frozen.readToolNames.has(toolName) || frozen.writeToolNames.has(toolName)) {
    return true
  }

  // Check MCP namespace matching
  for (const namespace of frozen.tools.map((t) => t.name)) {
    if (namespace.endsWith('__')) {
      // This is a namespace prefix
      if (toolName.startsWith(namespace)) return true
    }
  }

  return false
}

/**
 * Determine if a tool is classified as a write operation.
 * Uses the frozen tool set if available, otherwise falls back to inline classification.
 */
export function isWriteTool(toolName: string, frozen?: FrozenToolSet): boolean {
  if (frozen) {
    if (frozen.readToolNames.has(toolName)) return false
    if (frozen.writeToolNames.has(toolName)) return true
    // MCP namespace match
    for (const ns of frozen.tools.map((t) => t.name)) {
      if (ns.endsWith('__') && toolName.startsWith(ns)) {
        // Classify on the fly
        return classifyTool(toolName) === 'write'
      }
    }
  }

  return classifyTool(toolName) === 'write'
}
