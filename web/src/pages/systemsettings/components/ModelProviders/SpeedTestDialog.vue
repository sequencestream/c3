<script setup lang="ts">
/*
 * SpeedTestDialog.vue — 模型提供方「测速」对话框。
 *
 * 与旁边的连通性探测是两件事:探测是一次裸 GET,证明端点会应答;测速是真实的流式生成,
 * 花的是用户的额度与 token,还可能撞上游限流。所以这里先把代价说清楚,再让用户确认。
 *
 * 一切候选都取自**已提交**的配置快照,不是当前草稿:服务端只按已保存的 provider 拨号,
 * 拿草稿当候选只会让用户选到一个服务端根本不认的目标。有未保存修改时就地说明这一点,
 * 但绝不替用户保存草稿。
 *
 * 执行归服务端持有:关掉这个对话框不会停掉在跑的轮次,重新打开时问一次 active 复原进度;
 * 只有显式「中断」才停止上游调用。对话框自己不计时、不算任何指标——汇总是服务端按文档
 * 公式算好的,这里只负责舍入与把 null 显示成「不可用」。
 */
import { computed, ref, watch } from 'vue'
import type { ModelProvider, ProtocolType, SpeedTestErrorCode } from '@ccc/shared/protocol'
import {
  SPEED_TEST_DEFAULT_REQUESTS,
  SPEED_TEST_MAX_OUTPUT_TOKENS,
  SPEED_TEST_MAX_REQUESTS,
  SPEED_TEST_MIN_REQUESTS,
  SPEED_TEST_PROMPT,
} from '@ccc/shared/protocol'
import { checkProviderBaseUrl, effectiveProviderModels } from '@ccc/shared'
import { useTypedI18n } from '@/i18n'
import {
  pendingSaveRun,
  SPEED_TEST_ERROR_KEYS,
  type SpeedTestUiState,
} from '@/lib/model-provider-speed-test'
import SpeedTestSummaryView from './SpeedTestSummary.vue'

const { t } = useTypedI18n()

const props = defineProps<{
  /** 已提交快照里的这条 provider;缺失=服务端还不认识它(新建未保存)。 */
  provider: ModelProvider | null
  /** 草稿里同一条 provider,仅用于判断「有未保存修改」。 */
  draft: ModelProvider | null
  state: SpeedTestUiState
}>()

const emit = defineEmits<{
  start: [payload: { protocolType: ProtocolType; model: string; requestCount: number }]
  interrupt: [runId: string]
  retrySave: [runId: string]
  close: []
}>()

const PROTOCOL_LABEL: Record<ProtocolType, string> = { openai: 'OpenAI', anthropic: 'Anthropic' }

// ---- 候选(全部来自已提交快照) ----

/** 已保存 urls 里去空白后非空的槽,按 OpenAI、Anthropic 排序。 */
const protocols = computed<ProtocolType[]>(() => {
  const p = props.provider
  if (!p) return []
  return (['openai', 'anthropic'] as ProtocolType[]).filter((slot) => p.urls[slot]?.trim())
})

/** 厂商内置 + 自有条目合并后的目录;仅作手输控件的预设候选。 */
const models = computed(() => (props.provider ? effectiveProviderModels(props.provider) : []))

const protocol = ref<ProtocolType>('openai')
const model = ref('')
const count = ref<number | string>(SPEED_TEST_DEFAULT_REQUESTS)

// 打开(或换了 provider)时重置:单槽自动选中,双槽默认 OpenAI;模型默认留空。
watch(
  () => props.provider?.id,
  () => {
    protocol.value = protocols.value[0] ?? 'openai'
    model.value = ''
    count.value = SPEED_TEST_DEFAULT_REQUESTS
  },
  { immediate: true },
)

/** 该 provider 的 openai 槽实际讲哪种方言;anthropic 槽恒为 Messages。 */
const dialectLabel = computed(() => {
  if (protocol.value === 'anthropic') return t('settings.providers.speedTest.dialect.messages')
  return props.provider?.wireApi === 'responses'
    ? t('settings.providers.speedTest.dialect.responses')
    : t('settings.providers.speedTest.dialect.chat')
})

// ---- 校验 ----

/** 所选槽的 URL 结构性错误(warning 不阻断,与保存时的口径一致)。 */
const urlBroken = computed(() => {
  const url = props.provider?.urls[protocol.value]?.trim()
  if (!url) return false
  return checkProviderBaseUrl(url).severity === 'error'
})

