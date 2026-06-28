<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getJSON, formatPrice, type Plan, type PlanTier, type TierCapability } from '../lib/api'

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
    error.value = tierRes.error || planRes.error || '加载失败。'
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
    <h1>套餐对比 / Plans</h1>
    <p class="note"><a href="/checkout">购买 / Checkout →</a> · <a href="/account">账户中心 / Account →</a></p>
    <p v-if="loading" class="note">加载中…</p>
    <p v-else-if="error" class="error">{{ error }}</p>
    <template v-else>
      <table>
        <thead>
          <tr>
            <th>能力 / Capability</th>
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

      <h2>可购买套餐 / Purchasable plans</h2>
      <table v-if="plans.length">
        <thead>
          <tr>
            <th>套餐 / Plan</th>
            <th>层级 / Tier</th>
            <th>期限 / Term</th>
            <th>价格 / Price</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in plans" :key="p.planKey">
            <td>{{ p.name }}</td>
            <td>{{ p.tier }}</td>
            <td>{{ p.durationMonths }} months</td>
            <td>{{ formatPrice(p.priceCents, p.currency) }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </main>
</template>
