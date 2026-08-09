<script setup lang="ts">
/*
 * IntentOverviewTab.vue — intent tab:元信息(顶部) + 正文 markdown / 直接编辑 + 依赖明细。
 *
 * 元信息按稳定顺序渲染:ID → 是否需要规范 → 分支(+commit) → 关联交付 → PR(按交付分组;
 * 链接/状态/同步)→ 已创建 → 已完成 → 已更新 → 依赖。「是否需要规范」是意图自身的配置,
 * 排在 git / 交付 / PR 这些既成事实与时间戳之前。「关联交付」必须排在 PR 之前:交付决定 PR 提向
 * 哪条分支,先因后果读下来才成立。「关联交付」行在恰好关联 1 个交付时于交付名之后给出
 * 「解除关联」(意图侧唯一入口,标题栏不再重复):danger ConfirmDialog 二次确认,文案点明会关闭该意图
 * 提向此交付的 PR,确认后 emit unlink-delivery 上抛;多关联只展示交付名,不给解除路径——目标不唯一
 * 时交互层不替用户选。是否真能解除由服务端复核(merged 禁解等),本页不设门禁。
 * 正文仅 draft/todo 可直接编辑:草稿只活在组件内,保存只 emit,退出编辑态由
 * 服务端回填(updatedAt 变化)驱动;被拒(intentActionErrorSeq 自增)释放保存守卫但保留草稿;
 * 切换意图丢弃未保存草稿。依赖逐行显示完成态/类型,单条类型编辑仍整组回写;
 * 编辑弹窗内可删除单条依赖(ConfirmDialog 危险二次确认,确认后剔除该项并整组回写剩余集)。
 */
import { computed, ref, watch } from 'vue'
import type {
  DepType,
  Intent,
  IntentPr,
  IntentPrStatus,
  IntentSpecMode,
} from '@ccc/shared/protocol'
import { canEditIntentSpecMode } from '@ccc/shared'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import { useTypedI18n } from '@/i18n'
import MarkdownText from '../../../../components/MarkdownText/MarkdownText.vue'
import { formatDate, formatDependsOn } from '../../../../lib/intent-list-view'

const { t, locale } = useTypedI18n()

const props = defineProps<{
  intent: Intent
  intents: Intent[]
  intentActionErrorSeq?: number
  intentPrSync?: Record<string, { state: 'syncing' | 'success' | 'error'; message: string }>
  /** 工作区 SDD 总开关;仅用于「关闭时无行为差异」的提示文案,不参与派生(派生值由服务端给)。 */
  sddEnabled?: boolean
}>()

const emit = defineEmits<{
  refine: [intentId: string]
  'save-intent-content': [intentId: string, content: string]
  /** 每意图规格模式覆盖:`null` = 恢复继承工作区。选择即保存,由服务端广播回填。 */
  'set-spec-mode': [intentId: string, mode: IntentSpecMode | null]
  'update-deps': [intentId: string, deps: { dependsOnId: string; depType: DepType }[]]
  'select-dependency': [intentId: string]
  'sync-pr-status': [intentId: string]
  'open-delivery': [deliveryId: string]
  'unlink-delivery': [workspaceId: string, deliveryId: string, intentId: string]
}>()

// ── 关联交付:解除入口(自持确认框) ─────────────────────────────────────────
// 只有恰好 1 条关联时才有唯一目标,才给解除路径。
const linkedDelivery = computed(() =>
  props.intent.linkedDeliveries.length === 1 ? props.intent.linkedDeliveries[0] : null,
)

const unlinkDialogOpen = ref(false)

function confirmUnlink(): void {
  const target = linkedDelivery.value
  unlinkDialogOpen.value = false
  if (target) emit('unlink-delivery', props.intent.workspaceId, target.id, props.intent.id)
}

// 关联条数在确认框敞开期间被别处改掉(关联/解除的广播)时收框,避免对着已不成立的前提确认。
watch(
  () => props.intent.linkedDeliveries.length,
  (count) => {
    if (count !== 1) unlinkDialogOpen.value = false
  },
)

