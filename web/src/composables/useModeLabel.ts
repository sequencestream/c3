import { useTypedI18n } from '@/i18n'
import type { ModeToken } from '@ccc/shared/protocol'

/**
 * The built-in Claude mode list (token + i18n `labelCode`) — the fallback the mode
 * picker renders when the server has not delivered `settings.vendorModes` (an older
 * server, or a session whose vendor catalog is absent). Mirrors the kernel's
 * `claudeModeCatalog` so the no-catalog path keeps today's Claude five-mode UX.
 */
export const CLAUDE_MODE_FALLBACK: { token: ModeToken; labelCode: string }[] = [
  { token: 'default', labelCode: 'nav.mode.default.label' },
  { token: 'auto', labelCode: 'nav.mode.auto.label' },
  { token: 'plan', labelCode: 'nav.mode.plan.label' },
  { token: 'acceptEdits', labelCode: 'nav.mode.acceptEdits.label' },
  { token: 'bypassPermissions', labelCode: 'nav.mode.bypassPermissions.label' },
]

/**
 * Localized label for a vendor mode, keyed by its catalog `labelCode`
 * (2026-06-07-012). A static switch over every known code keeps the keys
 * type-checked by the typed `t` and counted as "used" by i18n:check; an unknown
 * code falls back to the raw string. Returns a function bound to the component's
 * i18n composer so labels re-render on a runtime language switch.
 */
export function useModeLabel() {
  const { t } = useTypedI18n()
  return (labelCode: string): string => {
    switch (labelCode) {
      case 'nav.mode.default.label':
        return t('nav.mode.default.label')
      case 'nav.mode.auto.label':
        return t('nav.mode.auto.label')
      case 'nav.mode.plan.label':
        return t('nav.mode.plan.label')
      case 'nav.mode.acceptEdits.label':
        return t('nav.mode.acceptEdits.label')
      case 'nav.mode.bypassPermissions.label':
        return t('nav.mode.bypassPermissions.label')
      case 'nav.mode.readOnly.label':
        return t('nav.mode.readOnly.label')
      case 'nav.mode.fullAccess.label':
        return t('nav.mode.fullAccess.label')
      case 'nav.mode.build.label':
        return t('nav.mode.build.label')
      case 'nav.mode.buildAllow.label':
        return t('nav.mode.buildAllow.label')
      default:
        return labelCode
    }
  }
}
