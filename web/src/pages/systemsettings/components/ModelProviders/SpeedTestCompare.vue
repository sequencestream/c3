<script setup lang="ts">
/*
 * SpeedTestCompare.vue — 跨提供方横向对比。
 *
 * 与单提供方报告是两张面孔:报告回答「这条上游的历史长什么样」,这里回答「该选哪一家」。
 * 因此它一次列出所有存在测速记录的提供方,每条各取一轮汇总指标并排——这正是报告页面里
 * 拒绝做的事,也是这个视图存在的唯一理由。
 *
 * 口径的两处不遮掩:
 *  - 这些数**不是同一时刻测的**,网络与上游负载各不相同。页内固定摆出这句提示,而不是
 *    留给读者自己想起来。
 *  - 不可用就是不可用。整体失败的一轮样本数为 0,延迟列显示本地化的「不可用」,成功率
 *    则如实显示 0% —— 前者是「没测到」,后者是「测到了但全失败」,两者不能画成同一个样子。
 *
 * 取数一次拿全:每条 provider 连同它最近若干轮一起回来,此后切换轮次与切换排序都只动
 * 本地状态。一次选型要反复换着看,每换一次往返一趟既慢又没必要。
 */
import { computed, ref } from 'vue'
import type { SpeedTestRun } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import {
  buildComparisonRows,
  formatMs,
  formatRate,
  formatRate01,
  SPEED_TEST_ERROR_KEYS,
  type SpeedTestCompareDirection,
  type SpeedTestUiState,
} from '@/lib/model-provider-speed-test'

const { t } = useTypedI18n()

const props = defineProps<{ state: SpeedTestUiState }>()

const emit = defineEmits<{ close: []; retry: [] }>()

/**
 * 每行选中哪一轮,缺省即该行的最近一次。
 *
 * 只存 providerId → runId:选中哪一条是纯粹的观察选择,不进服务端也不落存储。落空由
 * `buildComparisonRows` 兜回最近一次,所以这里可以放心地留着已经失效的 id。
 */
const selection = ref<Record<string, string>>({})

/** 默认按 TTFT P50 升序——「谁先吐出第一个 token」是选型时最先看的一列。 */
const direction = ref<SpeedTestCompareDirection>('asc')

const NA = computed(() => t('settings.providers.speedTest.unavailable'))
const rows = computed(() =>
  buildComparisonRows(props.state.compare ?? [], selection.value, direction.value),
)

/** 取数还没回来、也还没被拒 —— 与「取回来是空的」是两件事,空态不能混用。 */
const loading = computed(() => props.state.compare === null && props.state.error === null)
const failed = computed(() => props.state.compare === null && props.state.error !== null)

/** 被拒原因本地化后的句子;文案表与对话框共用一份,两处说法因此不会走样。 */
const failureText = computed(() =>
  props.state.error ? t(SPEED_TEST_ERROR_KEYS[props.state.error]) : null,
)

function ms(value: number | null): string {
  return formatMs(value) ?? NA.value
}
function percent(value: number | null): string {
  return formatRate01(value) ?? NA.value
}
function rate(value: number | null): string {
  return formatRate(value) ?? NA.value
}

/** 有任意一行按 delta 估算过 token,就在表下挂一句:估算会污染 TPOT 与 tokens/秒。 */
const anyEstimated = computed(() =>
  rows.value.some((row) => row.run.summary.estimatedSampleCount > 0),
)

function outcomeLabel(run: SpeedTestRun): string {
  switch (run.outcome) {
    case 'completed':
      return t('settings.providers.speedTest.outcome.completed')
    case 'failed':
      return t('settings.providers.speedTest.outcome.failed')
    case 'interrupted':
      return t('settings.providers.speedTest.outcome.interrupted')
  }
}

/** 备选下拉与「只有一条」时的正文共用同一句,读者看到的时间/模型/完成数因此不会两样。 */
function optionLabel(run: SpeedTestRun): string {
  return t('settings.providers.speedTest.compare.choice.option', {
    time: new Date(run.startedAt).toLocaleString(),
    model: run.model,
    completed: run.summary.completedCount,
    planned: run.plannedCount,
  })
}

