/**
 * Claude `PermissionMode` ⇄ neutral `ActionMode × ToolGate` translation
 * (ADR-0011). The 1:1 mapping is deliberately abandoned: the neutral grid is
 * orthogonal (what the run may *do* vs how tools are *gated*), and Claude's
 * five-way mode collapses some cells (`auto` is `default` biased toward
 * auto-progress — the bias does not survive the round trip and is documented as
 * lossy). The forward map (mode → grid) and the reverse (grid → mode) are both
 * total; the reverse picks the closest Claude mode when the grid has no exact
 * peer (e.g. `always-ask` has no Claude mode — `default` is nearest).
 */
import type { PermissionMode } from '@ccc/shared/protocol'
import type { ActionMode, ToolGate } from '../types.js'

/** Claude mode → neutral grid (010/ADR-0011 table). `auto`'s bias is lossy. */
export function fromPermissionMode(mode: PermissionMode): {
  actionMode: ActionMode
  toolGate: ToolGate
} {
  switch (mode) {
    case 'plan':
      return { actionMode: 'plan', toolGate: 'on-sensitive' }
    case 'acceptEdits':
      return { actionMode: 'build', toolGate: 'trusted-prefix' }
    case 'bypassPermissions':
      return { actionMode: 'build', toolGate: 'never-ask' }
    case 'auto':
    case 'default':
    default:
      return { actionMode: 'build', toolGate: 'on-sensitive' }
  }
}

/** Neutral grid → closest Claude mode. `plan` dominates; `always-ask`→`default`. */
export function toPermissionMode(actionMode: ActionMode, toolGate: ToolGate): PermissionMode {
  if (actionMode === 'plan') return 'plan'
  switch (toolGate) {
    case 'never-ask':
      return 'bypassPermissions'
    case 'trusted-prefix':
      return 'acceptEdits'
    case 'on-sensitive':
    case 'always-ask':
    default:
      return 'default'
  }
}