/** 请求数的本地校验。整数、1–100;空、0、负数、小数、非数字一律具名拒绝。 */
const countError = computed<string | null>(() => {
  const raw = typeof count.value === 'string' ? count.value.trim() : count.value
  if (raw === '') return t('settings.providers.speedTest.count.error.empty')
  const n = Number(raw)
  if (!Number.isFinite(n)) return t('settings.providers.speedTest.count.error.notANumber')
  if (!Number.isInteger(n)) return t('settings.providers.speedTest.count.error.notAnInteger')
  if (n < SPEED_TEST_MIN_REQUESTS || n > SPEED_TEST_MAX_REQUESTS) {
    return t('settings.providers.speedTest.count.error.range', {
      min: SPEED_TEST_MIN_REQUESTS,
      max: SPEED_TEST_MAX_REQUESTS,
    })
  }
  return null
})

/**
 * 选中的槽已经从已提交快照里消失了。
 *
 * 对话框开着时配置在别处被改过(另一个标签页、另一位管理员保存)才会发生。这时既不
 * 静默改选到另一个槽——那会让用户量到一个自己没选的端点——也不放任「开始」发出去,
 * 因为它必然被服务端以 protocol_unavailable 挡回;留着按钮等于
 * 留一个必定失败的动作。就地说明并请用户刷新重选,与保存时拒绝重选的口径一致。
 */
const protocolGone = computed(
  () => protocols.value.length > 0 && !protocols.value.includes(protocol.value),
)

/** 阻断开始的原因,按严重度排序;null=可以开始。 */
const blocker = computed<string | null>(() => {
  if (!props.provider) return t('settings.providers.speedTest.blocked.unsaved')
  if (protocols.value.length === 0) return t('settings.providers.speedTest.blocked.noProtocol')
  if (urlBroken.value) return t('settings.providers.speedTest.blocked.invalidUrl')
  if (protocolGone.value) return t('settings.providers.speedTest.error.protocolUnavailable')
  return countError.value
})

/** 草稿与已提交快照不一致时,说明本次用的是已保存的那份。 */
const draftDiffers = computed(() => {
  if (!props.provider || !props.draft) return false
  return JSON.stringify(props.draft) !== JSON.stringify(props.provider)
})

// ---- 运行态 ----

const active = computed(() => props.state.active)
const running = computed(() => active.value !== null && active.value.state === 'running')
/**
 * 已跑完但没提交的那一轮。取自 active 快照,所以关掉对话框、刷新页面后重新问一次
 * active 就能重新拿到——「重试保存」不会因为那一帧没被看见而消失。
 */
const pendingSave = computed(() => pendingSaveRun(props.state))
const progressText = computed(() =>
  active.value
    ? t('settings.providers.speedTest.progress.text', {
        done: active.value.completedCount,
        total: active.value.plannedCount,
      })
    : '',
)

/** 服务端拒绝原因的本地化;每条都指出下一步做什么。文案表与对比视图共用一份。 */
function errorText(code: SpeedTestErrorCode): string {
  return t(SPEED_TEST_ERROR_KEYS[code])
}

function onStart(): void {
  if (blocker.value) return
  emit('start', {
    protocolType: protocol.value,
    model: model.value,
    requestCount: Number(count.value),
  })
}
</script>

