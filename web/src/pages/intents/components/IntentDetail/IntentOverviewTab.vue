<script setup lang="ts">
/*
 * IntentOverviewTab.vue — intent tab:元信息(顶部) + 正文 markdown / 直接编辑 + 依赖明细。
 *
 * 元信息按稳定顺序渲染:ID → 分支(+commit) → PR(链接/状态/同步) → 已创建 → 已完成 →
 * 已更新 → 依赖。正文仅 draft/todo 可直接编辑:草稿只活在组件内,保存只 emit,退出编辑态由
 * 服务端回填(updatedAt 变化)驱动;被拒(intentActionErrorSeq 自增)释放保存守卫但保留草稿;
 * 切换意图丢弃未保存草稿。依赖逐行显示完成态/类型,单条类型编辑仍整组回写。
 */
import { computed, ref, watch } from 'vue'
import type { DepType, Intent, IntentPrStatus } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import MarkdownText from '../../../../components/MarkdownText/MarkdownText.vue'
import { formatDate, formatDependsOn } from '../../../../lib/intent-list-view'

const { t, locale } = useTypedI18n()

const props = defineProps<{
  intent: Intent
  intents: Intent[]
  intentActionErrorSeq?: number
  intentPrSync?: Record<string, { state: 'syncing' | 'success' | 'error'; message: string }>
}>()

const emit = defineEmits<{
  refine: [intentId: string]
  'save-intent-content': [intentId: string, content: string]
  'update-deps': [intentId: string, deps: { dependsOnId: string; depType: DepType }[]]
  'select-dependency': [intentId: string]
  'sync-pr-status': [intentId: string]
}>()

// ── Dep type / PR status 标签 ───────────────────────────────────────────────
const DEP_TYPE_OPTIONS: { value: DepType; label: string }[] = [
  { value: 'blocks', label: t('intent.deps.depType.types.blocks') },
  { value: 'informs', label: t('intent.deps.depType.types.informs') },
  { value: 'soft_after', label: t('intent.deps.depType.types.softAfter') },
]
function depTypeLabel(dt: DepType): string {
  return DEP_TYPE_OPTIONS.find((o) => o.value === dt)?.label ?? dt
}

const PR_STATUS_OPTIONS: { value: IntentPrStatus; label: string }[] = [
  { value: 'reviewing', label: t('intent.prStatus.reviewing.label') },
  { value: 'rejected', label: t('intent.prStatus.rejected.label') },
  { value: 'failed', label: t('intent.prStatus.failed.label') },
  { value: 'merged', label: t('intent.prStatus.merged.label') },
  { value: 'closed', label: t('intent.prStatus.closed.label') },
]
function prStatusLabel(ps: IntentPrStatus): string {
  return PR_STATUS_OPTIONS.find((o) => o.value === ps)?.label ?? ps
}

// ── 标题查询(依赖 id → 意图标题) ──────────────────────────────────────────
const titleById = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const r of props.intents) out[r.id] = r.title
  return out
})

// ── PR 同步(元信息 PR 行) ──────────────────────────────────────────────────
const canSyncPrStatus = computed<boolean>(() => {
  const r = props.intent
  return r.status === 'done' && !!r.prId && r.prStatus === 'reviewing'
})
const currentPrSync = computed(() => props.intentPrSync?.[props.intent.id])
const prSyncInFlight = computed<boolean>(() => currentPrSync.value?.state === 'syncing')
function syncPrStatus(): void {
  if (!canSyncPrStatus.value || prSyncInFlight.value) return
  emit('sync-pr-status', props.intent.id)
}

// ── Dep edit modal ──────────────────────────────────────────────────────────
const editingIntentId = ref<string | null>(null)
const editingDepId = ref<string | null>(null)
const editingDeps = ref<{ dependsOnId: string; depType: DepType }[]>([])

const editingDepType = computed<DepType>({
  get: () =>
    editingDeps.value.find((dep) => dep.dependsOnId === editingDepId.value)?.depType ?? 'blocks',
  set: (depType) => {
    const dep = editingDeps.value.find((item) => item.dependsOnId === editingDepId.value)
    if (dep) dep.depType = depType
  },
})

const dependencyInfos = computed(() => formatDependsOn(props.intent, props.intents))

function depTitle(dependsOnId: string): string {
  return titleById.value[dependsOnId] ?? dependsOnId
}

function openDepEdit(r: Intent, dependsOnId: string): void {
  editingIntentId.value = r.id
  editingDepId.value = dependsOnId
  const types = r.dependsOnTypes ?? {}
  editingDeps.value = r.dependsOn.map((id) => ({
    dependsOnId: id,
    depType: types[id] ?? 'blocks',
  }))
}

