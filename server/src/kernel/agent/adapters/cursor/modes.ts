/**
 * Cursor's mode catalog (ADR-0011). The SDK gives a run two independent dials,
 * both fixed when the turn starts: the conversation `mode` (`agent` / `plan`) and
 * whether Cursor's Auto-review classifier vets each tool call (`autoReview`).
 * There is no per-tool runtime approval channel, so — exactly as with Codex —
 * `always-ask` is deliberately NOT offered: a gate that promised per-call
 * prompting would lie.
 *
 * The three presets map onto that pair:
 *  - `plan`        → plan × on-sensitive → the SDK's own `mode: 'plan'`, a
 *                    first-class read-oriented conversation mode (unlike the CLI,
 *                    where c3 had no way to verify the surface was non-mutating).
 *  - `agent`       → build × on-sensitive → `mode: 'agent'` with Auto-review on.
 *  - `full-access` → build × never-ask → `mode: 'agent'`, Auto-review off, every
 *                    tool executes unattended.
 */
import type { VendorModeCatalog } from '../types.js'

export const cursorModeCatalog: VendorModeCatalog = {
  vendor: 'cursor',
  defaultToken: 'agent',
  modes: [
    {
      token: 'plan',
      labelCode: 'nav.mode.plan.label',
      actionMode: 'plan',
      toolGate: 'on-sensitive',
    },
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
