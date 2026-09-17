<script setup lang="ts">
/*
 * SpeedTestSummary.vue — 一次测速的完整汇总 + 逐请求明细。
 *
 * 只做呈现,不做计算:汇总是服务端按文档公式算好的,这里舍入到人能读的位数就完事。
 * 前端自己再算一遍等于给同一个指标开了第二个来源,两边迟早对不上。
 *
 * 两条硬规矩:
 *  - `null` 一律显示本地化的「不可用」。画成 0 会被读成「一个 token 都没产出」,
 *    而 0 与「没有成功样本」是两件完全不同的事。
 *  - 存在 delta 估算时,TPOT 与 tokens/sec 旁边挂标记。一个 delta 可能含多个 token,
 *    误差可能很大,不能让它看起来和计费口径只差一点点。
 */
import { computed } from 'vue'
import type { SpeedTestLatencyStats, SpeedTestRunDetail } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import {
  formatMs,
  formatRate,
  formatRate01,
  formatSpeedTestModelPair,
} from '@/lib/model-provider-speed-test'

const { t } = useTypedI18n()

const props = defineProps<{ detail: SpeedTestRunDetail }>()

const run = computed(() => props.detail.run)
const summary = computed(() => run.value.summary)

/** 本地化的「不可用」。空样本、无成功请求一律落到这里,绝不退化成 0 或空白。 */
const NA = computed(() => t('settings.providers.speedTest.unavailable'))

function ms(value: number | null): string {
  return formatMs(value) ?? NA.value
}
function rate(value: number | null): string {
  return formatRate(value) ?? NA.value
}
function percent(value: number | null): string {
  return formatRate01(value) ?? NA.value
}

/** 三个延迟指标各一行,行内是 样本数 / avg / P50 / P95 / P99。 */
const latencyRows = computed<{ key: string; label: string; stats: SpeedTestLatencyStats }[]>(() => [
  { key: 'ttft', label: t('settings.providers.speedTest.metric.ttft'), stats: summary.value.ttft },
  { key: 'tpot', label: t('settings.providers.speedTest.metric.tpot'), stats: summary.value.tpot },
  {
    key: 'e2e',
    label: t('settings.providers.speedTest.metric.endToEnd'),
    stats: summary.value.endToEnd,
  },
])

const estimated = computed(() => summary.value.estimatedSampleCount > 0)

function outcomeLabel(value: SpeedTestRunDetail['run']['outcome']): string {
  switch (value) {
    case 'completed':
      return t('settings.providers.speedTest.outcome.completed')
    case 'failed':
      return t('settings.providers.speedTest.outcome.failed')
    case 'interrupted':
      return t('settings.providers.speedTest.outcome.interrupted')
  }
}

function requestOutcomeLabel(value: SpeedTestRunDetail['requests'][number]['outcome']): string {
  switch (value) {
    case 'success':
      return t('settings.providers.speedTest.request.success')
    case 'failure':
      return t('settings.providers.speedTest.request.failure')
    case 'cancelled':
      return t('settings.providers.speedTest.request.cancelled')
  }
}

/** 失败分类 + HTTP 状态;成功/取消行留空,不硬塞一个「—」以外的东西。 */
function failureLabel(r: SpeedTestRunDetail['requests'][number]): string {
  if (!r.failureCategory) return '—'
  const category = t(`settings.providers.speedTest.failure.${r.failureCategory}` as const)
  return r.httpStatus ? `${category} (${r.httpStatus})` : category
}

function modelPair(observedModels: readonly (string | null)[]): string {
  return formatSpeedTestModelPair(
    run.value.model,
    observedModels,
    t('settings.providers.speedTest.model.default'),
    t('settings.providers.speedTest.model.unknown'),
  )
}
</script>

