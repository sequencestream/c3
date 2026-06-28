<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  getJSON,
  formatPrice,
  formatDate,
  loginHref,
  statusBadgeClass,
  tierLabel,
  type License,
  type Order,
} from '../lib/api'
import { useTypedI18n } from '../i18n'

const { t } = useTypedI18n()

// User self-service (§10): the signed-in user's licenses (with binding info)
// and paid orders. Never shows the alive token or entitlement token (PL-R2).
const loading = ref(true)
const error = ref('')
const licenses = ref<License[]>([])
const orders = ref<Order[]>([])

onMounted(async () => {
  const sess = await getJSON<{ signedIn: boolean }>('/v1/session')
  if (!sess.data?.signedIn) {
    window.location.href = loginHref()
    return
  }
  const [l, o] = await Promise.all([
    getJSON<{ licenses: License[] }>('/v1/licenses'),
    getJSON<{ orders: Order[] }>('/v1/orders'),
  ])
  if (!l.ok || !o.ok) {
    error.value = l.error || o.error || t('common.errorLoadFailed')
  } else {
    licenses.value = l.data?.licenses ?? []
    orders.value = o.data?.orders ?? []
  }
  loading.value = false
})
</script>

<template>
  <main class="ls-card wide">
    <h1>{{ t('account.title') }}</h1>
    <p class="note"><a href="/checkout">{{ t('account.linkRenew') }}</a> · <a href="/plans">{{ t('account.linkCompare') }}</a></p>
    <p v-if="loading" class="note">{{ t('common.loading') }}</p>
    <p v-else-if="error" class="error">{{ error }}</p>

    <template v-else>
      <h2>{{ t('account.myLicenses') }}</h2>
      <table v-if="licenses.length">
        <thead>
          <tr>
            <th>{{ t('account.licenseKey') }}</th>
            <th>{{ t('common.status') }}</th>
            <th>{{ t('common.tier') }}</th>
            <th>{{ t('account.validUntil') }}</th>
            <th>{{ t('account.currentBinding') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in licenses" :key="l.licenseKey">
            <td>
              <code class="key">{{ l.licenseKey }}</code>
            </td>
            <td><span :class="statusBadgeClass(l.status)">{{ l.status }}</span></td>
            <td>{{ tierLabel(l.tier) }}</td>
            <td>{{ formatDate(l.termEnd) }}</td>
            <td>{{ l.aliveInstallId || t('account.notBound') }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="note">{{ t('account.noLicenses') }}</p>

      <h2>{{ t('account.paidOrders') }}</h2>
      <table v-if="orders.length">
        <thead>
          <tr>
            <th>{{ t('account.orderNo') }}</th>
            <th>{{ t('account.plan') }}</th>
            <th>{{ t('account.amount') }}</th>
            <th>{{ t('common.status') }}</th>
            <th>{{ t('account.time') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="o in orders" :key="o.orderNo">
            <td>
              <code class="key">{{ o.orderNo }}</code>
            </td>
            <td>{{ o.planKey }}</td>
            <td>{{ formatPrice(o.amountCents, o.currency) }}</td>
            <td><span :class="statusBadgeClass(o.status)">{{ o.status }}</span></td>
            <td>{{ formatDate(o.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="note">{{ t('account.noOrders') }}</p>
    </template>
  </main>
</template>
