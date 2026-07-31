<script setup lang="ts">
/*
 * Queue.vue — 自动化队列页(意图页内的独立视图)。
 *
 * 逐条回答「这条意图现在为什么不动」:阻塞原因、下次唤醒时间、最近一次内核决策,
 * 以及失败/退避/park 摘要。纯展示 + 上抛意图,不持有任何队列状态——数据来自服务端
 * 每轮对账后推送的 queue_detail 投影,人工动作也原样发回服务端由内核校验。
 *
 * 每个按钮对应且仅对应一个内核动作(宪法第 3 条:机器能做的人必须也能做):
 *   暂停/恢复 → 队列级控制;强制跳过/取消跳过、解除 park、覆盖结论(继续/停止)→ 单意图。
 * 客户端不预测结果:被服务端拒绝的动作走统一错误弹框,不会看起来像成功。
 */
import { computed } from 'vue'
import { useTypedI18n } from '@/i18n'
import type { QueueControlAction, QueueDetail, QueueIntentDetail } from '@ccc/shared/protocol'

const { t } = useTypedI18n()

const props = defineProps<{
  detail: QueueDetail | null
}>()

const emit = defineEmits<{
  (e: 'control', action: QueueControlAction, intentId?: string): void
  (e: 'refresh'): void
  (e: 'close'): void
  (e: 'select-intent', intentId: string): void
}>()

const items = computed<QueueIntentDetail[]>(() => props.detail?.items ?? [])
const paused = computed(() => props.detail?.state === 'paused')
const isEmpty = computed(() => items.value.length === 0)

/** Localized label for a structured reason code, falling back to the raw code. */
function reasonLabel(code: string): string {
  if (!code) return t('queue.reason.none')
  const key = `queue.reason.${code}` as Parameters<typeof t>[0]
  const label = t(key)
  return label === key ? code : label
}

function actionLabel(action: string): string {
  if (!action) return '—'
  const key = `queue.action.${action}` as Parameters<typeof t>[0]
  const label = t(key)
  return label === key ? action : label
}

/** Absolute wall-clock for a wake-up; em dash when it is just the next tick. */
function whenLabel(at: number | null): string {
  if (at === null) return t('queue.nextWakeup.nextTick')
  return new Date(at).toLocaleTimeString()
}

function timeLabel(at: number | null): string {
  return at === null ? '—' : new Date(at).toLocaleString()
}
</script>

