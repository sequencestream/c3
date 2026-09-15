<script setup lang="ts">
/*
 * SpeedTestReport.vue — 单个提供方的测速历史报告。
 *
 * 只读、只增、只看一个提供方:面板里绝不把两家的数并排放——不同协议、不同模型、不同
 * 时点的数摆在同一张表里,读者一定会去比,而它们并不可比。要横向看就走 SpeedTestCompare:
 * 那边每一行都带着自己的测量时间与口径提示,比较是被明说的,不是被顺手做出来的。
 *
 * 历史不因提供方被删而消失:入口按 providerId 取,展示名缺失时回退记录里的名称快照。
 * 因此这个面板既能从某行打开,也能从「历史报告」总入口选到一个已经不存在的提供方。
 */
import { computed } from 'vue'
import type { SpeedTestRun } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import type { SpeedTestUiState } from '@/lib/model-provider-speed-test'
import { formatRate01 } from '@/lib/model-provider-speed-test'
import SpeedTestSummaryView from './SpeedTestSummary.vue'

const { t } = useTypedI18n()

const props = defineProps<{ state: SpeedTestUiState }>()

const emit = defineEmits<{
  select: [runId: string]
  loadMore: [payload: { providerId: string; offset: number }]
  pick: [providerId: string]
  compare: []
  close: []
}>()

const page = computed(() => props.state.history)
const runs = computed(() => page.value?.runs ?? [])

/**
 * 展示名:优先当前配置(由服务端合并),否则记录里的名称快照——提供方被删之后,
 * 记录里的快照就是它仅剩的名字。总入口刚打开、还没选中任何一条时返回 null,
 * 标题退回中性的「测速历史」。
 */
const title = computed(() => {
  const id = props.state.reportProviderId
  if (!id) return null
  const known = props.state.historyProviders?.find((p) => p.providerId === id)
  return known?.displayName ?? runs.value[0]?.providerDisplayName ?? id
})

/** 空态要说清是「还没选」还是「选了但没有记录」,两者的下一步完全不同。 */
const emptyText = computed(() => {
  if (props.state.loading) return t('settings.providers.speedTest.report.loading')
  if (!props.state.reportProviderId) return t('settings.providers.speedTest.report.pick')
  return t('settings.providers.speedTest.report.empty')
})

function rowLabel(run: SpeedTestRun): string {
  return t('settings.providers.speedTest.report.row', {
    time: new Date(run.startedAt).toLocaleString(),
    model: run.model,
    dialect: run.apiDialect,
    completed: run.summary.completedCount,
    planned: run.plannedCount,
    rate: formatRate01(run.summary.successRate) ?? t('settings.providers.speedTest.unavailable'),
  })
}

function onLoadMore(): void {
  const providerId = props.state.reportProviderId
  if (!providerId) return
  emit('loadMore', { providerId, offset: runs.value.length })
}
</script>

<template>
  <div class="str-overlay" data-testid="speed-test-report-overlay" @click.self="emit('close')">
    <div class="str-modal" role="dialog" aria-modal="true">
      <h3 class="str-title">
        {{
          title === null
            ? t('settings.providers.speedTest.report.titleAll')
            : t('settings.providers.speedTest.report.title', { name: title })
        }}
      </h3>

      <!-- 总入口:可选到任何有记录的提供方,包括已删除的;每次仍只看一个。 -->
      <label v-if="state.historyProviders" class="str-picker">
        <span>{{ t('settings.providers.speedTest.report.picker.label') }}</span>
        <select
          class="agent-field"
          :value="state.reportProviderId ?? ''"
          data-testid="speed-test-report-picker"
          @change="emit('pick', ($event.target as HTMLSelectElement).value)"
        >
          <option v-for="p in state.historyProviders" :key="p.providerId" :value="p.providerId">
            {{
              p.present
                ? t('settings.providers.speedTest.report.picker.option', {
                    name: p.displayName,
                    count: p.runCount,
                  })
                : t('settings.providers.speedTest.report.picker.deleted', {
                    name: p.displayName,
                    count: p.runCount,
                  })
            }}
          </option>
        </select>
      </label>

      <p v-if="runs.length === 0" class="str-empty" data-testid="speed-test-report-empty">
        {{ emptyText }}
      </p>

      <ul v-else class="str-list">
        <li v-for="run in runs" :key="run.runId">
          <button
            class="str-row"
            :class="{ selected: state.detail?.run.runId === run.runId }"
            data-testid="speed-test-report-row"
            @click="emit('select', run.runId)"
          >
            {{ rowLabel(run) }}
          </button>
        </li>
      </ul>

      <button
        v-if="page?.hasMore"
        class="ghost"
        data-testid="speed-test-report-more"
        @click="onLoadMore"
      >
        {{ t('settings.providers.speedTest.report.more.label') }}
      </button>

      <SpeedTestSummaryView v-if="state.detail" :detail="state.detail" />

      <div class="str-foot">
        <!-- 正在看一条历史的人,下一个问题多半是「那别家呢」——把对比摆在手边。 -->
        <button class="ghost" data-testid="speed-test-report-compare" @click="emit('compare')">
          {{ t('settings.providers.speedTest.compare.button.label') }}
        </button>
        <button class="str-cancel" data-testid="speed-test-report-close" @click="emit('close')">
          {{ t('common.action.close.label') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.str-overlay {
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.str-modal {
  max-width: 720px;
  width: 94vw;
  max-height: 88vh;
  overflow-y: auto;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-lg, 0 8px 32px rgba(0, 0, 0, 0.25));
}
.str-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-body);
  font-weight: 600;
}
.str-picker {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
  font-size: var(--fs-caption);
}
.str-picker > .agent-field {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}
.str-empty {
  margin: 0;
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
.str-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.str-row {
  width: 100%;
  text-align: left;
  background: transparent;
  color: var(--c-text);
  border: 1px solid transparent;
  font-size: var(--fs-caption);
  padding: 4px 6px;
}
.str-row:hover:not(:disabled) {
  background: var(--c-hover);
  filter: none;
}
.str-row.selected {
  border-color: var(--c-primary);
  background: var(--c-primary-soft);
}
.str-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}
.str-cancel {
  background: transparent;
  color: var(--c-text-muted);
  border: 1px solid var(--c-border);
}

@media (max-width: 767px) {
  .str-overlay {
    align-items: stretch;
    justify-content: stretch;
    background: var(--c-bg);
  }
  .str-modal {
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
