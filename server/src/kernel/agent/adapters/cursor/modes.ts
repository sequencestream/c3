/**
 * Cursor's mode catalog (ADR-0011). Cursor's permission surface is decided once,
 * at launch: the run either carries the force/allow-everything flag or falls back
 * to the user's own `~/.cursor` allowlist. There is no per-tool runtime approval
 * channel, so — exactly as with Codex — `always-ask` is deliberately NOT offered:
 * a gate that promised per-call prompting would lie.
 *
 * Only genuinely redeemable **build** strategies appear here:
 *  - `agent`       → build × on-sensitive → the user's own `~/.cursor` allowlist
 *                    decides; c3 adds nothing and takes nothing away.
 *  - `full-access` → build × never-ask → `--force`, every tool auto-executes.
 *
 * **`plan` is intentionally absent, not forgotten.** The CLI does expose a
 * `--mode plan` (and `--mode ask`) read-only surface, but no probe has yet proven
 * that it is genuinely non-mutating end-to-end, and this catalog only advertises
 * what has been demonstrated. Because omission alone would let a session that
 * carries a plan token from another vendor silently start in a *writable* mode,
 * the driver additionally hard-fails any run whose neutral {@link ActionMode}
 * resolves to `plan` — refusing to start is the honest outcome; quietly becoming
 * writable is not. Proving `--mode plan` read-only is what unlocks a `plan` entry
 * here and removes that refusal.
 */
import type { VendorModeCatalog } from '../types.js'

export const cursorModeCatalog: VendorModeCatalog = {
  vendor: 'cursor',
  defaultToken: 'agent',
  modes: [
    {
      token: 'agent',
      labelCode: 'nav.mode.agent.label',
      actionMode: 'build',
      toolGate: 'on-sensitive',
    },
    {
      token: 'full-access',
      labelCode: 'nav.mode.fullAccess.label',
      actionMode: 'build',
      toolGate: 'never-ask',
    },
  ],
}
