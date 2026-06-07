/**
 * Claude vendor adapter (ADR-0011) — assembles the reference {@link VendorAdapter}
 * from its driver, approval bridge, and session store. The upper layer selects
 * this by `VendorId === 'claude'` and drives it through the neutral faces only.
 */
import type { VendorAdapter } from '../types.js'
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

/** Build the Claude {@link VendorAdapter}. Each call yields fresh instances. */
export function createClaudeAdapter(): VendorAdapter {
  return {
    vendor: 'claude',
    capabilities: claudeCapabilities,
    driver: new ClaudeDriver(),
    approval: new ClaudeApprovalBridge(),
    sessions: new ClaudeSessionStore(),
    skill: createClaudeSkillLoader(),
  }
}
