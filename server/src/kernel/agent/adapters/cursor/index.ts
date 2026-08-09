/**
 * The Cursor {@link VendorAdapter} — the four neutral faces (driver, approval,
 * sessions, skill) plus the tool manifest, assembled behind one factory.
 */
import type { DriverStartOptions, ToolManifestEntry, VendorAdapter } from '../types.js'
import { cursorCapabilities } from './capabilities.js'
import { CursorDriver } from './driver.js'
import type { CursorCli } from './cli.js'
import { CursorApprovalBridge } from './approval.js'
import { CursorSessionStore, type CursorSessionSource } from './session-store.js'
import { createCursorSkillLoader } from './skill.js'
import { CURSOR_TOOL_CATEGORIES, cursorToolIsWrite } from './tools.js'
import type { CursorLaunchConfig } from './launch.js'

export { CursorDriver } from './driver.js'
export { cursorCapabilities } from './capabilities.js'
export { cursorModeCatalog } from './modes.js'
export { CursorUnsupportedError, resolveCursorApiKey } from './launch.js'

/** How the adapter authenticates a run and where it reads sessions from. */
export interface CursorAdapterOptions {
  /** Resolve the credential for a run. */
  resolveConfig?: (opts: DriverStartOptions) => CursorLaunchConfig
  /** Read seam over the on-disk chat store, backing session list/read. */
  sessionSource?: CursorSessionSource
  /** Process seam for tests. */
  cli?: CursorCli
}

/**
 * Default credential resolution: the ambient `CURSOR_API_KEY`. Callers that
 * store a per-agent key (the settings panel does) pass their own resolver;
 * `resolveCursorApiKey` applies the same environment fallback either way.
 */
function defaultResolveConfig(_opts: DriverStartOptions): CursorLaunchConfig {
  return {}
}

export function createCursorAdapter(options: CursorAdapterOptions = {}): VendorAdapter {
  const resolveConfig = options.resolveConfig ?? defaultResolveConfig
  return {
    vendor: 'cursor',
    capabilities: cursorCapabilities,
    driver: new CursorDriver(resolveConfig, options.cli),
    approval: new CursorApprovalBridge(),
    sessions: new CursorSessionStore(options.sessionSource),
    skill: createCursorSkillLoader(),
    listTools(_workspacePath, mcpServers) {
      // The static table is Cursor's own tool union; each entry is a tool the
      // stream can actually emit, named as the console shows it.
      const entries: ToolManifestEntry[] = Object.keys(CURSOR_TOOL_CATEGORIES).map((name) => ({
        name,
        isWrite: cursorToolIsWrite(name),
      }))
      // MCP tools reach the model through the `mcp` tool, but their individual
      // names are only known after a live handshake, so the namespace prefix is
      // exposed and treated as write — the conservative reading for an
      // unenumerated tool.
      if (mcpServers) {
        for (const serverName of Object.keys(mcpServers)) {
          entries.push({ name: `mcp__${serverName}__`, isWrite: true })
        }
      }
      return entries
    },
  }
}
