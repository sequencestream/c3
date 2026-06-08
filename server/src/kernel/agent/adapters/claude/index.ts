/**
 * Claude vendor adapter (ADR-0011) — assembles the reference {@link VendorAdapter}
 * from its driver, approval bridge, and session store. The upper layer selects
 * this by `VendorId === 'claude'` and drives it through the neutral faces only.
 */
import type { ToolManifestEntry, VendorAdapter } from '../types.js'
import { claudeCapabilities } from './capabilities.js'
import { ClaudeDriver } from './driver.js'
import { ClaudeApprovalBridge } from './approval.js'
import { ClaudeSessionStore } from './session-store.js'
import { createClaudeSkillLoader } from './skill.js'

export { claudeCapabilities } from './capabilities.js'
export { ClaudeDriver } from './driver.js'
export { ClaudeApprovalBridge } from './approval.js'
export { ClaudeSessionStore } from './session-store.js'
export { createClaudeSkillLoader } from './skill.js'
export { claudePolicy } from './policy.js'
export { fromPermissionMode, toPermissionMode } from './permission-map.js'
export { ClaudeStreamTranslator, transcriptToCanonical } from './translate.js'
export {
  ClaudeTaskStore,
  createClaudeTaskExecutor,
  type ClaudeTaskExecutor,
  type ClaudeTaskExecutorOptions,
} from './task-store.js'

// ---------------------------------------------------------------------------
// Built-in SDK tool classification (same classification as mcp-freeze.ts)
// ---------------------------------------------------------------------------

/** Built-in SDK tools considered read-only. */
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

/** Built-in SDK tools considered write operations. */
const SDK_WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'Agent', 'Bash'])

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

/** Build the Claude {@link VendorAdapter}. Each call yields fresh instances. */
export function createClaudeAdapter(): VendorAdapter {
  return {
    vendor: 'claude',
    capabilities: claudeCapabilities,
    driver: new ClaudeDriver(),
    approval: new ClaudeApprovalBridge(),
    sessions: new ClaudeSessionStore(),
    skill: createClaudeSkillLoader(),
    listTools(_workspacePath, mcpServers) {
      const entries: ToolManifestEntry[] = []
      // SDK read tools
      for (const t of SDK_READ_TOOLS) entries.push({ name: t, isWrite: false })
      // SDK write tools
      for (const t of SDK_WRITE_TOOLS) entries.push({ name: t, isWrite: true })
      // Workspace MCP server namespace prefixes (if configured)
      if (mcpServers) {
        for (const serverName of Object.keys(mcpServers)) {
          // Namespace prefix, classified conservative (write)
          entries.push({ name: `mcp__${serverName}__`, isWrite: true })
        }
      }
      return entries
    },
  }
}