function closeDepEdit(): void {
  editingIntentId.value = null
  editingDepId.value = null
  editingDeps.value = []
}

function saveDepEdit(): void {
  if (!editingIntentId.value) return
  emit('update-deps', editingIntentId.value, editingDeps.value)
  closeDepEdit()
}

// ── 未完成依赖(非 done 的前置意图) ───────────────────────────────────────
const unfinishedDeps = computed<Intent[]>(() => {
  const r = props.intent
  const byId = new Map(props.intents.map((x) => [x.id, x]))
  return r.dependsOn
    .map((id) => byId.get(id))
    .filter((x): x is Intent => !!x && x.status !== 'done')
})

// ── 正文直接编辑(仅 draft / todo,服务端为最终门禁) ───────────────────────
// 编辑态与草稿只活在组件内,不写入全局 intent;保存只 emit,退出编辑态由服务端
// 回填(intent.updatedAt 变化)驱动,契合「后写覆盖、无锁」语义。
const editingContent = ref(false)
const contentDraft = ref('')
const savingContent = ref(false)

// 仅 draft / todo 显示「编辑」入口;其它状态既不显示按钮,服务端也拒绝其编辑请求。
const canEditContent = computed<boolean>(() => {
  const s = props.intent.status
  return s === 'draft' || s === 'todo'
})

function startEditContent(): void {
  if (!canEditContent.value) return
  contentDraft.value = props.intent.content
  savingContent.value = false
  editingContent.value = true
}

function cancelEditContent(): void {
  // 丢弃本地草稿,恢复渲染态。
  editingContent.value = false
  savingContent.value = false
}

function saveEditContent(): void {
  if (savingContent.value) return
  savingContent.value = true
  emit('save-intent-content', props.intent.id, contentDraft.value)
}

// 服务端成功回填最新意图后(updated_at 必然刷新)退出编辑态,展示服务端内容。
// 仅在提交在途(savingContent)时响应,避免其它广播误关编辑框。
watch(
  () => props.intent.updatedAt,
  () => {
    if (savingContent.value) {
      savingContent.value = false
      editingContent.value = false
    }
  },
)

// 服务端拒绝任一 intent.* 动作(intentActionErrorSeq 自增)释放保存守卫,让被拒的直接编辑
// 退出「保存中」态(按钮重新可点),编辑框保留草稿供重试。
watch(
  () => props.intentActionErrorSeq,
  (next, prev) => {
    if (next !== prev) savingContent.value = false
  },
)

// 切走意图:丢弃未保存的正文草稿并退出编辑态,避免草稿串到别的意图。
watch(
  () => props.intent.id,
  () => {
    editingContent.value = false
    savingContent.value = false
  },
)
</script>

