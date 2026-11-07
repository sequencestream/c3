import type { ToolManifestEntry } from '../types.js'

/** Conservative static names aligned with permission risk rules; plugin tools may differ at runtime. */
const DSH_KNOWN_TOOLS: readonly { name: string; isWrite: boolean }[] = [
  { name: 'shell', isWrite: true },
  { name: 'bash', isWrite: true },
  { name: 'write', isWrite: true },
  { name: 'edit', isWrite: true },
]

export function listDshTools(mcpServers?: Record<string, unknown>): ToolManifestEntry[] {
  const entries: ToolManifestEntry[] = DSH_KNOWN_TOOLS.map((t) => ({ ...t }))
  if (mcpServers) {
    for (const serverName of Object.keys(mcpServers)) {
      entries.push({ name: `mcp__${serverName}__`, isWrite: true })
    }
  }
  return entries
}
