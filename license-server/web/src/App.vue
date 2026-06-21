<script setup lang="ts">
import { computed } from 'vue'
import { query } from './lib/api'
import LoginView from './views/LoginView.vue'
import ActivateView from './views/ActivateView.vue'
import CheckoutView from './views/CheckoutView.vue'
import AccountView from './views/AccountView.vue'
import AgreementView from './views/AgreementView.vue'

// Minimal path-based router (all pages are this SPA, served at /). The flows are
// full-page (OAuth redirect, form POST), so reading the path at load is enough;
// no client-side history navigation is needed.
const view = computed(() => {
  const path = window.location.pathname
  if (path.startsWith('/login')) return 'login'
  if (path.startsWith('/agreement')) return 'agreement'
  if (path.startsWith('/checkout')) return 'checkout'
  if (path.startsWith('/account')) return 'account'
  // Root: the binding round (installId+requestId) means c3 opened the activation
  // landing; otherwise show the account dashboard.
  if (query('installId') && query('requestId')) return 'activate'
  return 'account'
})
</script>

<template>
  <LoginView v-if="view === 'login'" />
  <ActivateView v-else-if="view === 'activate'" />
  <AgreementView v-else-if="view === 'agreement'" />
  <CheckoutView v-else-if="view === 'checkout'" />
  <AccountView v-else />
</template>
