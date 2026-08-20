/**
 * Tool-manifest messages: the request/reply pair every permission grid uses.
 *
 * One contract serves both consumers. The automation form asks for a workspace's
 * vendor tools; the robot form asks for the same vendor's tools with no workspace
 * at all (a robot is deliberately not scoped to one), which is why
 * `workspaceName` is optional rather than two near-identical messages.
 */
import type { VendorId } from './vendor.js'
import type { ToolManifestEntry, ToolManifestScope } from './tool-manifest.js'

/**
 * Request a vendor's tool manifest for a permission grid. Server replies with
 * `tool_manifest`.
 *
 * `workspaceName` narrows the manifest to one workspace's configured MCP servers
 * (their `mcp__<server>__` namespace prefixes join the list). Omitted — the chat
 * robot case — the reply carries the vendor's built-ins plus c3's own MCP tools
 * and no workspace namespaces, because there is no workspace to read.
 */
export type ClientGetToolManifest = {
  type: 'get_tool_manifest'
  vendor: VendorId
  workspaceName?: string
  scope?: ToolManifestScope
}

/** A vendor's tool manifest (reply to `get_tool_manifest`). */
export type ServerToolManifest = {
  type: 'tool_manifest'
  vendor: VendorId
  tools: ToolManifestEntry[]
  scope?: ToolManifestScope
}
