import type { VendorModeCatalog } from '../types.js'

/** DSH maps permission presets through native slash commands at runtime; catalog is advisory. */
export const dshModeCatalog: VendorModeCatalog = {
  vendor: 'dsh',
  defaultToken: 'default',
  modes: [
    {
      token: 'default',
      labelCode: 'nav.mode.default.label',
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
      token: 'full-access',
      labelCode: 'nav.mode.fullAccess.label',
      actionMode: 'build',
      toolGate: 'never-ask',
    },
  ],
}
