/**
 * Claude-boundary translation of the vendor-neutral {@link RemoteMcpServer}
 * descriptors into the Claude Agent SDK's HTTP MCP config. Both Claude and Codex
 * now reach c3's own tools (intent / spec-query / work-event / automation) over
 * the SAME loopback streamable-HTTP MCP routes; this is the only place the neutral
 * descriptor meets an Anthropic SDK type, so the SDK dependency stays confined to
 * the Claude adapter and never leaks into the neutral descriptor or the transport.
 *
 * The route already registers ONLY the tools its endpoint contract permits (the
 * intent route exposes find/view/save, spec-query only find/view, …), so the tool
 * SET is limited server-side; `enabledTools` on the descriptor is the Codex-side
 * allowlist and needs no Claude translation. `alwaysLoad: true` keeps the tools
 * resident in the turn-1 prompt (parity with the removed in-process servers, which
 * set the SDK's `alwaysLoad`), so the model never has to ToolSearch a c3 tool back
 * before using it; it also blocks startup until the loopback server connects, which
 * is instant on the same host.
 */
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { RemoteMcpServer } from '../types.js'

/**
 * Convert a neutral remote-MCP server map (as returned by a c3 HTTP MCP route's
 * `bind()`) into the Claude SDK `mcpServers` config. A run that binds no c3 route
 * passes an empty map and gets an empty config (no c3 tools), matching the prior
 * in-process behaviour where a non-intent/non-work run had no c3 server.
 */
export function remoteMcpToClaudeConfig(
  servers: Record<string, RemoteMcpServer>,
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const [name, s] of Object.entries(servers)) {
    out[name] = {
      type: 'http',
      url: s.url,
      alwaysLoad: true,
    }
  }
  return out
}