function onSelect(providerId: string, runId: string): void {
  selection.value = { ...selection.value, [providerId]: runId }
}

function toggleSort(): void {
  direction.value = direction.value === 'asc' ? 'desc' : 'asc'
}
</script>

<template>
  <div class="stc-overlay" data-testid="speed-test-compare-overlay" @click.self="emit('close')">
    <div class="stc-modal" role="dialog" aria-modal="true">
      <h3 class="stc-title">{{ t('settings.providers.speedTest.compare.title') }}</h3>

      <!-- 口径提示固定在标题下,不随内容折叠:读者比数之前先看到它。 -->
      <p class="stc-note" data-testid="speed-test-compare-note">
        {{ t('settings.providers.speedTest.compare.note') }}
      </p>

      <p v-if="loading" class="stc-note" data-testid="speed-test-compare-loading">
        {{ t('settings.providers.speedTest.compare.loading') }}
      </p>

      <!-- 取数被拒就说清楚是哪一条拒绝、并给一次重试;沉默地停在「加载中」是最坏的一种。 -->
      <p v-else-if="failed" class="stc-failed" data-testid="speed-test-compare-failed">
        {{ t('settings.providers.speedTest.compare.failed') }}
        {{ failureText }}
        <button class="ghost" data-testid="speed-test-compare-retry" @click="emit('retry')">
          {{ t('settings.providers.speedTest.compare.retry.label') }}
        </button>
      </p>

      <p v-else-if="rows.length === 0" class="stc-empty" data-testid="speed-test-compare-empty">
        {{ t('settings.providers.speedTest.compare.empty') }}
      </p>

      <div v-else class="stc-scroll">
        <table class="stc-table" :aria-label="t('settings.providers.speedTest.compare.title')">
          <thead>
            <tr>
              <th class="stc-left">
                {{ t('settings.providers.speedTest.compare.column.provider') }}
              </th>
              <th class="stc-left">{{ t('settings.providers.speedTest.compare.column.run') }}</th>
              <th>{{ t('settings.providers.speedTest.compare.column.outcome') }}</th>
              <th>{{ t('settings.providers.speedTest.compare.column.successRate') }}</th>
              <!-- 排序只由这一列驱动:默认升序,点一次翻向。 -->
              <th
                :aria-sort="direction === 'asc' ? 'ascending' : 'descending'"
                data-testid="speed-test-compare-sort-header"
              >
                <button
                  class="stc-sort"
                  data-testid="speed-test-compare-sort"
                  :title="
                    direction === 'asc'
                      ? t('settings.providers.speedTest.compare.sort.ascending')
                      : t('settings.providers.speedTest.compare.sort.descending')
                  "
                  @click="toggleSort"
                >
                  {{ t('settings.providers.speedTest.compare.column.ttftP50') }}
                  <span class="stc-arrow">{{ direction === 'asc' ? '▲' : '▼' }}</span>
                </button>
              </th>
              <th>{{ t('settings.providers.speedTest.compare.column.ttftP95') }}</th>
              <th>{{ t('settings.providers.speedTest.compare.column.tpotP50') }}</th>
              <th>{{ t('settings.providers.speedTest.compare.column.tpotP95') }}</th>
              <th>{{ t('settings.providers.speedTest.compare.column.endToEndP50') }}</th>
              <th>{{ t('settings.providers.speedTest.compare.column.endToEndP95') }}</th>
              <th>{{ t('settings.providers.speedTest.compare.column.tokensPerSecond') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.providerId" data-testid="speed-test-compare-row">
              <td class="stc-left" data-testid="speed-test-compare-provider">
                {{
                  row.present
                    ? row.displayName
                    : t('settings.providers.speedTest.compare.deleted', { name: row.displayName })
                }}
              </td>
              <td class="stc-left" data-testid="speed-test-compare-run">
                <!-- 只有一条备选就不摆下拉:一个只能选它自己的控件只会让人以为还有别的。 -->
                <span v-if="row.choices.length === 1">{{ optionLabel(row.run) }}</span>
                <select
                  v-else
                  class="agent-field stc-select"
                  :aria-label="t('settings.providers.speedTest.compare.choice.label')"
                  :value="row.run.runId"
                  @change="onSelect(row.providerId, ($event.target as HTMLSelectElement).value)"
                >
                  <option v-for="choice in row.choices" :key="choice.runId" :value="choice.runId">
                    {{ optionLabel(choice) }}
                  </option>
                </select>
              </td>
              <td>{{ outcomeLabel(row.run) }}</td>
              <td data-testid="speed-test-compare-success-rate">
                {{ percent(row.run.summary.successRate) }}
              </td>
              <td data-testid="speed-test-compare-ttft-p50">
                {{ ms(row.run.summary.ttft.p50Ms) }}
              </td>
              <td>{{ ms(row.run.summary.ttft.p95Ms) }}</td>
              <td>{{ ms(row.run.summary.tpot.p50Ms) }}</td>
              <td>{{ ms(row.run.summary.tpot.p95Ms) }}</td>
              <td>{{ ms(row.run.summary.endToEnd.p50Ms) }}</td>
              <td>{{ ms(row.run.summary.endToEnd.p95Ms) }}</td>
              <td data-testid="speed-test-compare-tps">
                {{ rate(row.run.summary.tokensPerSecond)
                }}<span v-if="row.run.summary.estimatedSampleCount > 0" class="stc-est">*</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="anyEstimated" class="stc-note" data-testid="speed-test-compare-estimated">
        {{ t('settings.providers.speedTest.compare.estimated') }}
      </p>
      <!-- 每行各测各的,样本数不一;把样本口径摆出来,不宣称这些数彼此同条件。 -->
      <p v-if="rows.length > 0" class="stc-note">
        {{ t('settings.providers.speedTest.sampleCaveat') }}
      </p>

      <div class="stc-foot">
        <button class="stc-cancel" data-testid="speed-test-compare-close" @click="emit('close')">
          {{ t('common.action.close.label') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.stc-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.stc-modal {
  max-width: 1080px;
  width: 94vw;
  max-height: 88vh;
  overflow-y: auto;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.stc-title {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-body);
  font-weight: 600;
}
.stc-note,
.stc-empty,
.stc-failed {
  margin: 0 0 var(--sp-2);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  line-height: var(--lh-normal);
  word-break: break-word;
}
.stc-failed {
  color: var(--c-error-text);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
}
/* 列多而窄,窄屏横向滚动好过把数字挤成两行。 */
.stc-scroll {
  overflow-x: auto;
  margin-top: var(--sp-2);
}
.stc-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-caption);
}
.stc-table th,
.stc-table td {
  text-align: right;
  padding: 4px 8px;
  border-bottom: 1px solid var(--c-border);
  white-space: nowrap;
}
.stc-table th {
  color: var(--c-text-muted);
  font-weight: 500;
  vertical-align: bottom;
}
.stc-left {
  text-align: left;
}
.stc-sort {
  background: transparent;
  color: var(--c-text-muted);
  border: 0;
  padding: 0;
  font-size: var(--fs-caption);
  font-weight: 500;
  white-space: nowrap;
}
.stc-sort:hover {
  background: transparent;
  filter: none;
  color: var(--c-text);
}
.stc-arrow {
  font-size: 0.8em;
}
.stc-select {
  width: auto;
  min-width: 0;
  max-width: 22rem;
  font-size: var(--fs-caption);
}
.stc-est {
  color: var(--c-warning-text);
}
.stc-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--sp-3);
}
.stc-cancel {
  background: transparent;
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
}

@media (max-width: 767px) {
  .stc-overlay {
    align-items: stretch;
    justify-content: stretch;
    background: var(--c-bg);
  }
  .stc-modal {
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
