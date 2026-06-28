<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getJSON, formatPrice, type Plan, type PlanTier, type TierCapability } from '../lib/api'
import { useTypedI18n } from '../i18n'

const { t } = useTypedI18n()

const loading = ref(true)
const error = ref('')
const tiers = ref<PlanTier[]>([])
const capabilities = ref<TierCapability[]>([])
const plans = ref<Plan[]>([])

onMounted(async () => {
  const [tierRes, planRes] = await Promise.all([
    getJSON<{ tiers: PlanTier[]; capabilities: TierCapability[] }>('/v1/plan-tiers'),
    getJSON<{ plans: Plan[] }>('/v1/plans'),
  ])
  if (!tierRes.ok || !planRes.ok) {
    error.value = tierRes.error || planRes.error || t('common.errorLoadFailed')
  } else {
    tiers.value = tierRes.data?.tiers ?? []
    capabilities.value = tierRes.data?.capabilities ?? []
    plans.value = planRes.data?.plans ?? []
  }
  loading.value = false
})
</script>

<template>
  <main class="ls-card wide">
    <h1>{{ t('plans.title') }}</h1>
    <p class="note"><a href="/checkout">{{ t('plans.linkCheckout') }}</a> · <a href="/account">{{ t('plans.linkAccount') }}</a></p>
    <p v-if="loading" class="note">{{ t('common.loading') }}</p>
    <p v-else-if="error" class="error">{{ error }}</p>
    <template v-else>
      <table>
        <thead>
          <tr>
            <th>{{ t('plans.capability') }}</th>
            <th v-for="tier in tiers" :key="tier.tier">{{ tier.name }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in capabilities" :key="row.label">
            <td>{{ row.label }}</td>
            <td>{{ row.free }}</td>
            <td>{{ row.paid }}</td>
            <td>{{ row.enterprise }}</td>
          </tr>
        </tbody>
      </table>

      <h2>{{ t('plans.purchasable') }}</h2>
      <table v-if="plans.length">
        <thead>
          <tr>
            <th>{{ t('plans.plan') }}</th>
            <th>{{ t('plans.tier') }}</th>
            <th>{{ t('plans.term') }}</th>
            <th>{{ t('plans.price') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in plans" :key="p.planKey">
            <td>{{ p.name }}</td>
            <td>{{ p.tier }}</td>
            <td>{{ t('plans.months', { count: p.durationMonths }) }}</td>
            <td>{{ formatPrice(p.priceCents, p.currency) }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </main>
</template>
