<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getJSON, formatPrice, formatDate, loginHref, type License, type Order } from '../lib/api'

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
    error.value = l.error || o.error || '加载失败。'
  } else {
    licenses.value = l.data?.licenses ?? []
    orders.value = o.data?.orders ?? []
  }
  loading.value = false
})
</script>

<template>
  <main class="ls-card wide">
    <h1>账户中心 / Account</h1>
    <p class="note"><a href="/checkout">续费 / Renew a license →</a></p>
    <p v-if="loading" class="note">加载中…</p>
    <p v-else-if="error" class="error">{{ error }}</p>

    <template v-else>
      <h2>我的 License</h2>
      <table v-if="licenses.length">
        <thead>
          <tr><th>License Key</th><th>套餐</th><th>状态</th><th>有效至</th><th>当前绑定</th></tr>
        </thead>
        <tbody>
          <tr v-for="l in licenses" :key="l.licenseKey">
            <td><code class="key">{{ l.licenseKey }}</code></td>
            <td>{{ l.planKey }}</td>
            <td>{{ l.status }}</td>
            <td>{{ formatDate(l.termEnd) }}</td>
            <td>{{ l.aliveInstallId || '未绑定' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="note">暂无 license。</p>

      <h2>已支付订单</h2>
      <table v-if="orders.length">
        <thead>
          <tr><th>订单号</th><th>套餐</th><th>金额</th><th>状态</th><th>时间</th></tr>
        </thead>
        <tbody>
          <tr v-for="o in orders" :key="o.orderNo">
            <td><code class="key">{{ o.orderNo }}</code></td>
            <td>{{ o.planKey }}</td>
            <td>{{ formatPrice(o.amountCents, o.currency) }}</td>
            <td>{{ o.status }}</td>
            <td>{{ formatDate(o.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="note">暂无订单。</p>
    </template>
  </main>
</template>
