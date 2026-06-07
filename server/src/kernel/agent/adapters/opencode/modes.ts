/**
 * OpenCode's mode catalog (ADR-0011, 2026-06-07-012). OpenCode's native surface is
 * the per-tool `allow`/`ask`/`deny` permission (resolved out-of-loop via
 * `permission.updated` + REST) crossed with the Build vs Plan agent. The catalog
 * surfaces three curated modes mapping that onto the neutral grid:
 *  - `plan`        → plan × on-sensitive — the Plan agent (proposes, no writes).
 *  - `build`       → build × on-sensitive — the Build agent, asking on sensitive tools.
 *  - `build-allow` → build × never-ask — the Build agent, auto-allowing everything.
 *
 * Unlike Codex, OpenCode HAS a live approval point (`perToolApproval` true), so the
 * gate is honoured at runtime by the approval bridge — the grid drives the policy
 * the bridge enforces. (Wiring the driver to actually swap Build/Plan agent off
 * `actionMode` is a follow-up; this task declares the catalog + translation.)
 */
import type { VendorModeCatalog } from '../types.js'

export const opencodeModeCatalog: VendorModeCatalog = {
  vendor: 'opencode',
  defaultToken: 'build',
  modes: [
    {
      token: 'plan',
      labelCode: 'nav.mode.plan.label',
      actionMode: 'plan',
      toolGate: 'on-sensitive',
    },
    {
      token: 'build',
      labelCode: 'nav.mode.build.label',
      actionMode: 'build',
      toolGate: 'on-sensitive',
    },
    {
      token: 'build-allow',
      labelCode: 'nav.mode.buildAllow.label',
      actionMode: 'build',
      toolGate: 'never-ask',
    },
  ],
}
