/**
 * `kernel/permission/` barrel (C-SEC, server refactor 3/3) — the permission
 * gateway's public face. The single chokepoint between the SDK and the human:
 * the branded {@link PermissionDecision}, the `allow`/`deny` mints, the
 * `createCanUseTool` gateway, the pending-decision registry, and the gate policy
 * constants. Nothing constructs a verdict outside this layer.
 */
export { allow, deny, type PermissionDecision } from './decision.js'
export { createCanUseTool, type GatewaySpec } from './gateway.js'
export {
  waitForDecision,
  resolveDecision,
  pendingCount,
  registerPermissionResolver,
  type Decision,
  type DecisionResult,
} from './registry.js'
export {
  SAVE_REQUIREMENTS_TOOL,
  FIND_REQUIREMENTS_TOOL,
  VIEW_REQUIREMENT_TOOL,
  REQUIREMENT_QUERY_TOOLS,
  REQUIREMENT_DISALLOWED_TOOLS,
  REQUIREMENT_READ_TOOLS,
  classifyRequirementTool,
  withAnswers,
  type RequirementToolDecision,
} from './tools.js'
