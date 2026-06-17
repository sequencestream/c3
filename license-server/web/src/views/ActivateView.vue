<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { getJSON, postJSON, query, formatDate, loginHref, type License } from '../lib/api'

// The browser-mediated binding landing (§4): c3 server opened this page with
// installId + requestId. We list the signed-in user's licenses; selecting one
// binds it, and c3 server collects the result via checkbind.
const installId = query('installId')
const requestId = query('requestId')

const loading = ref(true)
const error = ref('')
const licenses = ref<License[]>([])
const bound = ref(false)
const binding = ref('')

onMounted(async () => {
  if (!installId || !requestId) {
    error.value = '请从 c3 客户端发起激活(缺少 installId/requestId)。'
    loading.value = false
    return
  }
  const res = await getJSON<{ licenses: License[] }>(
    `/v1/license/activate?installId=${encodeURIComponent(installId)}&requestId=${encodeURIComponent(requestId)}`,
  )
  if (res.status === 401) {
    window.location.href = loginHref()
    return
  }
  if (!res.ok || !res.data) {
    error.value = res.error || '加载 license 失败。'
  } else {
    licenses.value = res.data.licenses
  }
  loading.value = false
})

async function bind(licenseKey: string): Promise<void> {
  binding.value = licenseKey
  error.value = ''
  const res = await postJSON<{ status: string }>('/v1/license/bind', {
    installId,
    requestId,
    licenseKey,
  })
  binding.value = ''
  if (!res.ok) {
    error.value = res.error || '绑定失败。'
    return
  }
  bound.value = true
}
</script>

<template>
  <main class="ls-card">
    <h1>激活 / Activate</h1>
    <p v-if="loading" class="note">加载中…</p>
    <p v-else-if="error" class="error">{{ error }}</p>

    <template v-else-if="bound">
      <p class="ok">✓ 绑定成功。可返回 c3 继续使用,本页可关闭。</p>
    </template>

    <template v-else>
      <p class="note">选择一条 license 绑定到本安装(installId <code>{{ installId }}</code>)。</p>
      <ul class="ls-list">
        <li v-for="l in licenses" :key="l.licenseKey" class="row">
          <div>
            <code class="key">{{ l.licenseKey }}</code>
            <div class="meta">{{ l.planKey }} · {{ l.status }} · 有效至 {{ formatDate(l.termEnd) }}</div>
          </div>
          <button :disabled="binding !== ''" @click="bind(l.licenseKey)">
            {{ binding === l.licenseKey ? '绑定中…' : '绑定' }}
          </button>
        </li>
      </ul>
      <p v-if="!licenses.length" class="note">此账号暂无 license。</p>
    </template>
  </main>
</template>
