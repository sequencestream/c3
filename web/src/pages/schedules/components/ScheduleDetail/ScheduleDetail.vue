<script setup lang="ts">
/**
 * ScheduleDetail.vue — schedules 视图右栏:选中 schedule 的详情面板。
 *
 * 当左侧列表选中一个 schedule 但未选中具体执行时展示,包含:
 *  - Vendor 品牌名 + 色点
 *  - mcpMode (带 i18n 标签)
 *  - toolAllowlist 完整列表(利用 toolManifest 缓存做读/写分类)
 *
 * Props:
 *  - schedule: 选中的定时任务对象(null 时隐藏)
 *  - toolManifest: per-vendor 工具清单缓存,用于判断工具读写属性
 */
import { computed } from 'vue'
import type { Schedule, ToolManifestEntry } from '@ccc/shared/protocol'
import { VENDOR_LABEL, VENDOR_COLOR } from '@/lib/vendor'
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

const props = defineProps<{
  schedule: Schedule | null
  toolManifest: Record<string, ToolManifestEntry[] | null>
}>()

/** 当前 vendor 的 tool manifest 缓存,可能为 null(尚未加载)。 */
const vendorTools = computed(() => {
  if (!props.schedule) return null
  return props.toolManifest[props.schedule.vendor] ?? null
})

/** toolAllowlist 条目数量。 */
const allowlistCount = computed(() => props.schedule?.toolAllowlist.length ?? 0)

/** 读/写分类:当 manifest 可用时,将 allowlist 分为只读/写入两组。 */
const readOnlyTools = computed(() => {
  if (allowlistCount.value === 0) return []
  const tools = vendorTools.value
  if (!tools) return null /* 无法分类 */
  const map = new Map(tools.map((t) => [t.name, t]))
  return props.schedule!.toolAllowlist.filter((name) => {
    const entry = map.get(name)
    return entry && !entry.isWrite
  })
})

const writeTools = computed(() => {
  if (allowlistCount.value === 0) return []
  const tools = vendorTools.value
  if (!tools) return null
  const map = new Map(tools.map((t) => [t.name, t]))
  return props.schedule!.toolAllowlist.filter((name) => {
    const entry = map.get(name)
    return entry && entry.isWrite
  })
})

/** 无法通过 manifest 匹配的工具(数据不一致时的兜底)。 */
const unclassifiedTools = computed(() => {
  if (allowlistCount.value === 0) return []
  const tools = vendorTools.value
  if (!tools) return props.schedule!.toolAllowlist
  const map = new Map(tools.map((t) => [t.name, t]))
  return props.schedule!.toolAllowlist.filter((name) => !map.has(name))
})

/** mcpMode → i18n 可读标签。 */
function mcpModeLabel(mode: string): string {
  if (mode === 'read-only') return t('schedule.form.mcpMode.readOnly.label')
  if (mode === 'sandboxed') return t('schedule.form.mcpMode.sandboxed.label')
  if (mode === 'full-access') return t('schedule.form.mcpMode.fullAccess.label')
  return mode
}

function vendorDotBg(vendor: string): string {
  return VENDOR_COLOR[vendor as keyof typeof VENDOR_COLOR] || '#888'
}
function vendorLabel(vendor: string): string {
  return VENDOR_LABEL[vendor as keyof typeof VENDOR_LABEL] || vendor
}
</script>

