<script setup lang="ts">
/*
 * SandboxConflictModal.vue — 沙箱冲突模态框。
 *
 * 当一个沙箱 run 绑定的 agent 是 system 模式(在 arapuca 沙箱内无法登录/认证)时,
 * 后端下发 sandbox_conflict_request 并阻塞该 run,等待用户决定:
 *   - bypass : 本次不走沙箱,在宿主上用原 system agent 运行
 *   - switch : 换成同 vendor 的 custom agent 并继续沙箱
 *   - cancel : 放弃本次 run
 * emit 用户决定,由 App 通过 WS 回传 sandbox_conflict_response。
 */
import { ref, watch } from 'vue'
import { useTypedI18n } from '@/i18n'
import type { SandboxConflictModel } from '@/controls/state'

const { t } = useTypedI18n()

const props = defineProps<{
  request: SandboxConflictModel | null
}>()

const emit = defineEmits<{
  bypass: []
  switch: [agentId: string]
  cancel: []
}>()

// The chosen switch target; defaults to the first same-vendor custom agent.
const selectedAgentId = ref<string>('')
watch(
  () => props.request,
  (req) => {
    selectedAgentId.value = req?.choices[0]?.id ?? ''
  },
  { immediate: true },
)

function onSwitch(): void {
  if (!selectedAgentId.value) return
  emit('switch', selectedAgentId.value)
}
</script>

<template>
  <div v-if="request" class="sc-overlay" data-testid="sandbox-conflict-overlay">
    <div class="sc-modal" role="dialog" aria-modal="true">
      <div class="sc-head">
        <h3>{{ t('sandboxConflict.title') }}</h3>
      </div>

      <p class="sc-body">
        {{ t('sandboxConflict.body', { agent: request.agentName }) }}
      </p>

      <!-- Switch to a same-vendor custom agent (only when one exists) -->
      <div v-if="request.choices.length > 0" class="sc-switch">
        <label class="sc-label" for="sandbox-conflict-agent-select">
          {{ t('sandboxConflict.switch.label') }}
        </label>
        <select
          id="sandbox-conflict-agent-select"
          v-model="selectedAgentId"
          class="sc-field"
          data-testid="sandbox-conflict-agent-select"
        >
          <option v-for="c in request.choices" :key="c.id" :value="c.id">
            {{ c.displayName || c.id }}
          </option>
        </select>
      </div>
      <p v-else class="sc-hint">{{ t('sandboxConflict.noCustom') }}</p>

      <div class="sc-foot">
        <button class="ghost" data-testid="sandbox-conflict-cancel" @click="emit('cancel')">
          {{ t('sandboxConflict.cancel.label') }}
        </button>
        <button data-testid="sandbox-conflict-bypass" @click="emit('bypass')">
          {{ t('sandboxConflict.bypass.label') }}
        </button>
        <button
          v-if="request.choices.length > 0"
          class="primary"
          data-testid="sandbox-conflict-switch"
          @click="onSwitch"
        >
          {{ t('sandboxConflict.switch.action') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sc-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.sc-modal {
  max-width: 520px;
  width: 90vw;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.sc-head {
  margin-bottom: var(--sp-3);
}
.sc-head h3 {
  margin: 0;
  font-size: var(--fs-body);
  font-weight: 600;
}
.sc-body {
  font-size: var(--fs-caption);
  color: var(--c-text);
  margin: 0 0 var(--sp-4);
  line-height: var(--lh-normal);
}
.sc-switch {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  margin-bottom: var(--sp-4);
}
.sc-label {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.sc-field {
  width: 100%;
}
.sc-hint {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  margin: 0 0 var(--sp-4);
  line-height: var(--lh-normal);
}
.sc-foot {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}

@media (max-width: 767px) {
  .sc-overlay {
    align-items: stretch;
    justify-content: stretch;
    background: var(--c-bg);
  }
  .sc-modal {
    width: 100vw;
    max-width: none;
    min-height: 100dvh;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    padding: calc(var(--sp-4) + env(safe-area-inset-top)) var(--sp-4)
      calc(var(--sp-4) + env(safe-area-inset-bottom));
  }
  .sc-foot {
    margin-top: auto;
    padding-top: var(--sp-4);
  }
}
</style>
