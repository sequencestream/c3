<script setup lang="ts">
import { onMounted, ref } from 'vue'
import {
  getJSON,
  postJSON,
  query,
  formatDate,
  loginHref,
  statusBadgeClass,
  type License,
} from '../lib/api'
import { useTypedI18n } from '../i18n'

const { t } = useTypedI18n()

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
    error.value = t('activate.errorMissingParams')
    loading.value = false
    return
  }
  const res = await getJSON<{ licenses: License[]; autoBound?: boolean }>(
    `/v1/license/activate?installId=${encodeURIComponent(installId)}&requestId=${encodeURIComponent(requestId)}`,
  )
  if (res.status === 401) {
    window.location.href = loginHref()
    return
  }
  if (!res.ok || !res.data) {
    error.value = res.error || t('activate.errorLoadFailed')
  } else {
    licenses.value = res.data.licenses
    // A sole long-lived license is bound server-side (§4); skip the picker and go
    // straight to success — c3 collects the result via checkbind. Re-binding here
    // would rotate the alive token and break the just-activated c3 heartbeat.
    if (res.data.autoBound) bound.value = true
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
    error.value = res.error || t('activate.errorBindFailed')
    return
  }
  bound.value = true
}
</script>

<template>
  <main class="ls-card">
    <h1>{{ t('activate.title') }}</h1>
    <p v-if="loading" class="note">{{ t('common.loading') }}</p>
    <p v-else-if="error" class="error">{{ error }}</p>

    <template v-else-if="bound">
      <p class="ok">{{ t('activate.boundSuccess') }}</p>
    </template>

    <template v-else>
      <p class="note">
        <i18n-t keypath="activate.pickPrompt" tag="span">
          <template #installId><code>{{ installId }}</code></template>
        </i18n-t>
      </p>
      <ul class="ls-list">
        <li v-for="l in licenses" :key="l.licenseKey" class="row">
          <div>
            <code class="key">{{ l.licenseKey }}</code>
            <div class="meta">
              <span :class="statusBadgeClass(l.status)">{{ l.status }}</span> · {{ t('activate.validUntil') }}
              {{ formatDate(l.termEnd) }}
            </div>
          </div>
          <button :disabled="binding !== ''" @click="bind(l.licenseKey)">
            {{ binding === l.licenseKey ? t('activate.binding') : t('activate.bind') }}
          </button>
        </li>
      </ul>
      <p v-if="!licenses.length" class="note">{{ t('activate.noLicenses') }}</p>
    </template>
  </main>
</template>
