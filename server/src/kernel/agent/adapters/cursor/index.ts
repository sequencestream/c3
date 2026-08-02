/**
 * The Cursor {@link VendorAdapter} — the four neutral faces (driver, approval,
 * sessions, skill) plus the tool manifest, assembled behind one factory.
 */
import { homedir } from 'node:os'
import type { DriverStartOptions, ToolManifestEntry, VendorAdapter } from '../types.js'
import { cursorCapabilities } from './capabilities.js'
import { CursorDriver, type CursorSpawn } from './driver.js'
import { CursorApprovalBridge } from './approval.js'
import { CursorSessionStore, type CursorMirror } from './session-store.js'
import { createCursorSkillLoader } from './skill.js'
import { CURSOR_TOOL_CATEGORIES, cursorToolDisplayName, cursorToolIsWrite } from './tools.js'
import type { CursorLaunchConfig } from './launch.js'

export { CursorDriver } from './driver.js'
export { cursorCapabilities } from './capabilities.js'
export { cursorModeCatalog } from './modes.js'
export { CursorUnsupportedError } from './launch.js'

/** How the adapter finds the CLI and which data root a run should use. */
export interface CursorAdapterOptions {
  /** Resolve the executable + data root for a run. */
  resolveConfig?: (opts: DriverStartOptions) => CursorLaunchConfig
  /** c3-side canonical mirror backing session list/read. */
  mirror?: CursorMirror
  /** Spawn seam for tests. */
  spawnFn?: CursorSpawn
}

/**
 * Default launch resolution: run the `cursor-agent` on PATH against the host data
 * root, unless the run supplies a sandbox wrapper. Callers that manage binaries
 * or sandbox data roots pass their own resolver.
 */
function defaultResolveConfig(opts: DriverStartOptions): CursorLaunchConfig {
  return {
    command: opts.sandboxWrapperPath ?? 'cursor-agent',
    home: homedir(),
  }
}

export function createCursorAdapter(options: CursorAdapterOptions = {}): VendorAdapter {
  const resolveConfig = options.resolveConfig ?? defaultResolveConfig
  return {
    vendor: 'cursor',
    capabilities: cursorCapabilities,
    driver: new CursorDriver(resolveConfig, options.spawnFn),
    approval: new CursorApprovalBridge(),
    sessions: new CursorSessionStore(options.mirror),
    skill: createCursorSkillLoader(),
    listTools(_workspacePath, mcpServers) {
      // The static table is the CLI's own proven tool inventory; each entry is a
      // tool the stream can actually emit, named as the console shows it.
      const entries: ToolManifestEntry[] = Object.keys(CURSOR_TOOL_CATEGORIES).map(
        (wrapperKey) => ({
          name: cursorToolDisplayName(wrapperKey),
          isWrite: cursorToolIsWrite(wrapperKey),
        }),
      )
      // MCP tools are reachable in `-p` runs, but their individual names are only
      // known after a live handshake, so the namespace prefix is exposed and
      // treated as write — the conservative reading for an unenumerated tool.
      if (mcpServers) {
        for (const serverName of Object.keys(mcpServers)) {
          entries.push({ name: `mcp__${serverName}__`, isWrite: true })
        }
      }
      return entries
    },
  }
}
