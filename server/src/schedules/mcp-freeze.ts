/**
 * Static tool list freeze — resolved before every schedule execution.
 *
 * Rule chain (highest priority first):
 *   1. Workspace-level denylist             (subtraction, global)
 *   2. Schedule-level toolDenylist           (subtraction, schedule-scoped)
 *   3. Schedule-level toolAllowlist          (intersection, empty = no restriction)
 *   4. mcpMode                               (read-only/sandboxed/full-access classification)
 *
 * The result is a frozen snapshot of effective tools + read/write classification
 * that the execution's `canUseTool` callback uses to allow/deny/queue.
 */

import type { McpMode, WorkspaceMcpConfig } from '@ccc/shared/protocol'

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
  'TodoWrite',
])

/**
 * Built-in SDK tools that are considered write operations.
 */
const SDK_WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Agent', 'Bash'])

/**
 * MCP server tool name prefixes and patterns that indicate a read-only tool.
 * The naming convention for in-process MCP servers (e.g. mcp__c3__find_requirements):
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

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface FrozenToolEntry {
  /** Tool name as the SDK knows it (e.g. 'Read', 'mcp__c3__find_requirements'). */
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
 * Compute the final effective tool list for a schedule execution.
 *
 * @param scheduleAllowlist - Schedule-level toolAllowlist (empty = no restriction beyond denylist + mcpMode)
 * @param scheduleDenylist  - Schedule-level toolDenylist
 * @param workspaceConfig   - Workspace-level MCP config (mcpServers + denylist)
 * @param mcpMode           - Execution identity mode
 * @returns Frozen tool set
 */
export function freezeTools(
  scheduleAllowlist: string[],
  scheduleDenylist: string[],
  workspaceConfig: WorkspaceMcpConfig,
  mcpMode: McpMode,
): FrozenToolSet {
  // Collect all known tool names:
  // - SDK built-ins (the universal set)
  // - MCP server tools (from workspace config)
  const knownTools = new Set<string>()

  // Add SDK built-ins
  for (const t of SDK_READ_TOOLS) knownTools.add(t)
  for (const t of SDK_WRITE_TOOLS) knownTools.add(t)

  // Add MCP server tools
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
  const combinedDenylist = new Set([...(workspaceConfig.denylist ?? []), ...scheduleDenylist])

  // Apply allowlist (intersection) — empty = no restriction
  const hasAllowlist = scheduleAllowlist.length > 0

  const entries: FrozenToolEntry[] = []
  const writeNames = new Set<string>()
  const readNames = new Set<string>()

  for (const item of knownTools) {
    // Check denylist
    if (combinedDenylist.has(item)) continue

    // Check allowlist (if specified)
    if (hasAllowlist && !scheduleAllowlist.includes(item)) continue

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
 * E.g., hasNamespaceMatch('mcp__c3__save_requirements', frozenSet) → true
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
