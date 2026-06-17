<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getJSON, postJSON, formatPrice, formatDate, loginHref, type Plan, type License } from '../lib/api'

// Renewal checkout (§4): the agreement is shown HERE (not at sign-in). On submit
// the server derives the amount from the plan and returns a WeChat Native QR.
interface Agreement {
  title: string
  version: string
  markdown: string
}

const loading = ref(true)
const error = ref('')
const plans = ref<Plan[]>([])
const licenses = ref<License[]>([])
const agreement = ref<Agreement | null>(null)
const planKey = ref('')
const licenseId = ref<number | null>(null)
const accept = ref(false)
const submitting = ref(false)
const qrDataUri = ref('')
const orderNo = ref('')

onMounted(async () => {
  const sess = await getJSON<{ signedIn: boolean }>('/v1/session')
  if (!sess.data?.signedIn) {
    window.location.href = loginHref()
    return
  }
  const [p, l, a] = await Promise.all([
    getJSON<{ plans: Plan[] }>('/v1/plans'),
    getJSON<{ licenses: License[] }>('/v1/licenses'),
    getJSON<Agreement>('/v1/agreement'),
  ])
  plans.value = p.data?.plans ?? []
  licenses.value = l.data?.licenses ?? []
  agreement.value = a.data
  if (plans.value.length) planKey.value = plans.value[0].planKey
  if (licenses.value.length) licenseId.value = licenses.value[0].licenseId
  loading.value = false
})

async function submit(): Promise<void> {
  error.value = ''
  if (!accept.value) {
    error.value = '请先同意服务协议。'
    return
  }
  submitting.value = true
  const res = await postJSON<{ orderNo: string; codeUrl?: string; qrDataUri?: string }>('/v1/checkout', {
    planKey: planKey.value,
    licenseId: licenseId.value,
    accept: accept.value,
  })
  submitting.value = false
  if (!res.ok || !res.data) {
    error.value = res.error || '下单失败。'
    return
  }
  orderNo.value = res.data.orderNo
  qrDataUri.value = res.data.qrDataUri ?? ''
}
</script>

<template>
  <main class="ls-card">
    <h1>续费 / Renew</h1>
    <p v-if="loading" class="note">加载中…</p>
    <p v-else-if="error" class="error">{{ error }}</p>

    <template v-if="!loading && qrDataUri">
      <p class="ok">订单已创建(订单号 {{ orderNo }})。请用微信扫码支付:</p>
      <img class="qr" :src="qrDataUri" alt="WeChat Pay QR" width="256" height="256" />
      <p class="note">支付确认后将延长所选 license 的有效期。二维码 15 分钟内有效。</p>
    </template>

    <template v-else-if="!loading">
      <h2>选择套餐</h2>
      <label v-for="p in plans" :key="p.planKey" class="opt">
        <input type="radio" name="plan" :value="p.planKey" v-model="planKey" />
        <span>{{ p.name }}</span><span class="price">{{ formatPrice(p.priceCents, p.currency) }}</span>
      </label>
      <p v-if="!plans.length" class="note">暂无可购买套餐。</p>

      <h2>续期目标 license</h2>
      <label v-for="l in licenses" :key="l.licenseId" class="opt">
        <input type="radio" name="lic" :value="l.licenseId" v-model="licenseId" />
        <code class="key">{{ l.licenseKey }}</code><span class="price">{{ formatDate(l.termEnd) }}</span>
      </label>
      <p v-if="!licenses.length" class="note">此账号暂无可续期 license。</p>

      <label class="agree">
        <input type="checkbox" v-model="accept" />
        <span>我已阅读并同意《{{ agreement?.title }}》（含无退款条款,版本 {{ agreement?.version }}）。</span>
      </label>
      <button :disabled="submitting || !accept || !planKey || licenseId === null" @click="submit">
        {{ submitting ? '提交中…' : '下单 / Place order' }}
      </button>
    </template>
  </main>
</template>