<template>
  <div v-if="schedule" class="sched-detail-wrap">
    <div class="sched-detail-head">
      <span class="sched-detail-title">{{ t('schedule.list.title.label') }}</span>
      <span class="sched-detail-id mono">{{ schedule.id }}</span>
    </div>

    <div class="sched-detail-body">
      <!-- Vendor -->
      <div class="sd-row">
        <span class="sd-label">{{ t('schedule.form.vendor.label') }}</span>
        <span class="sd-value sd-value--vendor">
          <span class="vendor-dot" :style="{ backgroundColor: vendorDotBg(schedule.vendor) }" />
          {{ vendorLabel(schedule.vendor) }}
        </span>
      </div>

      <!-- mcpMode -->
      <div class="sd-row">
        <span class="sd-label">{{ t('schedule.meta.mode.label') }}</span>
        <span class="sd-value">{{ mcpModeLabel(schedule.mcpMode) }}</span>
      </div>

      <!-- Tool Allowlist -->
      <div class="sd-section">
        <h4 class="sd-section-title">{{ t('schedule.form.tools.label') }}</h4>

        <!-- 空列表:全部工具无限制 -->
        <p v-if="allowlistCount === 0" class="sd-tools-empty">
          {{ t('schedule.list.toolSummaryAll') }}
        </p>

        <!-- 有 manifest:分类展示 -->
        <template v-else-if="vendorTools">
          <!-- 只读组 -->
          <div v-if="readOnlyTools && readOnlyTools.length" class="sd-tool-group">
            <span class="sd-tool-group-label sd-tool-group-label--ro">
              {{ t('schedule.form.tools.readOnly.label') }}
            </span>
            <ul class="sd-tool-list">
              <li
                v-for="name in readOnlyTools"
                :key="name"
                :data-testid="`sd-tool-ro-${name}`"
                class="sd-tool-item sd-tool-item--ro"
              >
                {{ name }}
              </li>
            </ul>
          </div>

          <!-- 写入组 -->
          <div v-if="writeTools && writeTools.length" class="sd-tool-group">
            <span class="sd-tool-group-label sd-tool-group-label--w">
              {{ t('schedule.form.tools.write.label') }}
            </span>
            <ul class="sd-tool-list">
              <li
                v-for="name in writeTools"
                :key="name"
                :data-testid="`sd-tool-w-${name}`"
                class="sd-tool-item sd-tool-item--w"
              >
                {{ name }}
              </li>
            </ul>
          </div>

          <!-- manifest 中不存在的工具(兜底) -->
          <div v-if="unclassifiedTools.length" class="sd-tool-group">
            <ul class="sd-tool-list">
              <li v-for="name in unclassifiedTools" :key="name" class="sd-tool-item">
                {{ name }}
              </li>
            </ul>
          </div>
        </template>

        <!-- 无 manifest 缓存:原始列表展示 -->
        <ul v-else class="sd-tool-list">
          <li
            v-for="name in schedule.toolAllowlist"
            :key="name"
            data-testid="sd-tool-unclassified"
            class="sd-tool-item"
          >
            {{ name }}
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sched-detail-wrap {
  flex: 1;
  height: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--c-panel);
  color: var(--c-text);
  overflow: hidden;
}

.sched-detail-head {
  height: 36px;
  flex-shrink: 0;
  padding: 0 var(--sp-3);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  border-bottom: 1px solid var(--c-border);
}
.sched-detail-title {
  font-size: var(--fs-title-sm);
  font-weight: 600;
  white-space: nowrap;
}
.sched-detail-id {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sched-detail-id.mono {
  font-family: var(--ff-mono, monospace);
}

.sched-detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.sd-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-caption);
}
.sd-label {
  color: var(--c-text-muted);
  min-width: 80px;
  flex-shrink: 0;
}
.sd-value {
  color: var(--c-text);
}
.sd-value--vendor {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.sd-section {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.sd-section-title {
  font-size: var(--fs-body);
  font-weight: 600;
  margin: var(--sp-2) 0 0 0;
  padding-bottom: var(--sp-1);
  border-bottom: 1px solid var(--c-border);
}

.sd-tool-group {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.sd-tool-group-label {
  font-size: var(--fs-badge);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  align-self: flex-start;
}
.sd-tool-group-label--ro {
  color: var(--c-text-muted);
  background: var(--c-hover);
}
.sd-tool-group-label--w {
  color: var(--c-warning);
  background: rgba(245, 158, 11, 0.1);
}

.sd-tool-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.sd-tool-item {
  font-family: var(--ff-mono, monospace);
  font-size: var(--fs-caption);
  padding: 2px 4px;
  border-radius: var(--radius-sm);
  color: var(--c-text);
}
.sd-tool-item--ro {
  color: var(--c-text-muted);
}
.sd-tool-item--w {
  color: var(--c-text);
}

.sd-tools-empty {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  margin: 0;
  font-style: italic;
}
</style>
