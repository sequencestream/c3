/**
 * Codex's mode catalog (ADR-0011, 2026-06-07-012). Codex's native permission
 * surface is `sandboxMode × approvalPolicy`, with NO per-tool runtime approval
 * (008 NO-GO) — the launch-time gate IS the enforcement. Rather than expose that
 * 2-D matrix raw, the catalog surfaces three semantic presets that mirror Codex's
 * own UX (read-only / auto / full-access), each mapped to a distinct neutral grid
 * cell. At launch the grid is fed to {@link gateToCodexPolicy} which produces the
 * actual `sandboxMode`/`approvalPolicy` — so token → grid → codex policy is one
 * consistent chain:
 *  - `read-only`   → plan × on-sensitive → read-only sandbox (no writes).
 *  - `auto`        → build × on-sensitive → workspace-write + on-request.
 *  - `full-access` → build × never-ask → workspace-write + never (no asking).
 *
 * `always-ask` is intentionally NOT offered: Codex cannot ask per-tool, so a gate
 * that promised it would lie (it degrades to read-only in `gateToCodexPolicy`).
 */
import type { VendorModeCatalog } from '../types.js'

export const codexModeCatalog: VendorModeCatalog = {
  vendor: 'codex',
  defaultToken: 'auto',
  modes: [
    {
      token: 'read-only',
      labelCode: 'nav.mode.readOnly.label',
      actionMode: 'plan',
      toolGate: 'on-sensitive',
    },
    {
      token: 'auto',
      labelCode: 'nav.mode.auto.label',
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
