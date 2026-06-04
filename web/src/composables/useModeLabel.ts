import { useTypedI18n } from '@/i18n'
import type { PermissionMode } from '@ccc/shared/protocol'

/**
 * Localized label for a permission mode. Returns a function bound to the
 * component's i18n composer so labels re-render on a runtime language switch.
 * Each branch is a literal nav.mode.<m>.label lookup so the keys stay
 * type-checked and are seen as "used" by i18n:check.
 */
export function useModeLabel() {
  const { t } = useTypedI18n()
  return (m: PermissionMode): string => {
    switch (m) {
      case 'default':
        return t('nav.mode.default.label')
      case 'auto':
        return t('nav.mode.auto.label')
      case 'plan':
        return t('nav.mode.plan.label')
      case 'acceptEdits':
        return t('nav.mode.acceptEdits.label')
      case 'bypassPermissions':
        return t('nav.mode.bypassPermissions.label')
    }
  }
}
