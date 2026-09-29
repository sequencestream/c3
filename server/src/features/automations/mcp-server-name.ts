import type { VendorId } from '@ccc/shared/protocol'

/**
 * The MCP server name exposed to one automation execution.
 *
 * Codex retains MCP clients by configured server name, so every execution gets
 * a cache-busting name. Other vendors consume a fresh binding under `c3`.
 */
export function automationMcpServerName(vendor: VendorId, executionId: string): string {
  return vendor === 'codex' ? `c3_${executionId.replace(/[^A-Za-z0-9_-]/g, '_')}` : 'c3'
}
