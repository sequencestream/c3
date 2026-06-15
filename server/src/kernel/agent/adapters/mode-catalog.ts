/**
 * Generic per-vendor mode-catalog translation (ADR-0011, 2026-06-07-012). A
 * {@link VendorModeCatalog} is the single SoT for one vendor's selectable modes:
 * each {@link VendorModeDescriptor} pairs a native `token` with the neutral
 * `ActionMode × ToolGate` grid cell it means. These two pure helpers turn that
 * declaration into the bidirectional translation every adapter needs — so an
 * adapter only DECLARES its catalog (claude/codex `modes.ts`) and reuses
 * the math here, instead of hand-writing a `permission-map` each.
 *
 * The forward map (`tokenToGrid`) is total: an unknown token degrades to the
 * catalog's `defaultToken` grid (a stored token from an older/other vendor never
 * throws). The reverse (`gridToToken`) is the lossy direction — the catalog has
 * fewer cells than the full 2×4 grid, so it picks the nearest declared token:
 * exact (actionMode + toolGate) first, then same `actionMode`, else `defaultToken`.
 * This reproduces, generically, exactly what Claude's `permission-map` did by hand.
 */
import type { NeutralMode, VendorModeCatalog } from './types.js'

/** The descriptor for a token, or the catalog's default descriptor when unknown. */
function describe(cat: VendorModeCatalog, token: string) {
  return (
    cat.modes.find((m) => m.token === token) ??
    cat.modes.find((m) => m.token === cat.defaultToken) ??
    cat.modes[0]
  )
}

/** Vendor-native token → neutral grid. Total: unknown tokens fall to `defaultToken`. */
export function tokenToGrid(cat: VendorModeCatalog, token: string): NeutralMode {
  const d = describe(cat, token)
  return { actionMode: d.actionMode, toolGate: d.toolGate }
}

/**
 * Neutral grid → nearest vendor-native token. Exact cell match wins; failing that,
 * the first token sharing the `actionMode` (so a `plan` grid never resolves to a
 * `build` token); failing that, the catalog's `defaultToken`.
 */
export function gridToToken(cat: VendorModeCatalog, grid: NeutralMode): string {
  const exact = cat.modes.find(
    (m) => m.actionMode === grid.actionMode && m.toolGate === grid.toolGate,
  )
  if (exact) return exact.token
  const sameAction = cat.modes.find((m) => m.actionMode === grid.actionMode)
  if (sameAction) return sameAction.token
  return cat.defaultToken
}

/** True iff `token` is a declared mode of the catalog (not the degraded fallback). */
export function isKnownToken(cat: VendorModeCatalog, token: string): boolean {
  return cat.modes.some((m) => m.token === token)
}