// ── 是否需要规范(每意图 specMode 覆盖) ───────────────────────────────────
// 三档:继承工作区(specMode=null)/ 需要规范(sdd)/ 不需要规范(fast)。选择即保存,
// 与 set-automate 同语义:只 emit,不本地改值,成功由 intents 广播回填;被拒时开关自然
// 停在服务端的旧值上,不会留下一个假的选中态。
// 派生值一律直接读服务端算好的 effectiveSpecMode,本地不重算,避免两层推导给出不同答案。
const SPEC_MODE_INHERIT = 'inherit' as const
type SpecModeChoice = typeof SPEC_MODE_INHERIT | IntentSpecMode

const SPEC_MODE_OPTIONS: { value: SpecModeChoice; label: string }[] = [
  { value: SPEC_MODE_INHERIT, label: t('intent.meta.specMode.option.inherit') },
  { value: 'sdd', label: t('intent.meta.specMode.option.sdd') },
  { value: 'fast', label: t('intent.meta.specMode.option.fast') },
]

const specModeChoice = computed<SpecModeChoice>(() => props.intent.specMode ?? SPEC_MODE_INHERIT)

function specModeLabel(mode: IntentSpecMode): string {
  return mode === 'sdd'
    ? t('intent.meta.specMode.option.sdd')
    : t('intent.meta.specMode.option.fast')
}

// 规范或开发一旦起步,这个决策就再无意义(切换既不撤销已批准的规范,也不回滚已跑完的开发),
// 于是锁定为只读。判据是 shared 里的同一个纯函数,服务端 handler 也调它——UI 收起入口,
// handler 兜住直连 WS 与过期页签,两处必须给出同一答案。
const canEditSpecMode = computed(() => canEditIntentSpecMode(props.intent))

/** 锁定态展示的那一档:显式覆盖读 specMode,继承态读「继承工作区」。 */
const specModeReadonlyLabel = computed(() =>
  props.intent.specMode === null
    ? t('intent.meta.specMode.option.inherit')
    : specModeLabel(props.intent.specMode),
)

/** 继承态下的副标:说明当前实际生效的是哪一档。显式覆盖时该行没有信息量,不渲染。 */
const specModeDerivedHint = computed<string | null>(() =>
  props.intent.specMode === null
    ? t('intent.meta.specMode.derived', { mode: specModeLabel(props.intent.effectiveSpecMode) })
    : null,
)

function onSpecModeChange(e: Event): void {
  const next = (e.target as HTMLSelectElement).value as SpecModeChoice
  emit('set-spec-mode', props.intent.id, next === SPEC_MODE_INHERIT ? null : next)
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
  { value: 'closed', label: t('intent.prStatus.closed.label') },
]
function prStatusLabel(ps: IntentPrStatus): string {
  return PR_STATUS_OPTIONS.find((o) => o.value === ps)?.label ?? ps
}

// ── PR 按交付分组 ───────────────────────────────────────────────────────────
// 一个意图对每个交付至多一条 PR,再加上可能存在的一条无交付归属的 PR。分组展示
// 才能回答「这条 PR 提向哪里」——把它们平铺成一串号码,状态就失去了归属。
interface PrGroup {
  /** 交付 id;无交付归属的组为空串(模板 key 用)。 */
  key: string
  /** 交付标题;`null` = 无交付归属组。 */
  title: string | null
  prs: IntentPr[]
}

const prGroups = computed<PrGroup[]>(() => {
  const titleById = new Map(props.intent.linkedDeliveries.map((d) => [d.id, d.title]))
  const groups = new Map<string, PrGroup>()
  for (const pr of props.intent.prs) {
    const key = pr.deliveryId ?? ''
    const existing = groups.get(key)
    if (existing) {
      existing.prs.push(pr)
      continue
    }
    groups.set(key, {
      key,
      // 关联边被删但 PR 行仍在(理论上不会:解除关联会连 PR 行一起删)时退回 id,
      // 也好过静默显示成「无交付归属」。
      title: pr.deliveryId ? (titleById.get(pr.deliveryId) ?? pr.deliveryId) : null,
      prs: [pr],
    })
  }
  return [...groups.values()]
})

// 只有确实存在交付归属(或有多组)时才渲染组标签,避免最常见的「单条无交付 PR」
// 场景平白多出一行噪音。
const showPrGroupLabels = computed<boolean>(
  () => prGroups.value.length > 1 || prGroups.value.some((g) => g.title !== null),
)

// ── 标题查询(依赖 id → 意图标题) ──────────────────────────────────────────
const titleById = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const r of props.intents) out[r.id] = r.title
  return out
})

