<script setup lang="ts">
/**
 * AutomationImportDialog.vue — 导入弹框。
 *
 * 选择文件 → 经纯函数编解码层解析 + 文件级校验 → 列出文件内自动化(每条可勾选,默认
 * 全选,不可导入项灰显并给出原因)→ 确认后把选中且可导入项一律新建到当前 workspace
 * (initialStatus=paused)。文件级校验失败仅显示 i18n 错误,确认前不发任何写消息。
 */
import { computed, ref, watch } from 'vue'
import type { AgentConfig, CreateAutomationInput } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import {
  mapImportCandidates,
  parseImportFile,
  type ImportCandidate,
  type ImportErrorKey,
} from '@/pages/automations/import-export'

const { t } = useTypedI18n()

const props = defineProps<{
  open: boolean
  agents: AgentConfig[]
  workspacePath: string
}>()

const emit = defineEmits<{
  close: []
  confirm: [inputs: CreateAutomationInput[]]
}>()

const fileInput = ref<HTMLInputElement | null>(null)
const errorKey = ref<ImportErrorKey | null>(null)
const parsed = ref(false)
const candidates = ref<ImportCandidate[]>([])
const selected = ref<Set<number>>(new Set())
const submitting = ref(false)

function reset(): void {
  errorKey.value = null
  parsed.value = false
  candidates.value = []
  selected.value = new Set()
  submitting.value = false
  if (fileInput.value) fileInput.value.value = ''
}

watch(
  () => props.open,
  (open) => {
    if (open) reset()
  },
  { immediate: true },
)

const importableIndices = computed(() =>
  candidates.value.map((c, i) => (c.importable ? i : -1)).filter((i) => i >= 0),
)
const importableCount = computed(() => importableIndices.value.length)
const blockedCount = computed(() => candidates.value.length - importableCount.value)
const allSelected = computed(
  () => importableCount.value > 0 && selected.value.size === importableCount.value,
)

function pickFile(): void {
  fileInput.value?.click()
}

async function onFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const text = await file.text()
  const result = parseImportFile(text)
  if (!result.ok) {
    errorKey.value = result.errorKey
    parsed.value = false
    candidates.value = []
    selected.value = new Set()
    return
  }
  errorKey.value = null
  candidates.value = mapImportCandidates(result.automations, {
    workspaceId: props.workspacePath,
    agents: props.agents,
  })
  // Default-select every importable item.
  selected.value = new Set(importableIndices.value)
  parsed.value = true
}

function toggle(index: number): void {
  const next = new Set(selected.value)
  if (next.has(index)) next.delete(index)
  else next.add(index)
  selected.value = next
}

function toggleAll(): void {
  selected.value = allSelected.value ? new Set() : new Set(importableIndices.value)
}

function confirmImport(): void {
  if (submitting.value || selected.value.size === 0) return
  submitting.value = true
  const inputs = candidates.value
    .filter(
      (c, i): c is Extract<ImportCandidate, { importable: true }> =>
        c.importable && selected.value.has(i),
    )
    .map((c) => c.input)
  emit('confirm', inputs)
}
</script>

<template>
  <div v-if="open" class="ie-overlay" @click.self="emit('close')">
    <div
      class="ie-modal"
      role="dialog"
      aria-modal="true"
      :aria-label="t('automation.importExport.import.title')"
    >
      <div class="ie-head">
        <h2>{{ t('automation.importExport.import.title') }}</h2>
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
        <input
          ref="fileInput"
          type="file"
          accept="application/json,.json"
          class="ie-file-hidden"
          @change="onFileChange"
        />

        <template v-if="!parsed">
          <p class="ie-desc">{{ t('automation.importExport.import.fileHint') }}</p>
          <button class="ie-btn" @click="pickFile">
            {{ t('automation.importExport.import.pickFile') }}
          </button>
          <p v-if="errorKey" class="ie-error" role="alert">
            {{ t(`automation.importExport.error.${errorKey}`) }}
          </p>
        </template>

        <template v-else>
          <p v-if="candidates.length === 0" class="ie-empty">
            {{ t('automation.importExport.import.empty') }}
          </p>
          <template v-else>
            <p class="ie-note">{{ t('automation.importExport.import.pausedNote') }}</p>
            <label v-if="importableCount > 0" class="ie-row ie-row-all">
              <input type="checkbox" :checked="allSelected" @change="toggleAll" />
              <span class="ie-name">{{ t('automation.importExport.import.selectAll') }}</span>
            </label>
            <div class="ie-list">
              <label
                v-for="(c, i) in candidates"
                :key="i"
                class="ie-row"
                :class="{ 'ie-row-blocked': !c.importable }"
              >
                <input
                  type="checkbox"
                  :checked="c.importable && selected.has(i)"
                  :disabled="!c.importable"
                  @change="toggle(i)"
                />
                <span class="ie-name">{{ c.name }}</span>
                <span v-if="!c.importable" class="ie-reason">
                  {{ t(`automation.importExport.import.reason.${c.reasonKey}`) }}
                </span>
              </label>
            </div>
          </template>
        </template>
      </div>

      <div class="ie-foot">
        <span v-if="parsed && candidates.length > 0" class="ie-count">
          {{
            t('automation.importExport.import.selectedCount', {
              selected: selected.size,
              total: importableCount,
            })
          }}
          <template v-if="blockedCount > 0"> · {{ blockedCount }} ⚠</template>
        </span>
        <div class="ie-foot-actions">
          <button class="ie-btn" @click="emit('close')">
            {{ t('automation.importExport.import.cancel') }}
          </button>
          <button
            v-if="parsed && candidates.length > 0"
            class="ie-btn ie-btn-primary"
            :disabled="selected.size === 0 || submitting"
            @click="confirmImport"
          >
            {{
              submitting
                ? t('automation.importExport.import.importing')
                : t('automation.importExport.import.confirm')
            }}
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
  align-items: flex-start;
}
.ie-file-hidden {
  display: none;
}
.ie-desc,
.ie-empty,
.ie-note {
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  margin: 0;
}
.ie-error {
  color: var(--c-error);
  font-size: var(--fs-caption);
  margin: 0;
}
.ie-list {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ie-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
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
.ie-row-blocked {
  cursor: not-allowed;
  opacity: 0.7;
}
.ie-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-body);
}
.ie-reason {
  flex-shrink: 0;
  color: var(--c-warning);
  font-size: var(--fs-caption);
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