<template>
  <section class="sts" data-testid="speed-test-summary">
    <!-- 采样目标先摆出来:同一条 provider 的不同轮次可能打的是不同协议/模型。 -->
    <p class="sts-target" data-testid="speed-test-target">
      {{
        t('settings.providers.speedTest.target', {
          protocol: run.protocolType,
          dialect: run.apiDialect,
          model: modelPair(run.observedModels),
          calibration: run.calibrationVersion,
          maxTokens: run.maxOutputTokens,
          temperature: run.temperature,
        })
      }}
    </p>

    <dl class="sts-counts">
      <div>
        <dt>{{ t('settings.providers.speedTest.summary.outcome') }}</dt>
        <dd data-testid="speed-test-outcome">{{ outcomeLabel(run.outcome) }}</dd>
      </div>
      <div>
        <!-- 「已完成 n / 计划 N」必须与成功率同屏:中断后成功率只覆盖已完成的那部分。 -->
        <dt>{{ t('settings.providers.speedTest.summary.completed') }}</dt>
        <dd>{{ summary.completedCount }} / {{ run.plannedCount }}</dd>
      </div>
      <div>
        <dt>{{ t('settings.providers.speedTest.summary.successRate') }}</dt>
        <dd data-testid="speed-test-success-rate">{{ percent(summary.successRate) }}</dd>
      </div>
      <div>
        <dt>{{ t('settings.providers.speedTest.summary.failed') }}</dt>
        <dd>{{ summary.failureCount }}</dd>
      </div>
      <div>
        <dt>{{ t('settings.providers.speedTest.summary.cancelled') }}</dt>
        <dd>{{ summary.cancelledCount }}</dd>
      </div>
    </dl>

    <table class="sts-table">
      <thead>
        <tr>
          <th>{{ t('settings.providers.speedTest.table.metric') }}</th>
          <th>{{ t('settings.providers.speedTest.table.samples') }}</th>
          <th>{{ t('settings.providers.speedTest.table.avg') }}</th>
          <th>{{ t('settings.providers.speedTest.table.p50') }}</th>
          <th>{{ t('settings.providers.speedTest.table.p95') }}</th>
          <th>{{ t('settings.providers.speedTest.table.p99') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in latencyRows" :key="row.key" :data-testid="`speed-test-row-${row.key}`">
          <td>{{ row.label }}</td>
          <td>{{ row.stats.sampleCount }}</td>
          <td>{{ ms(row.stats.avgMs) }}</td>
          <td>{{ ms(row.stats.p50Ms) }}</td>
          <td>{{ ms(row.stats.p95Ms) }}</td>
          <td>{{ ms(row.stats.p99Ms) }}</td>
        </tr>
      </tbody>
    </table>

    <dl class="sts-counts">
      <div>
        <dt>{{ t('settings.providers.speedTest.summary.tokensPerSecond') }}</dt>
        <dd data-testid="speed-test-tps">{{ rate(summary.tokensPerSecond) }}</dd>
      </div>
      <div>
        <dt>{{ t('settings.providers.speedTest.summary.requestsPerSecond') }}</dt>
        <dd>{{ rate(summary.requestsPerSecond) }}</dd>
      </div>
      <div>
        <dt>{{ t('settings.providers.speedTest.summary.outputTokens') }}</dt>
        <dd>{{ summary.outputTokensTotal }}</dd>
      </div>
    </dl>

    <p v-if="estimated" class="sts-note" data-testid="speed-test-estimated">
      {{ t('settings.providers.speedTest.estimated', { n: summary.estimatedSampleCount }) }}
    </p>
    <!-- 10 个样本的 P95/P99 常落在最大值。把样本数摆出来,不宣称它有多高置信度。 -->
    <p class="sts-note">{{ t('settings.providers.speedTest.sampleCaveat') }}</p>

    <h5 class="sts-subtitle">{{ t('settings.providers.speedTest.requests.title') }}</h5>
    <table class="sts-table">
      <thead>
        <tr>
          <th>#</th>
          <th>{{ t('settings.providers.speedTest.table.result') }}</th>
          <th>{{ t('settings.providers.speedTest.table.model') }}</th>
          <th>{{ t('settings.providers.speedTest.table.failure') }}</th>
          <th>{{ t('settings.providers.speedTest.table.ttft') }}</th>
          <th>{{ t('settings.providers.speedTest.table.endToEnd') }}</th>
          <th>{{ t('settings.providers.speedTest.table.tokens') }}</th>
          <th>{{ t('settings.providers.speedTest.table.tpot') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in detail.requests" :key="r.sequence" data-testid="speed-test-request-row">
          <td>{{ r.sequence }}</td>
          <td>{{ requestOutcomeLabel(r.outcome) }}</td>
          <td>{{ modelPair([r.observedModel]) }}</td>
          <td>{{ failureLabel(r) }}</td>
          <td>{{ ms(r.ttftMs) }}</td>
          <td>{{ ms(r.endToEndMs) }}</td>
          <td>
            {{ r.outputTokens ?? NA
            }}<span v-if="r.tokenCountSource === 'delta_estimate'" class="sts-est">*</span>
          </td>
          <td>{{ ms(r.tpotMs) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
.sts {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
  border-top: 1px solid var(--c-border);
  padding-top: var(--sp-3);
}
.sts-target,
.sts-note {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  line-height: var(--lh-normal);
  word-break: break-word;
}
.sts-subtitle {
  margin: var(--sp-2) 0 0;
  font-size: var(--fs-caption);
  opacity: 0.8;
}
.sts-counts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  margin: 0;
  font-size: var(--fs-caption);
}
.sts-counts > div {
  display: flex;
  gap: 4px;
}
.sts-counts dt {
  color: var(--c-text-muted);
}
.sts-counts dd {
  margin: 0;
  font-weight: 600;
}
.sts-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-caption);
}
.sts-table th,
.sts-table td {
  text-align: right;
  padding: 2px 6px;
  border-bottom: 1px solid var(--c-border);
  white-space: nowrap;
}
.sts-table th:first-child,
.sts-table td:first-child {
  text-align: left;
}
.sts-table th {
  color: var(--c-text-muted);
  font-weight: 500;
}
.sts-est {
  color: var(--c-warning-text);
}
</style>
