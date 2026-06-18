<script setup lang="ts">
/*
 * IntentDetail.vue — 需求页右栏:选中意图的详情面板(常驻头部 + 四 tab)。
 *
 * 顶部常驻头部拆为标题栏与操作栏:标题栏左为意图标题 + 模块,右为优先级 + 状态;
 * 操作栏承载全部操作(四态主按钮 + refine / open dev session / mark done / cancel /
 * create PR / copy PR / automate 切换)——无论在哪个 tab 都可见。其下为 tab 条 + tab 内容,四 tab:
 *   - intent       意图正文 markdown + Git/PR 元信息 + 依赖编辑器
 *   - intent session 该意图的 refine/沟通会话(intentSessionId),复用 ChatColumn
 *   - spec         渲染 specPath 指向的 spec.md(经 read-spec 拉取)
 *   - spec session 写 spec 会话(specSessionId),复用 ChatColumn
 * 两个会话 tab 沿用「单一活动会话」模型:切到该 tab 即请求服务端打开对应会话,
 * 聊天列绑定到全局活动会话;activeSession 与期望 id 一致时才渲染,避免串台。
 * 列表为空(无选中意图)时渲染空态。
 */
import { computed, ref, watch } from 'vue'
import type { DepType, Intent, IntentPrStatus, IntentStatus } from '@ccc/shared/protocol'
import type {
  PromptImage,
  SessionAgentSwitch,
  SlashCommandInfo,
  VendorId,
} from '@ccc/shared/protocol'
import type { PendingItem } from '../../../../lib/pending-queue'
import type { TaskListModel } from '../../../../lib/task-list'
import type { ChatMsg, PermissionMsg, RunActivity } from '../../../../lib/chat-types'
import { useTypedI18n } from '@/i18n'
import MarkdownText from '../../../../components/MarkdownText/MarkdownText.vue'
import ChatColumn from '../../../../components/ChatColumn/ChatColumn.vue'
import ResetSessionDialog from '../../../../components/ResetSessionDialog/ResetSessionDialog.vue'
import { formatDate, formatDependsOn, statusLabel } from '../../../../lib/intent-list-view'

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
  // ── chat column passthrough(intent session / spec session 两 tab 共用)──
  /** 全局活动会话 id;与期望会话 id 一致时聊天列才渲染(防串台)。 */
  activeSession: string | null
  activeTitle: string
  vendor?: VendorId | null
  agentSwitch?: SessionAgentSwitch | null
  hasActiveSession: boolean
  messages: ChatMsg[]
  actionablePermissionId: string | null
  taskModel: TaskListModel
  hasTaskStore?: boolean
  running: boolean
  teamActive: boolean
  connection: 'connecting' | 'open' | 'closed'
  activity: RunActivity
  currentAgentName?: string
  reconnecting?: boolean
  sideEffectPending?: boolean
  queue: PendingItem[]
  availableCommands: SlashCommandInfo[]
  voiceLang: string
  // ── spec 文档(spec tab)──
  /** 选中意图 spec.md 内容;null=未加载/无。 */
  intentSpecContent: string | null
  intentSpecLoading: boolean
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
  // ── 会话/spec 打开 ──
  'open-intent-session': [sessionId: string]
  'open-spec-session': [intentId: string]
  'read-spec': [rel: string]
  // ── 会话重置(带新输入,拼接意图/spec 内容新起会话) ──
  'reset-intent-session': [intentId: string, userInput: string]
  'reset-spec-session': [intentId: string, userInput: string]
  // ── chat column passthrough ──
  'set-session-agent': [agentId: string]
  respond: [m: PermissionMsg, decision: 'allow' | 'deny']
  'submit-ask': [m: PermissionMsg, answers: Record<string, string>]
  refresh: []
  'edit-queued': [item: PendingItem]
  'delete-queued': [id: number]
  submit: [text: string, images: PromptImage[]]
  enqueue: [text: string, images: PromptImage[]]
  stop: []
  continue: []
  'list-commands': []
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
const startDevInFlight = ref(false)

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

// ── Tab 状态 ────────────────────────────────────────────────────────────────
type DetailTab = 'intent' | 'intentSession' | 'spec' | 'specSession'
const activeTab = ref<DetailTab>('intent')

const TABS: { key: DetailTab; label: string }[] = [
  { key: 'intent', label: t('intent.tab.intent.label') },
  { key: 'intentSession', label: t('intent.tab.intentSession.label') },
  { key: 'spec', label: t('intent.tab.spec.label') },
  { key: 'specSession', label: t('intent.tab.specSession.label') },
]

// 选中意图切换:复位到 intent tab 与 in-flight 守卫(不自动打开其他意图的会话)。
watch(
  () => props.intent?.id,
  () => {
    activeTab.value = 'intent'
    startDevInFlight.value = false
  },
)

