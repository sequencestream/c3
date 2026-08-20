/**
 * The vendor tool manifest: the domain-neutral answer to "which tools can this
 * vendor be widened to, and which of them write?".
 *
 * It started as an automation-only contract, but the shape has nothing to do
 * with automations — an IM chat robot picks its allowed tools from the same
 * classified list, through the same permission grid. So it lives here, in its
 * own module, rather than in one of its two consumers: a manifest that belonged
 * to `automation.ts` would make every robot import read as a layering accident.
 *
 * The classification is a STATIC pre-judgement declared by each vendor adapter,
 * not a live probe of an MCP server. That keeps it cheap and testable, and it is
 * the same source the execution-time tool freeze classifies against, so the grid
 * a human ticks and the set the runtime enforces cannot drift apart.
 */

/** One entry in a vendor's tool manifest: tool name + read/write classification. */
export interface ToolManifestEntry {
  /** Tool name as the SDK knows it (e.g. 'Read', 'mcp__c3__find_intents'). */
  name: string
  /** Whether this tool is classified as a write operation. */
  isWrite: boolean
}

/**
 * Which permission grid asked for a manifest. The automation form asks for a
 * workspace's vendor tools; the robot form asks for the same vendor's tools with
 * no workspace at all (a robot is deliberately not scoped to one). The reply can
 * land after the asking form closed, so the caller echoes `scope` back and the
 * web layer routes it to the right cache instead of guessing.
 */
export type ToolManifestScope = 'automation' | 'robot'

/**
 * Reserved pseudo-entry an automation or a robot may carry in its
 * `toolAllowlist` to toggle raw network access for a codex `workspace-write`
 * sandbox (which denies network by default).
 *
 * It is NOT a real tool: it never enters `freezeTools()`, never enters a robot's
 * `allowedTools` or its tool gate, never appears in the read/write grid, is
 * stripped before the real tool allowlist is computed, and is silently ignored
 * for vendors with no such network control (claude). Shared so server (strip +
 * passthrough) and web (form toggle) agree on the exact marker.
 */
export const NETWORK_ACCESS_TOOL = 'network-access'

/**
 * The `mcp__c3__` namespace prefix. c3's own MCP tools are served over the
 * loopback HTTP MCP route rather than a user-configured workspace MCP server,
 * so both the manifest and the runtime binder recognise them by this prefix.
 */
export const C3_MCP_TOOL_PREFIX = 'mcp__c3__'

/** Whether a manifest entry (or an allowlist item) is one of c3's own MCP tools. */
export function isC3McpTool(name: string): boolean {
  return name.startsWith(C3_MCP_TOOL_PREFIX)
}