<template>
  <div class="intent-detail-body" data-testid="tab-intent">
    <div class="req-meta">
      <span class="req-meta-item">{{ t('intent.meta.id.label') }} {{ intent.id }}</span>
      <span v-if="intent.branchName" class="req-meta-item">
        {{ t('intent.meta.branch.label') }} {{ intent.branchName
        }}<span v-if="intent.latestCommitHash"> · {{ intent.latestCommitHash.slice(0, 7) }}</span>
      </span>
      <span v-if="intent.prId" class="req-meta-item">
        {{ t('intent.meta.pr.label') }}
        <a
          v-if="intent.prUrl"
          class="req-meta-pr-link"
          :href="intent.prUrl"
          target="_blank"
          rel="noopener noreferrer"
          :title="t('intent.action.pr.open.tooltip')"
          >#{{ intent.prId }}</a
        >
        <template v-else>#{{ intent.prId }}</template>
        <span
          v-if="intent.prStatus"
          class="req-pr-status"
          :class="'req-pr-status--' + intent.prStatus"
          >{{ prStatusLabel(intent.prStatus) }}</span
        >
        <button
          v-if="canSyncPrStatus"
          type="button"
          class="req-btn req-pr-sync-btn"
          :disabled="prSyncInFlight"
          @click="syncPrStatus"
        >
          {{ prSyncInFlight ? t('intent.prSync.syncing') : t('intent.prSync.label') }}
        </button>
        <span
          v-if="currentPrSync"
          class="req-pr-sync-feedback"
          :class="'req-pr-sync-feedback--' + currentPrSync.state"
          >{{ currentPrSync.message }}</span
        >
      </span>
      <span class="req-meta-item"
        >{{ t('intent.meta.created.label') }} {{ formatDate(intent.createdAt, locale) }}</span
      >
      <span v-if="intent.completedAt" class="req-meta-item"
        >{{ t('intent.meta.completed.label') }} {{ formatDate(intent.completedAt, locale) }}</span
      >
      <span class="req-meta-item"
        >{{ t('intent.meta.updated.label') }} {{ formatDate(intent.updatedAt, locale) }}</span
      >
      <div v-if="dependencyInfos.length" class="req-meta-item req-meta-dependencies">
        {{ t('intent.meta.dependsOn.label') }}
        <div
          v-for="dep in dependencyInfos"
          :key="dep.id"
          class="req-dependency-row"
          :class="dep.done ? 'req-dep-done' : 'req-dep-pending'"
        >
          <button
            type="button"
            class="req-dependency-title"
            @click="emit('select-dependency', dep.id)"
          >
            {{ dep.title }}
          </button>
          <span class="req-dep-status">{{
            dep.done ? t('intent.deps.status.done') : t('intent.deps.status.pending')
          }}</span>
          <span class="req-dep-type-badge" :class="'dep-type--' + dep.depType">{{
            depTypeLabel(dep.depType)
          }}</span>
          <button
            type="button"
            class="req-btn req-dep-edit-btn"
            :title="t('intent.deps.depType.edit.tooltip')"
            @click="openDepEdit(intent, dep.id)"
          >
            {{ t('intent.deps.depType.edit.label') }}
          </button>
        </div>
      </div>
    </div>
    <div
      v-if="!editingContent && (intent.status === 'todo' || canEditContent)"
      class="intent-detail-section-actions"
    >
      <button v-if="intent.status === 'todo'" class="req-btn" @click="emit('refine', intent.id)">
        {{ t('intent.action.refine.label') }}
      </button>
      <button
        v-if="canEditContent"
        type="button"
        class="req-btn"
        data-testid="intent-detail-edit-content"
        @click="startEditContent"
      >
        {{ t('intent.action.editContent.label') }}
      </button>
    </div>
    <div v-if="editingContent" class="req-content-edit" data-testid="intent-detail-content-editor">
      <textarea
        v-model="contentDraft"
        class="req-content-textarea"
        data-testid="intent-detail-content-textarea"
      ></textarea>
      <div class="req-content-edit-actions">
        <button
          type="button"
          class="req-btn primary"
          data-testid="intent-detail-content-save"
          :disabled="savingContent"
          @click="saveEditContent"
        >
          {{ t('common.action.save.label') }}
        </button>
        <button
          type="button"
          class="req-btn"
          data-testid="intent-detail-content-cancel"
          @click="cancelEditContent"
        >
          {{ t('common.action.cancel.label') }}
        </button>
      </div>
    </div>
    <div v-else class="req-detail">
      <MarkdownText :text="intent.content" markdown />
    </div>
    <div v-if="unfinishedDeps.length" class="req-deps" :title="t('intent.deps.unfinished.tooltip')">
      {{
        t('intent.deps.unfinishedList', {
          list: unfinishedDeps.map((d) => titleById[d.id] ?? d.id).join(', '),
        })
      }}
    </div>
  </div>

  <!-- Dep edit modal -->
  <div v-if="editingIntentId" class="dep-edit-overlay" @click.self="closeDepEdit">
    <div class="dep-edit-modal">
      <div class="dep-edit-header">
        <span class="dep-edit-title">{{ t('intent.deps.depType.edit.title') }}</span>
        <button type="button" class="dep-edit-close" @click="closeDepEdit">✕</button>
      </div>
      <div class="dep-edit-body">
        <div v-if="editingDeps.length === 0" class="dep-edit-empty">
          {{ t('intent.deps.depType.edit.noDeps') }}
        </div>
        <div v-if="editingDepId" class="dep-edit-row">
          <span class="dep-edit-dep-title">{{ depTitle(editingDepId) }}</span>
          <select v-model="editingDepType" class="dep-edit-select">
            <option v-for="opt in DEP_TYPE_OPTIONS" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>
      </div>
      <div class="dep-edit-footer">
        <button type="button" class="dep-edit-cancel" @click="closeDepEdit">
          {{ t('common.action.cancel.label') }}
        </button>
        <button type="button" class="dep-edit-save" @click="saveDepEdit">
          {{ t('common.action.save.label') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.intent-detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-3);
}
.intent-detail-section-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}
/* 正文直接编辑:纯文本 markdown 源码框 + 框下方左侧的保存/取消动作区。 */
.req-content-edit {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.req-content-textarea {
  width: 100%;
  min-height: 240px;
  box-sizing: border-box;
  resize: vertical;
  padding: var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: var(--c-bg);
  color: var(--c-text);
  font-family: var(--font-mono, monospace);
  font-size: var(--fs-caption);
  line-height: var(--lh-normal, 1.5);
}
.req-content-edit-actions {
  display: flex;
  justify-content: flex-start;
  gap: var(--sp-2);
}
</style>
