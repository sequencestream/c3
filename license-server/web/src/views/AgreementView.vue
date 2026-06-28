<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getJSON } from '../lib/api'
import { useTypedI18n } from '../i18n'

const { t } = useTypedI18n()

interface Agreement {
  title: string
  version: string
  markdown: string
}

interface AgreementBlock {
  kind: 'heading' | 'paragraph' | 'item'
  text: string
}

const agreement = ref<Agreement | null>(null)
const error = ref('')

const blocks = computed<AgreementBlock[]>(() => {
  if (!agreement.value) return []
  return agreement.value.markdown.split('\n').flatMap((line): AgreementBlock[] => {
    if (line.startsWith('# ' ) || line === '') return []
    if (line.startsWith('## ')) return [{ kind: 'heading', text: line.slice(3) }]
    if (/^\d+\.\s+/.test(line)) return [{ kind: 'item', text: line }]
    return [{ kind: 'paragraph', text: line }]
  })
})

onMounted(async () => {
  const res = await getJSON<Agreement>('/v1/agreement')
  if (!res.ok || !res.data) {
    error.value = res.error || t('agreement.errorLoadFailed')
    return
  }
  agreement.value = res.data
  document.title = agreement.value.title
})
</script>

<template>
  <main class="ls-card agreement-page">
    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="!agreement" class="note">{{ t('common.loading') }}</p>
    <template v-else>
      <h1>{{ agreement.title }}</h1>
      <p class="note">{{ t('agreement.version', { version: agreement.version }) }}</p>
      <article class="agreement-body">
        <template v-for="(block, index) in blocks" :key="index">
          <h2 v-if="block.kind === 'heading'">{{ block.text }}</h2>
          <p v-else-if="block.kind === 'item'" class="agreement-item">{{ block.text }}</p>
          <p v-else>{{ block.text }}</p>
        </template>
      </article>
    </template>
  </main>
</template>