// 切到会话/spec tab 时按需请求服务端打开会话 / 读取 spec。
function selectTab(tab: DetailTab): void {
  activeTab.value = tab
  const r = props.intent
  if (!r) return
  if (tab === 'intentSession' && r.intentSessionId && props.activeSession !== r.intentSessionId) {
    emit('open-intent-session', r.intentSessionId)
  } else if (tab === 'specSession' && r.specSessionId && props.activeSession !== r.specSessionId) {
    emit('open-spec-session', r.id)
  } else if (tab === 'spec' && r.specPath) {
    emit('read-spec', r.specPath)
  }
}

// 当前会话 tab 期望的会话 id,以及活动会话是否已对齐(对齐才渲染聊天列)。
const expectedSessionId = computed<string | null>(() => {
  const r = props.intent
  if (!r) return null
  if (activeTab.value === 'intentSession') return r.intentSessionId
  if (activeTab.value === 'specSession') return r.specSessionId
  return null
})
const chatReady = computed<boolean>(
  () => expectedSessionId.value !== null && props.activeSession === expectedSessionId.value,
)

// ── 会话重置弹框(intent session / spec session 共用,按当前 tab 分流) ──────────
const resetDialogOpen = ref(false)

// 当前 session tab 是否可重置:intent session 恒可(意图内容始终存在);
// spec session 仅在已写过 spec(specPath 存在)时可重置(否则无 spec 内容可拼接)。
const canResetSession = computed<boolean>(() => {
  if (activeTab.value === 'intentSession') return true
  if (activeTab.value === 'specSession') return !!props.intent?.specPath
  return false
})
const resetDialogTitle = computed<string>(() =>
  activeTab.value === 'specSession'
    ? t('intent.resetSession.specSession.title')
    : t('intent.resetSession.intentSession.title'),
)
const resetDialogMessage = computed<string>(() =>
  activeTab.value === 'specSession'
    ? t('intent.resetSession.specSession.message')
    : t('intent.resetSession.intentSession.message'),
)

function openResetDialog(): void {
  if (!canResetSession.value) return
  resetDialogOpen.value = true
}
function onResetConfirm(text: string): void {
  const r = props.intent
  resetDialogOpen.value = false
  if (!r) return
  if (activeTab.value === 'specSession') {
    emit('reset-spec-session', r.id, text)
  } else {
    emit('reset-intent-session', r.id, text)
  }
}

// ── Composer 透传(供 App.vue 待发队列「编辑」回填) ──────────────────────────
const chatColumn = ref<InstanceType<typeof ChatColumn> | null>(null)
defineExpose({
  prefill: (text: string, images?: PromptImage[]) => chatColumn.value?.prefill(text, images),
})
</script>