// ── PR 同步(元信息 PR 行) ──────────────────────────────────────────────────
// 只看"有没有处于 reviewing 的 PR 行",不再要求意图本身是 done——与服务端脱钩后的
// 同步守卫对齐,否则会把一条服务端本可同步的 PR 的按钮灰掉。
const canSyncPrStatus = computed<boolean>(() =>
  props.intent.prs.some((pr) => pr.status === 'reviewing'),
)
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
// 删除依赖二次确认层(渲染在编辑 overlay 子树内,盖住编辑框)。
const confirmDeleteDepOpen = ref(false)

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
  confirmDeleteDepOpen.value = false
  editingIntentId.value = null
  editingDepId.value = null
  editingDeps.value = []
}

function saveDepEdit(): void {
  if (!editingIntentId.value) return
  emit('update-deps', editingIntentId.value, editingDeps.value)
  closeDepEdit()
}

// ── Dep delete(危险操作,ConfirmDialog 二次确认) ───────────────────────────
// 删除入口只打开确认层,不预先改 editingDeps;确认后才剔除当前依赖并经既有
// update-deps 整组回写剩余集(单条删除 = 剩余集回写,复用全量替换协议,
// 删唯一依赖即回写空数组),随后关闭编辑弹窗。取消/遮罩/Esc 只关确认层,
// 编辑弹窗与未保存的类型选择原样保留。
const deleteDepTitle = computed<string>(() =>
  editingDepId.value ? depTitle(editingDepId.value) : '',
)

function requestDeleteDep(): void {
  if (!editingDepId.value) return
  confirmDeleteDepOpen.value = true
}

