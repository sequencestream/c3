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
import { computed, onUnmounted, ref, watch } from 'vue'
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

/*
 * 退避/冷却倒计时。这两类阻塞的解除条件只有「时间到」,等待期间界面若一动不动会被读成
 * 卡死。服务端投影里的 nextWakeupAt 是唯一权威截止时间,这里只做两件事:按秒展示剩余,
 * 以及到点催一次队列详情刷新——到点之后是继续跑还是换个原因挡住,仍由下一轮对账给出,
 * 客户端不预测、不改写阻塞结论。
 */
const COUNTDOWN_REASONS = new Set(['blocked_backoff', 'blocked_cooldown'])
const TICK_MS = 1000

const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null
/** 已经催过刷新的截止时间(意图 + 截止时刻):换了截止时间即重新武装,同一个不会催第二次。 */
const refreshedDeadlines = new Set<string>()

/** 正在等时钟的行:只有退避/冷却且带截止时间的条目参与计时。 */
const waits = computed<{ intentId: string; at: number }[]>(() => {
  const out: { intentId: string; at: number }[] = []
  for (const item of items.value) {
    if (!COUNTDOWN_REASONS.has(item.blockedReason)) continue
    if (item.nextWakeupAt === null) continue
    out.push({ intentId: item.intentId, at: item.nextWakeupAt })
  }
  return out
})

/** 每条等待行当前该显示的剩余时长;已到点的行不在表内,于是倒计时自然消失。 */
const countdowns = computed<Map<string, string>>(() => {
  const out = new Map<string, string>()
  for (const wait of waits.value) {
    const left = Math.max(0, wait.at - now.value)
    if (left > 0) out.set(wait.intentId, remainingLabel(left))
  }
  return out
})

/** 剩余毫秒 → 本地化文案;向上取整到秒,免得最后不足一秒时提前显示成已到点。 */
function remainingLabel(ms: number): string {
  const total = Math.ceil(ms / 1000)
  const minutes = Math.floor(total / 60)
  if (minutes > 0) {
    const seconds = String(total % 60).padStart(2, '0')
    return t('queue.countdown.minutesSeconds', { minutes, seconds })
  }
  return t('queue.countdown.seconds', { seconds: total })
}

function deadlineKey(wait: { intentId: string; at: number }): string {
  return `${wait.intentId}@${wait.at}`
}

function stopTicker(): void {
  if (ticker === null) return
  clearInterval(ticker)
  ticker = null
}

/*
 * 单一计时器驱动所有行:只在还有未到点的等待时运行,新投影到达、条目离开退避/冷却或
 * 页面卸载都会把它停掉,不会留下串行倒计时或卸载后的副作用。
 */
watch(
  [waits, now],
  () => {
    const live = new Set(waits.value.map(deadlineKey))
    for (const key of refreshedDeadlines) {
      if (!live.has(key)) refreshedDeadlines.delete(key)
    }

    let due = false
    let pending = false
    for (const wait of waits.value) {
      if (wait.at > now.value) {
        pending = true
        continue
      }
      const key = deadlineKey(wait)
      if (refreshedDeadlines.has(key)) continue
      refreshedDeadlines.add(key)
      due = true
    }

    if (pending) {
      if (ticker === null) {
        ticker = setInterval(() => {
          now.value = Date.now()
        }, TICK_MS)
      }
    } else {
      stopTicker()
    }

    if (due) emit('refresh')
  },
  { immediate: true },
)

onUnmounted(stopTicker)
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
              <!-- 位次只在并发闸门挡住本条意图时由服务端给出;为空即不渲染,
                   不留占位、也不沿用上一轮的旧名次。 -->
              <span
                v-if="item.queuePosition !== null"
                class="queue-position"
                data-testid="queue-position"
              >
                {{ t('queue.field.position', { position: item.queuePosition }) }}
              </span>
            </dd>
          </div>
          <div class="queue-fact">
            <dt>{{ t('queue.field.nextWakeup') }}</dt>
            <dd data-testid="queue-wakeup">
              {{ whenLabel(item.nextWakeupAt) }}
              <span
                v-if="countdowns.get(item.intentId)"
                class="queue-countdown"
                data-testid="queue-countdown"
              >
                {{ countdowns.get(item.intentId) }}
              </span>
            </dd>
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
.queue-position {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--c-hover-strong);
  color: var(--c-warning-text);
  white-space: nowrap;
}
.queue-countdown {
  color: var(--c-warning-text);
  font-variant-numeric: tabular-nums;
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
