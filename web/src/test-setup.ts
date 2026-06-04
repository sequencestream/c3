import { config } from '@vue/test-utils'
import { i18n } from '@/i18n'

// Component tests mount real SFCs that call useI18n(); install the app's i18n
// instance globally so t() resolves. Assertions key off data-testid / emitted /
// structure — never visible copy — so real messages are fine (see i18n-spec §4).
config.global.plugins = [i18n]