function confirmDeleteDep(): void {
  if (!editingIntentId.value || !editingDepId.value) return
  const remaining = editingDeps.value.filter((d) => d.dependsOnId !== editingDepId.value)
  confirmDeleteDepOpen.value = false
  emit('update-deps', editingIntentId.value, remaining)
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
      <!-- 是否需要规范:选择即保存。工作区关了 SDD 时不隐藏——隐藏会让用户以为功能没了——
           改为附一句提示说明此时设置不产生行为差异。规范或开发已起步时整行降级为只读文本:
           不隐藏(用户仍要看得到当前是哪一档),也不用 disabled 下拉;只读本身已表达不可改,不再附锁定提示。 -->
      <span class="req-meta-item" data-testid="intent-meta-spec-mode">
        {{ t('intent.meta.specMode.label') }}
        <select
          v-if="canEditSpecMode"
          class="req-meta-spec-mode-select"
          data-testid="intent-meta-spec-mode-select"
          :value="specModeChoice"
          :title="t('intent.meta.specMode.tooltip')"
          @change="onSpecModeChange"
        >
          <option v-for="opt in SPEC_MODE_OPTIONS" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
        <span v-else data-testid="intent-meta-spec-mode-readonly">{{ specModeReadonlyLabel }}</span>
        <span
          v-if="specModeDerivedHint"
          class="req-meta-spec-mode-derived"
          data-testid="intent-meta-spec-mode-derived"
          >{{ specModeDerivedHint }}</span
        >
        <span
          v-if="sddEnabled === false"
          class="req-meta-spec-mode-hint"
          data-testid="intent-meta-spec-mode-off-hint"
          >{{ t('intent.meta.specMode.workspaceOff') }}</span
        >
      </span>
      <span v-if="intent.branchName" class="req-meta-item">
        {{ t('intent.meta.branch.label') }} {{ intent.branchName
        }}<span v-if="intent.latestCommitHash"> · {{ intent.latestCommitHash.slice(0, 7) }}</span>
      </span>
      <span class="req-meta-item" data-testid="intent-meta-base-branch">
        {{ t('intent.meta.baseBranch.label') }} {{ intent.baseBranch
        }}<span v-if="intent.baseBranchFallback" class="req-meta-note">
          ({{ t('intent.meta.baseBranch.fallback') }})</span
        >
      </span>
      <span
        v-if="intent.linkedDeliveries.length > 0"
        class="req-meta-item"
        data-testid="intent-meta-delivery"
      >
        {{ t('intent.meta.delivery.label') }}
        <button
          v-for="d in intent.linkedDeliveries"
          :key="d.id"
          type="button"
          class="req-meta-delivery-link"
          :data-testid="`intent-meta-delivery-${d.id}`"
          @click="emit('open-delivery', d.id)"
        >
          {{ d.title }}
        </button>
        <button
          v-if="linkedDelivery"
          type="button"
          class="req-btn req-meta-unlink-btn"
          data-action="unlinkDelivery"
          data-testid="intent-detail-unlink-delivery"
          @click="unlinkDialogOpen = true"
        >
          {{ t('intent.linkDelivery.unlink.label') }}
        </button>
      </span>
      <span v-if="intent.prs.length > 0" class="req-meta-item" data-testid="intent-meta-pr">
        {{ t('intent.meta.pr.label') }}
        <template v-for="group in prGroups" :key="group.key">
          <span v-if="showPrGroupLabels" class="req-meta-pr-group">{{
            group.title ?? t('intent.meta.noDelivery.label')
          }}</span>
          <template v-for="pr in group.prs" :key="pr.id">
            <a
              v-if="pr.url"
              class="req-meta-pr-link"
              :href="pr.url"
              target="_blank"
              rel="noopener noreferrer"
              :title="t('intent.action.pr.open.tooltip')"
              >#{{ pr.number }}</a
            >
            <template v-else>#{{ pr.number }}</template>
            <span class="req-pr-status" :class="'req-pr-status--' + pr.status">{{
              prStatusLabel(pr.status)
            }}</span>
          </template>
        </template>
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
          <button
            type="button"
            class="dep-edit-delete"
            data-testid="dep-edit-delete"
            @click="requestDeleteDep"
          >
            {{ t('intent.deps.delete.label') }}
          </button>
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
    <!-- 删除确认层:渲染在 overlay 子树内,借其 z-index: 1000 的层叠上下文盖住编辑弹窗
       (ConfirmDialog 自身 z-index: 300,平级渲染会被编辑 overlay 盖住)。 -->
    <ConfirmDialog
      :open="confirmDeleteDepOpen"
      :title="t('intent.deps.delete.title')"
      :message="t('intent.deps.delete.confirm', { title: deleteDepTitle })"
      :confirm-label="t('common.action.delete.label')"
      :cancel-label="t('common.action.cancel.label')"
      danger
      @confirm="confirmDeleteDep"
      @cancel="confirmDeleteDepOpen = false"
    />
  </div>

  <!-- 解除关联:服务端会先关闭该意图指向此交付的 PR(已合并则直接拒绝),文案必须
       把这个副作用说清楚,用户才是在知情下确认。 -->
  <ConfirmDialog
    :open="unlinkDialogOpen"
    :title="t('intent.linkDelivery.unlink.title.label')"
    :message="t('intent.linkDelivery.unlink.confirm', { title: linkedDelivery?.title ?? '' })"
    :confirm-label="t('intent.linkDelivery.unlink.label')"
    :cancel-label="t('common.action.cancel.label')"
    danger
    @confirm="confirmUnlink"
    @cancel="unlinkDialogOpen = false"
  />
</template>

<style scoped>
/* 关联交付:纯文字链接样式的按钮(跳转是页内导航,不是外链,故不用 <a>)。 */
.req-meta-delivery-link {
  margin-left: var(--sp-1);
  padding: 0;
  font: inherit;
  color: var(--c-primary-text);
  background: transparent;
  border: none;
  cursor: pointer;
  text-decoration: underline;
}
/* 解除关联:紧跟交付名的低频维护动作,危险色只落在文字上,不与元信息其它内容抢注意力。 */
.req-meta-unlink-btn {
  margin-left: var(--sp-2);
  padding: 0 var(--sp-1);
  color: var(--c-error-text);
}
/* 是否需要规范:元信息行内的紧凑下拉,尺寸跟随周围 caption 文字,不抢视线。 */
.req-meta-spec-mode-select {
  margin-left: var(--sp-1);
  padding: 0 var(--sp-1);
  font: inherit;
  color: var(--c-text);
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: 4px;
  cursor: pointer;
}
/* 继承态副标(当前生效档)与工作区关闭提示:都是解释性文字,弱化处理。 */
.req-meta-spec-mode-derived,
.req-meta-spec-mode-hint {
  margin-left: var(--sp-1);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
/* PR 分组标签:标出下面这串 PR 提向哪个交付。 */
.req-meta-pr-group {
  margin-left: var(--sp-1);
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
/* 读时派生的说明,不能看起来和持久事实同等分量。 */
.req-meta-note {
  font-size: var(--fs-caption);
  color: var(--c-text-muted);
}
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
