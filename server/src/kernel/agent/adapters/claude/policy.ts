/**
 * Claude's translation into the neutral {@link PermissionPolicy} (ADR-0011):
 * `(toolName, input, ctx) → allow | ask | deny`. The authoritative sensitivity
 * classification still lives in the SDK at runtime; this is the *neutral mirror*
 * the abstraction reasons over, driven by the 2-axis grid. It reuses the same
 * side-effect classifier the auto-resume gate uses (AS-R19) so "sensitive" means
 * one thing across the kernel.
 */
import type { PermissionPolicy } from '../types.js'
import { isSideEffectTool } from '../../../run/resume.js'

/** Edit-class tools — the "trusted prefix" that `trusted-prefix` auto-accepts. */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

export const claudePolicy: PermissionPolicy = (toolName, _input, ctx) => {
  // never-ask authorizes everything (Claude bypassPermissions). Highest priority.
  if (ctx.toolGate === 'never-ask') return 'allow'

  const sensitive = isSideEffectTool(toolName)
  // Read-only tools are never gated regardless of grid (except never-ask above,
  // already handled): the floor every gate shares.
  if (!sensitive) return 'allow'

  // plan proposes without executing: a sensitive tool is refused outright.
  if (ctx.actionMode === 'plan') return 'deny'

  switch (ctx.toolGate) {
    case 'always-ask':
      return 'ask'
    case 'trusted-prefix':
      return EDIT_TOOLS.has(toolName) ? 'allow' : 'ask'
    case 'on-sensitive':
    default:
      return 'ask'
  }
}