<template>
  <section class="intent-detail" data-testid="intent-detail">
    <p v-if="!intent" class="intent-detail-empty" data-testid="intent-detail-empty">
      {{ t('intent.list.empty') }}
    </p>
    <template v-else>
      <!-- 常驻头部:标题栏 + 独立操作栏 -->
      <header class="intent-detail-head">
        <div class="intent-detail-titlebar">
          <div class="intent-detail-title-main">
            <h2 class="intent-detail-title" :title="intent.content">{{ intent.title }}</h2>
            <span v-if="intent.module" class="req-module" :title="intent.module">{{
              intent.module
            }}</span>
          </div>
          <div class="intent-detail-title-meta">
            <span class="req-priority" :class="intent.priority">{{ intent.priority }}</span>
            <span class="req-status" :class="intent.status">{{ statusLabel(intent.status) }}</span>
          </div>
        </div>
        <div class="intent-detail-actions" data-testid="intent-detail-actions">
          <button
            v-if="intent.status === 'todo'"
            class="req-btn"
            @click="emit('refine', intent.id)"
          >
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
      </header>

      <!-- Tab 条 -->
      <nav class="intent-detail-tabs" data-testid="intent-detail-tabs">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          type="button"
          class="intent-detail-tab"
          :class="{ active: activeTab === tab.key }"
          :data-tab="tab.key"
          :aria-pressed="activeTab === tab.key"
          @click="selectTab(tab.key)"
        >
          {{ tab.label }}
        </button>
      </nav>

      <!-- intent tab:正文 + 元信息 -->
      <div v-if="activeTab === 'intent'" class="intent-detail-body" data-testid="tab-intent">
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

      <!-- spec tab:渲染 spec.md -->
      <div v-else-if="activeTab === 'spec'" class="intent-detail-body" data-testid="tab-spec">
        <p
          v-if="!intent.specPath"
          class="intent-detail-empty"
          data-testid="intent-detail-spec-empty"
        >
          {{ t('intent.spec.empty') }}
        </p>
        <p v-else-if="intentSpecLoading" class="intent-detail-empty">
          {{ t('intent.spec.loading') }}
        </p>
        <div v-else-if="intentSpecContent !== null" class="req-detail">
          <MarkdownText :text="intentSpecContent" markdown />
        </div>
      </div>

      <!-- intent session / spec session tab:复用聊天列 -->
      <template v-else>
        <div
          v-if="canResetSession"
          class="intent-detail-session-tools"
          data-testid="intent-detail-session-tools"
        >
          <button
            type="button"
            class="req-btn"
            data-testid="intent-detail-reset-session"
            @click="openResetDialog"
          >
            {{ t('intent.action.resetSession.label') }}
          </button>
        </div>
        <p
          v-if="!expectedSessionId"
          class="intent-detail-empty"
          :data-testid="
            activeTab === 'intentSession'
              ? 'intent-detail-intent-session-empty'
              : 'intent-detail-spec-session-empty'
          "
        >
          {{
            activeTab === 'intentSession'
              ? t('intent.intentSession.empty')
              : t('intent.specSession.empty')
          }}
        </p>
        <p v-else-if="!chatReady" class="intent-detail-empty">
          {{ t('intent.chat.loading') }}
        </p>
        <ChatColumn
          v-else
          ref="chatColumn"
          data-testid="intent-detail-chat"
          :active-title="activeTitle"
          :vendor="vendor"
          :agent-switch="agentSwitch"
          :show-mode="false"
          :always-title="true"
          :has-active-session="hasActiveSession"
          :messages="messages"
          :actionable-permission-id="actionablePermissionId"
          :task-model="taskModel"
          :has-task-store="hasTaskStore"
          :running="running"
          :team-active="teamActive"
          :connection="connection"
          :activity="activity"
          :current-agent-name="currentAgentName"
          :reconnecting="reconnecting"
          :side-effect-pending="sideEffectPending"
          :queue="queue"
          :available-commands="availableCommands"
          :voice-lang="voiceLang"
          @set-session-agent="(id: string) => emit('set-session-agent', id)"
          @respond="(m: PermissionMsg, d: 'allow' | 'deny') => emit('respond', m, d)"
          @submit-ask="(m: PermissionMsg, a: Record<string, string>) => emit('submit-ask', m, a)"
          @refresh="emit('refresh')"
          @edit-queued="(item: PendingItem) => emit('edit-queued', item)"
          @delete-queued="(id: number) => emit('delete-queued', id)"
          @submit="(text: string, imgs: PromptImage[]) => emit('submit', text, imgs)"
          @enqueue="(text: string, imgs: PromptImage[]) => emit('enqueue', text, imgs)"
          @stop="emit('stop')"
          @continue="emit('continue')"
          @list-commands="emit('list-commands')"
        />
      </template>
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

    <!-- 会话重置输入弹框 -->
    <ResetSessionDialog
      :open="resetDialogOpen"
      :title="resetDialogTitle"
      :message="resetDialogMessage"
      :placeholder="t('intent.resetSession.placeholder')"
      :confirm-label="t('intent.action.resetSession.label')"
      :cancel-label="t('common.action.cancel.label')"
      @confirm="onResetConfirm"
      @cancel="resetDialogOpen = false"
    />
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
.intent-detail-titlebar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-3);
}
.intent-detail-title-main {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--sp-2);
  min-width: 0;
}
.intent-detail-title-meta {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
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
.intent-detail-actions {
  width: 100%;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.intent-detail-tabs {
  flex-shrink: 0;
  display: flex;
  align-items: stretch;
  gap: var(--sp-1);
  padding: 0 var(--sp-3);
  border-bottom: 1px solid var(--c-border);
  overflow-x: auto;
}
.intent-detail-tab {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--c-text-muted);
  font-size: var(--fs-caption);
  padding: var(--sp-2) var(--sp-2);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
}
.intent-detail-tab:hover {
  color: var(--c-text);
}
.intent-detail-tab.active {
  color: var(--c-text);
  border-bottom-color: var(--c-accent, var(--c-text));
  font-weight: 600;
}
@media (max-width: 640px) {
  .intent-detail-titlebar {
    flex-direction: column;
    align-items: stretch;
    gap: var(--sp-2);
  }
  .intent-detail-title-main {
    align-items: flex-start;
    flex-direction: column;
    gap: var(--sp-1);
  }
  .intent-detail-title-meta {
    justify-content: flex-start;
  }
}
.intent-detail-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-3);
}
.intent-detail-session-tools {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 1px solid var(--c-border);
}
</style>
