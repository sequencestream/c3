/**
 * `kernel/permission/` barrel (C-SEC, server refactor 3/3) — the permission
 * gateway's public face. The single chokepoint between the SDK and the human:
 * the branded {@link PermissionDecision}, the `allow`/`deny` mints, the
 * `createCanUseTool` gateway, the pending-decision registry, and the gate policy
 * constants. Nothing constructs a verdict outside this layer.
 */
export { allow, deny, type PermissionDecision } from './decision.js'
export { createCanUseTool, type GatewaySpec, type PermissionRequestCtx } from './gateway.js'
export {
  waitForDecision,
  resolveDecision,
  pendingCount,
  registerPermissionResolver,
  type Decision,
  type DecisionResult,
} from './registry.js'
export {
  SAVE_INTENTS_TOOL,
  FIND_INTENTS_TOOL,
  VIEW_INTENT_TOOL,
  INTENT_QUERY_TOOLS,
  INTENT_DISALLOWED_TOOLS,
  INTENT_READ_TOOLS,
  classifyIntentTool,
  withAnswers,
  type IntentToolDecision,
} from './tools.js'
