/**
 * Claude's mode catalog (ADR-0011, 2026-06-07-012): the five Agent-SDK
 * `PermissionMode` tokens, each mapped to the neutral `ActionMode × ToolGate`
 * grid. This is now the SoT the `permission-map` helpers derive from — the
 * hand-written switch is gone, replaced by the generic `tokenToGrid`/`gridToToken`.
 *
 * `default` and `auto` deliberately share the `build × on-sensitive` cell (the
 * `auto` bias toward auto-progress does not survive the grid round trip — it was
 * always lossy); `default` precedes `auto` so a reverse map of that cell resolves
 * to `default`, matching the prior `toPermissionMode` behaviour.
 */
import type { VendorModeCatalog } from '../types.js'

export const claudeModeCatalog: VendorModeCatalog = {
  vendor: 'claude',
  defaultToken: 'default',
  modes: [
    {
      token: 'default',
      labelCode: 'nav.mode.default.label',
      actionMode: 'build',
      toolGate: 'on-sensitive',
    },
    {
      token: 'auto',
      labelCode: 'nav.mode.auto.label',
      actionMode: 'build',
      toolGate: 'on-sensitive',
    },
    {
      token: 'plan',
      labelCode: 'nav.mode.plan.label',
      actionMode: 'plan',
      toolGate: 'on-sensitive',
    },
    {
      token: 'acceptEdits',
      labelCode: 'nav.mode.acceptEdits.label',
      actionMode: 'build',
      toolGate: 'trusted-prefix',
    },
    {
      token: 'bypassPermissions',
      labelCode: 'nav.mode.bypassPermissions.label',
      actionMode: 'build',
      toolGate: 'never-ask',
    },
  ],
}