<template>
  <div class="st-overlay" data-testid="speed-test-overlay" @click.self="emit('close')">
    <div class="st-modal" role="dialog" aria-modal="true">
      <h3 class="st-title">
        {{ t('settings.providers.speedTest.title', { name: provider?.displayName ?? '' }) }}
      </h3>

      <!-- 代价先讲清楚:真实调用、消耗额度与 token、可能触发限流。 -->
      <p class="st-cost" data-testid="speed-test-cost">
        {{ t('settings.providers.speedTest.cost') }}
      </p>
      <p v-if="draftDiffers" class="st-note" data-testid="speed-test-draft-note">
        {{ t('settings.providers.speedTest.draftNote') }}
      </p>

      <div class="st-form">
        <label class="st-field">
          <span class="st-label">{{ t('settings.providers.speedTest.protocol.label') }}</span>
          <select
            v-model="protocol"
            class="agent-field"
            :disabled="running || protocols.length === 0"
            data-testid="speed-test-protocol"
          >
            <option v-for="slot in protocols" :key="slot" :value="slot">
              {{ PROTOCOL_LABEL[slot] }}
            </option>
          </select>
          <span class="st-dialect" data-testid="speed-test-dialect">{{ dialectLabel }}</span>
        </label>

        <label class="st-field">
          <span class="st-label">{{ t('settings.providers.speedTest.model.label') }}</span>
          <input
            v-model="model"
            class="agent-field"
            type="text"
            list="speed-test-model-options"
            :disabled="running"
            data-testid="speed-test-model"
          />
          <datalist id="speed-test-model-options">
            <option v-for="m in models" :key="m.id" :value="m.id" />
          </datalist>
        </label>
        <p v-if="model.trim() === ''" class="st-model-note" data-testid="speed-test-model-note">
          {{ t('settings.providers.speedTest.model.emptyHint') }}
        </p>

        <label class="st-field">
          <span class="st-label">{{ t('settings.providers.speedTest.count.label') }}</span>
          <input
            v-model="count"
            class="agent-field st-count"
            type="number"
            :min="SPEED_TEST_MIN_REQUESTS"
            :max="SPEED_TEST_MAX_REQUESTS"
            :disabled="running"
            data-testid="speed-test-count"
          />
        </label>
      </div>

      <!-- 标定报文只读展示:它不可编辑,正是两轮之间可比的前提。 -->
      <p class="st-calibration" data-testid="speed-test-calibration">
        {{
          t('settings.providers.speedTest.calibration', {
            prompt: SPEED_TEST_PROMPT,
            maxTokens: SPEED_TEST_MAX_OUTPUT_TOKENS,
          })
        }}
      </p>

      <p v-if="blocker" class="st-blocker" data-testid="speed-test-blocker">{{ blocker }}</p>
      <p v-if="state.error" class="st-blocker" data-testid="speed-test-error">
        {{ errorText(state.error) }}
      </p>

      <div v-if="active" class="st-progress" data-testid="speed-test-progress">
        <span>{{ progressText }}</span>
        <span class="st-progress-detail">{{
          t('settings.providers.speedTest.progress.detail', {
            ok: active.successCount,
            failed: active.failureCount,
          })
        }}</span>
      </div>

      <!-- 已跑完但没存下:结果留在服务端内存里,给一条明确的重试路径,不静默丢弃。 -->
      <div v-if="pendingSave" class="st-unsaved" data-testid="speed-test-unsaved">
        <span>{{ t('settings.providers.speedTest.unsaved') }}</span>
        <button
          class="ghost"
          data-testid="speed-test-retry-save"
          @click="emit('retrySave', pendingSave.runId)"
        >
          {{ t('settings.providers.speedTest.retrySave.label') }}
        </button>
      </div>

      <SpeedTestSummaryView
        v-if="state.lastResult"
        :detail="state.lastResult"
        data-testid="speed-test-result"
      />

      <div class="st-foot">
        <button class="st-cancel" data-testid="speed-test-close" @click="emit('close')">
          {{ t('common.action.close.label') }}
        </button>
        <button
          v-if="running && active"
          class="st-interrupt"
          data-testid="speed-test-interrupt"
          @click="emit('interrupt', active.runId)"
        >
          {{ t('settings.providers.speedTest.interrupt.label') }}
        </button>
        <!--
          待提交的轮次占着这条提供方:服务端只会以 busy 拒绝新的开始,而「重试保存」
          就在上面一行。所以这里不给一个必定失败的按钮,也不让「开始」把注意力从真正
          该做的动作上引开。
        -->
        <button
          v-else-if="!pendingSave"
          class="st-confirm"
          :disabled="blocker !== null"
          data-testid="speed-test-start"
          @click="onStart"
        >
          {{ t('settings.providers.speedTest.start.label') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.st-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.st-modal {
  max-width: 560px;
  width: 92vw;
  max-height: 88vh;
  overflow-y: auto;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.st-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-body);
  font-weight: 600;
}
.st-cost {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-caption);
  color: var(--c-warning-text);
  line-height: var(--lh-normal);
}
.st-note,
.st-model-note,
.st-calibration {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  line-height: var(--lh-normal);
  word-break: break-word;
}
.st-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.st-field {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.st-label {
  flex: 0 0 96px;
  font-size: var(--fs-caption);
}
.st-field > .agent-field {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}
.st-count {
  flex: 0 0 120px;
}
.st-dialect {
  flex: 0 0 auto;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  white-space: nowrap;
}
.st-blocker {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-caption);
  color: var(--c-error-text);
}
.st-progress {
  display: flex;
  align-items: baseline;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
  font-size: var(--fs-caption);
}
.st-progress-detail {
  color: var(--c-text-muted);
}
.st-unsaved {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
  font-size: var(--fs-caption);
  color: var(--c-error-text);
}
.st-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}
.st-cancel {
  background: transparent;
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
}
.st-interrupt {
  background: var(--c-warning-text);
  border: 1px solid var(--c-warning-text);
  color: #fff;
}

@media (max-width: 767px) {
  .st-overlay {
    align-items: stretch;
    justify-content: stretch;
    background: var(--c-bg);
  }
  .st-modal {
    width: 100vw;
    max-width: none;
    min-height: 100dvh;
    max-height: none;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
}
</style>
