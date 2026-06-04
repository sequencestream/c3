// Translate a server-sent UiError ({ code, params }) into a localized string via
// the web i18n catalog. The server never sends translated text — it sends a code;
// the code→key map (UI_ERROR_CODES, the shared SoT) and the en.json key are kept
// in sync by `pnpm i18n:check`, so the cast to LocaleKey is safe at runtime.
import type { UiError } from '@ccc/shared/ui-codes'
import { UI_ERROR_CODES } from '@ccc/shared/ui-codes'
import { t, type LocaleKey } from './index'

export function translateUiError(err: UiError): string {
  const def = UI_ERROR_CODES[err.code]
  return t(def.key as LocaleKey, err.params)
}
