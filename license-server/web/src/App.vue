<script setup lang="ts">
import { computed } from 'vue'
import { query } from './lib/api'
import { SUPPORTED_LOCALES, i18n, setLocale, useTypedI18n, type Locale } from './i18n'
import LoginView from './views/LoginView.vue'
import ActivateView from './views/ActivateView.vue'
import CheckoutView from './views/CheckoutView.vue'
import AccountView from './views/AccountView.vue'
import AgreementView from './views/AgreementView.vue'
import PlansView from './views/PlansView.vue'

const { t } = useTypedI18n()
// Read the active locale off the typed global (createI18n is parameterized with
// Locale, so this ref is "zh" | "en"); the composer's own `locale` defaults to a
// vue-i18n literal type and isn't reliable for the comparison below.
const currentLocale = computed(() => i18n.global.locale.value)

// Minimal path-based router (all pages are this SPA, served at /). The flows are
// full-page (OAuth redirect, form POST), so reading the path at load is enough;
// no client-side history navigation is needed.
const view = computed(() => {
  const path = window.location.pathname
  if (path.startsWith('/login')) return 'login'
  if (path.startsWith('/agreement')) return 'agreement'
  if (path.startsWith('/plans')) return 'plans'
  if (path.startsWith('/checkout')) return 'checkout'
  if (path.startsWith('/account')) return 'account'
  // Root: the binding round (installId+requestId) means c3 opened the activation
  // landing; otherwise show the account dashboard.
  if (query('installId') && query('requestId')) return 'activate'
  return 'account'
})
</script>

<template>
  <!-- Global, view-agnostic language switcher pinned to the top-right corner. -->
  <div class="lang-switch" role="group" :aria-label="t('lang.switcherLabel')">
    <button
      v-for="loc in SUPPORTED_LOCALES"
      :key="loc"
      type="button"
      class="lang-btn"
      :class="{ active: currentLocale === loc }"
      :aria-pressed="currentLocale === loc"
      @click="setLocale(loc as Locale)"
    >
      {{ t(`lang.${loc}`) }}
    </button>
  </div>

  <LoginView v-if="view === 'login'" />
  <ActivateView v-else-if="view === 'activate'" />
  <AgreementView v-else-if="view === 'agreement'" />
  <PlansView v-else-if="view === 'plans'" />
  <CheckoutView v-else-if="view === 'checkout'" />
  <AccountView v-else />
</template>

<style scoped>
.lang-switch {
  position: fixed;
  top: var(--sp-3);
  right: var(--sp-3);
  z-index: 10;
  display: inline-flex;
  gap: 1px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-pill);
  overflow: hidden;
  background: var(--c-card);
}
.lang-btn {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: var(--sp-1) var(--sp-3);
  cursor: pointer;
  line-height: var(--lh-tight);
}
.lang-btn:hover {
  color: var(--c-text);
}
.lang-btn.active {
  background: var(--c-primary);
  color: #fff;
}
</style>