<template>
  <section class="queue-page" data-testid="queue-page">
    <header class="queue-head">
      <button type="button" class="queue-back" data-testid="queue-back" @click="emit('close')">
        ‹ {{ t('queue.back') }}
      </button>
      <h2 class="queue-title">{{ t('queue.title') }}</h2>
      <span class="queue-state" :class="`queue-state-${detail?.state ?? 'idle'}`">
        {{ t(`queue.state.${detail?.state ?? 'idle'}` as never) }}
      </span>
      <span class="queue-wake">
        {{ t('queue.nextWakeup.label') }}: {{ whenLabel(detail?.nextWakeupAt ?? null) }}
      </span>
      <div class="queue-head-actions">
        <button
          type="button"
          class="queue-btn"
          data-testid="queue-pause"
          @click="emit('control', paused ? 'resume' : 'pause')"
        >
          {{ paused ? t('queue.control.resume') : t('queue.control.pause') }}
        </button>
        <button
          type="button"
          class="queue-btn"
          data-testid="queue-refresh"
          @click="emit('refresh')"
        >
          {{ t('queue.refresh') }}
        </button>
      </div>
    </header>

    <p v-if="isEmpty" class="queue-hint" data-testid="queue-empty">{{ t('queue.empty') }}</p>

    <ul v-else class="queue-list">
      <li v-for="item in items" :key="item.intentId" class="queue-row" data-testid="queue-row">
        <div class="queue-row-main">
          <button
            type="button"
            class="queue-row-title"
            @click="emit('select-intent', item.intentId)"
          >
            {{ item.title }}
          </button>
          <span class="queue-badge">{{ item.priority }}</span>
          <span v-if="item.parked" class="queue-badge queue-badge-parked">
            {{ t('queue.badge.parked') }}
          </span>
          <span v-if="item.forceSkipped" class="queue-badge queue-badge-skipped">
            {{ t('queue.badge.skipped') }}
          </span>
        </div>

        <dl class="queue-facts">
          <div class="queue-fact">
            <dt>{{ t('queue.field.blocked') }}</dt>
            <dd data-testid="queue-blocked">
              {{ reasonLabel(item.blockedReason) }}
              <span v-if="item.blockedDetail" class="queue-detail">— {{ item.blockedDetail }}</span>
            </dd>
          </div>
          <div class="queue-fact">
            <dt>{{ t('queue.field.nextWakeup') }}</dt>
            <dd data-testid="queue-wakeup">{{ whenLabel(item.nextWakeupAt) }}</dd>
          </div>
          <div class="queue-fact">
            <dt>{{ t('queue.field.lastDecision') }}</dt>
            <dd data-testid="queue-last-decision">
              {{ actionLabel(item.lastAction) }}
              <span class="queue-detail">({{ timeLabel(item.lastDecidedAt) }})</span>
            </dd>
          </div>
          <div class="queue-fact">
            <dt>{{ t('queue.field.attempts') }}</dt>
            <dd data-testid="queue-attempts">
              {{
                t('queue.field.attemptsValue', {
                  attempts: item.attemptCount,
                  backoffs: item.backoffCount,
                })
              }}
            </dd>
          </div>
          <div v-if="item.parked" class="queue-fact">
            <dt>{{ t('queue.field.parkReason') }}</dt>
            <dd data-testid="queue-park-reason">
              {{ reasonLabel(item.parkReason ?? '') }}
              <span v-if="item.parkDetail" class="queue-detail">— {{ item.parkDetail }}</span>
            </dd>
          </div>
        </dl>

        <div class="queue-row-actions">
          <button
            v-if="item.parked"
            type="button"
            class="queue-btn"
            data-testid="queue-unpark"
            @click="emit('control', 'unpark', item.intentId)"
          >
            {{ t('queue.control.unpark') }}
          </button>
          <button
            type="button"
            class="queue-btn"
            data-testid="queue-skip"
            @click="emit('control', item.forceSkipped ? 'unskip' : 'force_skip', item.intentId)"
          >
            {{ item.forceSkipped ? t('queue.control.unskip') : t('queue.control.forceSkip') }}
          </button>
          <button
            type="button"
            class="queue-btn"
            data-testid="queue-override-continue"
            @click="emit('control', 'override_continue', item.intentId)"
          >
            {{ t('queue.control.overrideContinue') }}
          </button>
          <button
            type="button"
            class="queue-btn queue-btn-danger"
            data-testid="queue-override-block"
            @click="emit('control', 'override_block', item.intentId)"
          >
            {{ t('queue.control.overrideBlock') }}
          </button>
        </div>
      </li>
    </ul>

    <p class="queue-note">{{ t('queue.note') }}</p>
  </section>
</template>

<style scoped>
.queue-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  overflow-y: auto;
  height: 100%;
}
.queue-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.queue-back {
  background: none;
  border: none;
  color: var(--c-primary-text);
  cursor: pointer;
  font-size: 14px;
  padding: 0;
}
.queue-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}
.queue-state {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--c-hover-strong);
  color: var(--c-text-muted);
}
.queue-state-developing,
.queue-state-running {
  color: var(--c-success-text);
}
.queue-state-paused,
.queue-state-awaiting_gate {
  color: var(--c-warning-text);
}
.queue-wake {
  font-size: 12px;
  color: var(--c-text-muted);
}
.queue-head-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}
.queue-hint,
.queue-note {
  font-size: 13px;
  color: var(--c-text-muted);
}
.queue-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.queue-row {
  border: 1px solid var(--c-border);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.queue-row-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.queue-row-title {
  background: none;
  border: none;
  padding: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--c-text);
  cursor: pointer;
  text-align: left;
}
.queue-badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--c-hover-strong);
  color: var(--c-text-muted);
}
.queue-badge-parked {
  color: var(--c-error-text);
}
.queue-badge-skipped {
  color: var(--c-warning-text);
}
.queue-facts {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 4px 16px;
  margin: 0;
}
.queue-fact {
  display: flex;
  gap: 6px;
  font-size: 12px;
}
.queue-fact dt {
  color: var(--c-text-muted);
  white-space: nowrap;
}
.queue-fact dd {
  margin: 0;
  color: var(--c-text);
}
.queue-detail {
  color: var(--c-text-muted);
}
.queue-row-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.queue-btn {
  font-size: 12px;
  padding: 3px 10px;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: var(--c-card);
  color: var(--c-text);
  cursor: pointer;
}
.queue-btn:hover {
  border-color: var(--c-primary);
}
.queue-btn-danger:hover {
  border-color: var(--c-error);
  color: var(--c-error-text);
}
@media (max-width: 720px) {
  .queue-head-actions {
    margin-left: 0;
  }
}
</style>
