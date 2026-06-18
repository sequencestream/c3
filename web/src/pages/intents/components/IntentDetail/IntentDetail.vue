<script setup lang="ts">
/*
 * IntentDetail.vue — 需求页右栏:选中意图的完整详情面板。
 *
 * 由 Intents.vue 在 intents tab 下渲染,展示 selectedIntentId 对应意图的全部信息:
 * 标题/状态头、内容 markdown、Git/PR 扩展元信息、依赖编辑器,以及行内操作
 * (refine / start-dev / open-dev / set-status / set-automate / create-pr)。
 * 这些内容整体迁自原 IntentList 的行内展开区,emit 事件契约保持不变。
 * 列表为空(无选中意图)时渲染空态。
 */
import { computed, ref, watch } from 'vue'
import type { DepType, Intent, IntentPrStatus, IntentStatus } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'
import MarkdownText from '../../../../components/MarkdownText/MarkdownText.vue'
import {
  formatDate,
  formatDependsOn,
  reqRunStatusLabel,
  showRunStatus,
  statusLabel,
} from '../../../../lib/intent-list-view'

const { t, locale } = useTypedI18n()

const props = defineProps<{
  /** 当前选中的意图;null 表示无选中(列表为空)→ 渲染空态。 */
  intent: Intent | null
  /** 全量意图列表,用于依赖标题查询与未完成依赖判定。 */
  intents: Intent[]
  /** 服务端动作错误序号自增时复位 start-dev in-flight 守卫。 */
  intentActionErrorSeq?: number
  /** 当前 workspace 的 SDD 总开关,驱动主操作按钮四态(关→Start Dev)。 */
  sddEnabled?: boolean
}>()

const emit = defineEmits<{
  refine: [intentId: string]
  'write-spec': [intentId: string]
  'approve-spec': [intentId: string]
  'start-dev': [intentId: string, hasUnfinishedDeps: boolean]
  'open-dev': [sessionId: string]
  'set-status': [intentId: string, status: IntentStatus]
  'set-automate': [intentId: string, automate: boolean]
  'create-pr': [intentId: string]
  'update-deps': [intentId: string, deps: { dependsOnId: string; depType: DepType }[]]
}>()

function copyPrId(prId: string): void {
  void navigator.clipboard.writeText(prId)
}

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

// ── Dep edit modal ──────────────────────────────────────────────────────────
const editingIntentId = ref<string | null>(null)
const editingDeps = ref<{ dependsOnId: string; depType: DepType }[]>([])

function depTitle(dependsOnId: string): string {
  return titleById.value[dependsOnId] ?? dependsOnId
}

function openDepEdit(r: Intent): void {
  editingIntentId.value = r.id
  const types = r.dependsOnTypes ?? {}
  editingDeps.value = r.dependsOn.map((id) => ({
    dependsOnId: id,
    depType: types[id] ?? 'blocks',
  }))
}

function closeDepEdit(): void {
  editingIntentId.value = null
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
  if (!r) return []
  const byId = new Map(props.intents.map((x) => [x.id, x]))
  return r.dependsOn
    .map((id) => byId.get(id))
    .filter((x): x is Intent => !!x && x.status !== 'done')
})

// ── start-dev in-flight 守卫 ────────────────────────────────────────────────
// 详情面板只承载单个意图,守卫退化为一个布尔;选中意图切换/状态离开 todo/
// 服务端动作报错时复位。
const startDevInFlight = ref(false)

watch(
  () => props.intent?.id,
  () => {
    startDevInFlight.value = false
  },
)
watch(
  () => props.intent?.status,
  (s) => {
    if (s !== 'todo') startDevInFlight.value = false
  },
)
watch(
  () => props.intentActionErrorSeq,
  (next, prev) => {
    if (next !== prev) startDevInFlight.value = false
  },
)

function startDev(): void {
  const r = props.intent
  if (!r || startDevInFlight.value) return
  const hasUnfinishedDeps = unfinishedDeps.value.length > 0
  if (hasUnfinishedDeps && !window.confirm(t('intent.startDev.confirmUnfinishedDeps'))) return
  startDevInFlight.value = true
  emit('start-dev', r.id, hasUnfinishedDeps)
}

