import type { StateDeps } from './types'
import { buildSessionSlice } from './session'
import { buildNavigationSlice } from './navigation'
import { buildDeliverySlice } from './delivery'
import { buildIntentSlice } from './intent'
import { buildDiscussionSlice } from './discussion'
import { buildAutomationSlice } from './automation'
import { buildFilesSlice } from './files'
import { buildSettingsSlice } from './settings'
import { buildCrossDomainSlice } from './cross-domain'

export function buildAppState(deps: StateDeps) {
  const session = buildSessionSlice(deps)
  const navigation = buildNavigationSlice()
  const delivery = buildDeliverySlice()
  const intent = buildIntentSlice(deps, navigation)
  const discussion = buildDiscussionSlice()
  const automation = buildAutomationSlice()
  const files = buildFilesSlice()
  const settings = buildSettingsSlice()
  const cross = buildCrossDomainSlice(deps, session, navigation, delivery, settings)

  return {
    ...session,
    ...navigation,
    ...delivery,
    ...intent,
    ...discussion,
    ...automation,
    ...files,
    ...settings,
    ...cross,
  }
}
