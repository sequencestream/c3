/**
 * The `save_intents` confirmation gate for the DRIVER path (2026-06-12-005).
 *
 * On the claude path the SDK's `canUseTool` (classifyIntentTool ⇒ confirm-save)
 * gates a save. Codex/opencode call the intent tools over HTTP MCP, outside any
 * c3 `canUseTool`, so the gate must live in the save handler itself: emit the SAME
 * `permission_request` wire frame the claude path uses (toolName
 * `mcp__c3__save_intents`, `input.intents`), block on `waitForDecision`, and only
 * persist on `allow`. A deny / aborted run never reaches the store.
 *
 * Pure + dependency-injected (emit / waitForDecision / broadcast), so the gate is
 * unit-testable without the wire or the live permission registry, and so this
 * feature module never imports the transport layer (no `transport ↔ features`
 * cycle — the composition root passes the binding in by structure).
 */
import type { ServerToClient } from '@ccc/shared/protocol'
import { SAVE_INTENTS_TOOL } from '../../kernel/permission/index.js'
import type { PermissionRequestCtx } from '../../kernel/permission/index.js'
import { runSaveConfirmed, type IntentToolResult, type SaveArgs } from './tool-defs.js'

export interface SaveGateDeps {
  emit: (runId: string, frame: ServerToClient) => void
  waitForDecision: (
    requestId: string,
    signal?: AbortSignal,
  ) => Promise<{ decision: 'allow' | 'deny' }>
  broadcastIntents: (workspacePath: string) => void
  /**
   * WorkCenter event hook — invoked BEFORE the `permission_request` frame so the
   * codex intent save lands a `source='intent'` WaitUserInvolveEvent + broadcast,
   * not just the active-chat prompt. Wired at the composition root (the same handler
   * the claude/driver paths use). Absent in tests that don't assert registration.
   */
  onPermissionRequest?: (ctx: PermissionRequestCtx) => void
  /** Injected for tests; defaults to `crypto.randomUUID`. */
  makeRequestId?: () => string
}

/** Per-run binding (structurally the transport's `IntentMcpBinding`, imported by value). */
export interface SaveGateBinding {
  workspacePath: string
  getRunId: () => string
  signal: AbortSignal
}

/** Run the confirmation gate, then persist iff the user allowed. */
export async function gatedSave(
  deps: SaveGateDeps,
  binding: SaveGateBinding,
  args: SaveArgs,
): Promise<IntentToolResult> {
  const requestId = (deps.makeRequestId ?? (() => crypto.randomUUID()))()
  const runId = binding.getRunId()
  const input = { intents: args.intents }
  // Register the WorkCenter event + broadcast BEFORE the wire frame (claude-parity).
  // A codex intent save always originates from the read-only comm agent ⇒ source 'intent'.
  deps.onPermissionRequest?.({
    requestId,
    toolName: SAVE_INTENTS_TOOL,
    input,
    sessionId: runId,
    workspacePath: binding.workspacePath,
    source: 'intent',
  })
  deps.emit(runId, {
    type: 'permission_request',
    requestId,
    toolName: SAVE_INTENTS_TOOL,
    input,
  })
  const { decision } = await deps.waitForDecision(requestId, binding.signal)
  if (decision !== 'allow') {
    return { content: [{ type: 'text', text: '用户在 c3 UI 拒绝了保存,未落库。' }] }
  }
  return runSaveConfirmed(binding.workspacePath, args, deps.broadcastIntents)
}
