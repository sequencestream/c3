<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Plan {
  id: string
  name: string
  durationMonths: number
  priceCents: number
  currency: string
}

const plans = ref<Plan[]>([])

onMounted(async () => {
  try {
    const res = await fetch('/v1/plans')
    const data = (await res.json()) as { plans: Plan[] }
    plans.value = data.plans ?? []
  } catch {
    /* foundation: tolerate an unreachable API */
  }
})

function formatPrice(p: Plan): string {
  return `${(p.priceCents / 100).toFixed(2)} ${p.currency}`
}
</script>

<template>
  <main class="ls-shell">
    <h1>c3 license-server</h1>
    <p>License authority foundation is running.</p>
    <ul v-if="plans.length" class="ls-plans">
      <li v-for="p in plans" :key="p.id">{{ p.name }}: {{ formatPrice(p) }}</li>
    </ul>
  </main>
</template>