// ── 主操作按钮四态机(只对 todo 意图渲染) ──────────────────────────────────
// SDD 关 → Start Dev;SDD 开且无 spec → Write Spec;有 spec 未批准 → Approve Spec;
// 有 spec 已批准 → Start Dev。是「人工审批检查点」的入口:开发须经人点 approve。
type MainAction = 'startDev' | 'writeSpec' | 'approveSpec'
const mainAction = computed<MainAction>(() => {
  const r = props.intent
  if (!r || !props.sddEnabled) return 'startDev'
  if (!r.specPath) return 'writeSpec'
  if (!r.specApproved) return 'approveSpec'
  return 'startDev'
})
const mainActionLabel = computed<string>(() => {
  switch (mainAction.value) {
    case 'writeSpec':
      return t('intent.action.writeSpec.label')
    case 'approveSpec':
      return t('intent.action.approveSpec.label')
    default:
      return t('intent.action.startDev.label')
  }
})
function onMainAction(): void {
  const r = props.intent
  if (!r) return
  if (mainAction.value === 'writeSpec') {
    emit('write-spec', r.id)
    return
  }
  if (mainAction.value === 'approveSpec') {
    emit('approve-spec', r.id)
    return
  }
  startDev()
}

// 标题前的 MM/DD 日期前缀:已完成项取 completedAt,否则取 createdAt。
function datePrefix(r: Intent): string {
  return formatDate(r.completedAt ?? r.createdAt, locale.value, { style: 'short' })
}
</script>

