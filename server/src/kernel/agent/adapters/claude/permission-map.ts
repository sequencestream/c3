/**
 * Claude `PermissionMode` ⇄ neutral `ActionMode × ToolGate` translation
 * (ADR-0011). The 1:1 mapping is deliberately abandoned: the neutral grid is
 * orthogonal (what the run may *do* vs how tools are *gated*), and Claude's
 * five-way mode collapses some cells (`auto` is `default` biased toward
 * auto-progress — the bias does not survive the round trip and is documented as
 * lossy). Both directions are total; the reverse picks the closest Claude mode
 * when the grid has no exact peer (e.g. `always-ask` has no Claude mode).
 *
 * Since 2026-06-07-012 these are thin wrappers over the GENERIC catalog helpers
 * driven by {@link claudeModeCatalog} (the SoT) — Claude no longer hand-writes the
 * table. The public `from/toPermissionMode` API is preserved for existing callers.
 */
import type { PermissionMode } from '@ccc/shared/protocol'
import type { ActionMode, ToolGate } from '../types.js'
import { gridToToken, tokenToGrid } from '../mode-catalog.js'
import { claudeModeCatalog } from './modes.js'

/** Claude mode → neutral grid (via {@link claudeModeCatalog}). `auto`'s bias is lossy. */
export function fromPermissionMode(mode: PermissionMode): {
  actionMode: ActionMode
  toolGate: ToolGate
} {
  return tokenToGrid(claudeModeCatalog, mode)
}

/** Neutral grid → closest Claude mode. `plan` dominates; `always-ask`→`default`. */
export function toPermissionMode(actionMode: ActionMode, toolGate: ToolGate): PermissionMode {
  return gridToToken(claudeModeCatalog, { actionMode, toolGate }) as PermissionMode
}
