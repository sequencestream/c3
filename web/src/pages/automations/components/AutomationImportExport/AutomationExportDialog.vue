<script setup lang="ts">
/**
 * AutomationExportDialog.vue — 导出弹框。
 *
 * 列出当前 workspace 已加载的全部自动化,每条可勾选(默认全选),确认后把选中项经纯
 * 函数编解码层序列化为带版本号的 JSON 文件并触发浏览器下载。纯前端:不发任何写消息。
 */
import { computed, ref, watch } from 'vue'
import type { Automation } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import {
  buildExportFile,
  serializeExportFile,
  exportFilename,
} from '@/pages/automations/import-export'

const { t } = useTypedI18n()

const props = defineProps<{
  open: boolean
  automations: Automation[]
  workspacePath: string
}>()

const emit = defineEmits<{ close: [] }>()

// Selected ids; (re)initialized to all when the dialog opens.
const selected = ref<Set<string>>(new Set())

watch(
  () => props.open,
  (open) => {
    if (open) selected.value = new Set(props.automations.map((a) => a.id))
  },
  { immediate: true },
)

const allSelected = computed(
  () => props.automations.length > 0 && selected.value.size === props.automations.length,
)

function toggle(id: string): void {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

function toggleAll(): void {
  selected.value = allSelected.value ? new Set() : new Set(props.automations.map((a) => a.id))
}

// Display name: the stored `config.name`, else a trigger-based fallback.
function displayName(a: Automation): string {
  const cfg = a.config
  const name =
    cfg && typeof cfg === 'object' && typeof (cfg as Record<string, unknown>).name === 'string'
      ? ((cfg as Record<string, unknown>).name as string).trim()
      : ''
  if (name) return name
  return a.triggerType === 'event'
    ? a.eventFilters?.map((f) => f.type).join(' · ') || 'event'
    : a.cronExpression
}

function download(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function confirmExport(): void {
  if (selected.value.size === 0) return
  const file = buildExportFile(props.automations, selected.value, new Date().toISOString())
  download(exportFilename(props.workspacePath, new Date()), serializeExportFile(file))
  emit('close')
}
</script>

<template>
  <div v-if="open" class="ie-overlay" @click.self="emit('close')">
    <div
      class="ie-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="t('automation.importExport.export.title')"
    >
      <div class="ie-head">
        <h2>{{ t('automation.importExport.export.title') }}</h2>
        <button
          class="ie-icon-btn"
          :aria-label="t('common.action.close.tooltip')"
          :title="t('common.action.close.tooltip')"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>

      <div class="ie-body">
        <p v-if="automations.length === 0" class="ie-empty">
          {{ t('automation.importExport.export.empty') }}
        </p>
        <template v-else>
          <p class="ie-desc">{{ t('automation.importExport.export.description') }}</p>
          <label class="ie-row ie-row-all">
            <input type="checkbox" :checked="allSelected" @change="toggleAll" />
            <span class="ie-name">{{ t('automation.importExport.export.selectAll') }}</span>
          </label>
          <div class="ie-list">
            <label v-for="a in automations" :key="a.id" class="ie-row">
              <input type="checkbox" :checked="selected.has(a.id)" @change="toggle(a.id)" />
              <span class="ie-name">{{ displayName(a) }}</span>
            </label>
          </div>
        </template>
      </div>

      <div class="ie-foot">
        <span v-if="automations.length > 0" class="ie-count">
          {{
            t('automation.importExport.export.selectedCount', {
              selected: selected.size,
              total: automations.length,
            })
          }}
        </span>
        <div class="ie-foot-actions">
          <button class="ie-btn" @click="emit('close')">
            {{ t('automation.importExport.export.cancel') }}
          </button>
          <button
            class="ie-btn ie-btn-primary"
            :disabled="selected.size === 0"
            @click="confirmExport"
          >
            {{ t('automation.importExport.export.confirm') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ie-overlay {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  padding: var(--sp-4);
}
.ie-modal {
  width: min(520px, 100%);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--c-panel);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.ie-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--c-border);
}
.ie-head h2 {
  font-size: var(--fs-title-sm);
  font-weight: 600;
  margin: 0;
}
.ie-icon-btn {
  background: transparent;
  border: 0;
  color: var(--c-text-muted);
  cursor: pointer;
  font-size: var(--fs-body);
}
.ie-icon-btn:hover {
  color: var(--c-text);
}
.ie-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.ie-desc,
.ie-empty {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  margin: 0;
}
.ie-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ie-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.ie-row:hover {
  background: var(--c-hover);
}
.ie-row-all {
  border-bottom: 1px solid var(--c-border);
  font-weight: 500;
}
.ie-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-body);
}
.ie-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-top: 1px solid var(--c-border);
}
.ie-count {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
}
.ie-foot-actions {
  display: flex;
  gap: var(--sp-2);
  margin-left: auto;
}
.ie-btn {
  padding: 4px 12px;
  color: var(--c-text);
  background: var(--c-input);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.ie-btn:hover:not(:disabled) {
  background: var(--c-hover);
}
.ie-btn-primary {
  color: #fff;
  background: var(--c-primary);
  border-color: var(--c-primary);
}
.ie-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