<template>
  <section class="intent-detail" data-testid="intent-detail">
    <p v-if="!intent" class="intent-detail-empty" data-testid="intent-detail-empty">
      {{ t('intent.list.empty') }}
    </p>
    <template v-else>
      <header class="intent-detail-head">
        <div class="intent-detail-head-row">
          <span class="req-priority" :class="intent.priority">{{ intent.priority }}</span>
          <span class="req-date">{{ datePrefix(intent) }}</span>
          <span v-if="intent.module" class="req-module" :title="intent.module">{{
            intent.module
          }}</span>
          <span class="req-status" :class="intent.status">{{ statusLabel(intent.status) }}</span>
          <span
            v-if="showRunStatus(intent.runStatus)"
            class="req-run-status"
            :class="intent.runStatus"
            >{{ reqRunStatusLabel(intent.runStatus) }}</span
          >
        </div>
        <h2 class="intent-detail-title" :title="intent.content">{{ intent.title }}</h2>
      </header>

      <div class="intent-detail-body">
        <div class="req-detail">
          <MarkdownText :text="intent.content" markdown />
        </div>
        <div class="req-meta">
          <span class="req-meta-item"
            >{{ t('intent.meta.created.label') }} {{ formatDate(intent.createdAt, locale) }}</span
          >
          <span v-if="intent.completedAt" class="req-meta-item"
            >{{ t('intent.meta.completed.label') }}
            {{ formatDate(intent.completedAt, locale) }}</span
          >
          <span v-if="formatDependsOn(intent, props.intents).length" class="req-meta-item">
            {{ t('intent.meta.dependsOn.label') }}
            <span
              v-for="(dep, di) in formatDependsOn(intent, props.intents)"
              :key="dep.id"
              :class="dep.done ? 'req-dep-done' : 'req-dep-pending'"
            >
              <span v-if="di > 0">, </span>{{ dep.title }}
              <span class="req-dep-type-badge" :class="'dep-type--' + dep.depType">{{
                depTypeLabel(dep.depType)
              }}</span>
              <span v-if="!dep.done"> ⚠</span>
            </span>
            <button
              type="button"
              class="req-btn req-dep-edit-btn"
              :title="t('intent.deps.depType.edit.tooltip')"
              @click.stop="openDepEdit(intent)"
            >
              {{ t('intent.deps.depType.edit.label') }}
            </button>
          </span>
          <span class="req-meta-item"
            >{{ t('intent.meta.updated.label') }} {{ formatDate(intent.updatedAt, locale) }}</span
          >
          <span v-if="intent.branchName" class="req-meta-item">
            {{ t('intent.meta.branch.label') }} {{ intent.branchName
            }}<span v-if="intent.latestCommitHash">
              · {{ intent.latestCommitHash.slice(0, 7) }}</span
            >
          </span>
          <span v-if="intent.prId" class="req-meta-item">
            {{ t('intent.meta.pr.label') }} #{{ intent.prId }}
            <span
              v-if="intent.prStatus"
              class="req-pr-status"
              :class="'req-pr-status--' + intent.prStatus"
              >{{ prStatusLabel(intent.prStatus) }}</span
            >
          </span>
        </div>
        <div
          v-if="unfinishedDeps.length"
          class="req-deps"
          :title="t('intent.deps.unfinished.tooltip')"
        >
          {{
            t('intent.deps.unfinishedList', {
              list: unfinishedDeps.map((d) => titleById[d.id] ?? d.id).join(', '),
            })
          }}
        </div>
      </div>

      <div class="intent-detail-actions">
        <button v-if="intent.status === 'todo'" class="req-btn" @click="emit('refine', intent.id)">
          {{ t('intent.action.refine.label') }}
        </button>
        <button
          v-if="intent.status === 'todo'"
          class="req-btn primary"
          :data-action="mainAction"
          :disabled="mainAction === 'startDev' && startDevInFlight"
          @click="onMainAction"
        >
          {{ mainActionLabel }}
        </button>
        <button
          v-if="intent.lastDevSessionId"
          class="req-btn"
          @click="emit('open-dev', intent.lastDevSessionId as string)"
        >
          {{ t('intent.action.session.label') }}
        </button>
        <button
          v-if="intent.status !== 'done' && intent.status !== 'cancelled'"
          class="req-btn"
          @click="emit('set-status', intent.id, 'done')"
        >
          {{ t('intent.action.markDone.label') }}
        </button>
        <button
          v-if="intent.status !== 'done' && intent.status !== 'cancelled'"
          class="req-btn"
          @click="emit('set-status', intent.id, 'cancelled')"
        >
          {{ t('common.action.cancel.label') }}
        </button>
        <button
          v-if="intent.status === 'done' && !intent.prId"
          class="req-btn primary"
          @click="emit('create-pr', intent.id)"
        >
          {{ t('intent.action.createPr.label') }}
        </button>
        <button
          v-if="intent.prId"
          class="req-btn pr-link"
          :title="t('intent.action.pr.tooltip')"
          @click="copyPrId(intent.prId as string)"
        >
          {{ t('intent.action.pr.label', { id: intent.prId }) }}
        </button>
        <button
          type="button"
          class="req-automate"
          :class="{ active: intent.automate }"
          :title="
            intent.automate
              ? t('intent.automate.queued.tooltip')
              : t('intent.automate.manual.tooltip')
          "
          :aria-pressed="intent.automate"
          @click="emit('set-automate', intent.id, !intent.automate)"
        >
          {{ intent.automate ? '⏳' : '✋' }}
        </button>
      </div>
    </template>

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
          <div v-for="(dep, i) in editingDeps" :key="dep.dependsOnId" class="dep-edit-row">
            <span class="dep-edit-dep-title">{{ depTitle(dep.dependsOnId) }}</span>
            <select v-model="editingDeps[i].depType" class="dep-edit-select">
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
  </section>
</template>

<style scoped>
.intent-detail {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--c-bg);
}
.intent-detail-empty {
  margin: auto;
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: var(--sp-3);
  text-align: center;
}
.intent-detail-head {
  flex-shrink: 0;
  padding: var(--sp-3) var(--sp-3) var(--sp-2);
  border-bottom: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.intent-detail-head-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.intent-detail-title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 600;
  line-height: var(--lh-tight);
  color: var(--c-text);
  word-break: break-word;
}
.intent-detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-3);
}
.intent-detail-actions {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  border-top: 1px solid var(--c-border);
}
</style>
