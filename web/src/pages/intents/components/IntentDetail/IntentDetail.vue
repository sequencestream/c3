<script lang="ts">
// 防误审门:记录每个意图在本次会话内点击「编写 Spec」的时刻(毫秒)。
// 故意放在模块作用域而非组件实例,使组件重挂载 / 重选意图后 10 秒窗口仍存活,
// 避免「重新进入页面或状态刷新」绕过延迟展示约束。条目只增不减(规模极小)。
const writeSpecTriggeredAt = new Map<string, number>()

// 点「编写 Spec」后约 1 秒自动切到 spec session Tab。
const SWITCH_SPEC_TAB_MS = 1000
// 「审核 Spec」状态主按钮从编写触发起延迟展示的窗口。
const APPROVE_GATE_MS = 10000

// 仅供单测重置模块级门状态,隔离用例之间的污染;生产代码不调用。
export function __resetWriteSpecGuards(): void {
  writeSpecTriggeredAt.clear()
}
</script>

<script setup lang="ts">
/*
 * IntentDetail.vue — 需求页右栏:选中意图的详情面板(常驻头部 + 四 tab)。
 *
 * 顶部常驻头部为单行标题栏:左为意图标题 + 模块 + 优先级 + 状态,右为全部操作
 * (四态主按钮 + refine / mark done / cancel / create PR / copy PR / automate 切换)
 * ——无论在哪个 tab 都可见。其下为 tab 条 + tab 内容:
 *   - intent       意图正文 markdown + Git/PR 元信息 + 依赖编辑器
 *   - intent session 该意图的 refine/沟通会话(intentSessionId),复用 ChatColumn
 *   - spec         渲染 specPath 指向的 spec.md(经 read-spec 拉取)
 *   - spec session 写 spec 会话(specSessionId),复用 ChatColumn
 *   - work session 最新工作会话(lastWorkSessionId),仅当其存在时可见,复用 ChatColumn;
 *                  tab 标签带运行中状态点(对齐 WorkSessionList 的 .session-status 点)
 *   - changelog    生命周期变更日志(倒序)
 * 三个会话 tab 沿用「单一活动会话」模型:切到该 tab 即请求服务端打开对应会话,
 * 聊天列绑定到全局活动会话;activeSession 与期望 id 一致时才渲染,避免串台。
 * 列表为空(无选中意图)时渲染空态。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type {
  DepType,
  Intent,
  IntentLog,
  IntentLogOperation,
  IntentPrStatus,
  IntentStatus,
} from '@ccc/shared/protocol'
import type {
  PromptImage,
  SessionAgentSwitch,
  SessionStatus,
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
import {
  formatDate,
  formatDependsOn,
  hasDependencyBlockingSpecSession,
  isIntentOnWorkspaceMainBranch,
  normalizeBranchName,
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
  /** Per-intent one-shot PR/MR sync feedback from the control layer. */
  intentPrSync?: Record<string, { state: 'syncing' | 'success' | 'error'; message: string }>
  /** 当前 workspace 的 SDD 总开关,驱动主操作按钮四态(关→Start Work)。 */
  sddEnabled?: boolean
  /** 当前 workspace 配置的主分支;intent 分支与其相同时不显示 Create PR。 */
  workspaceMainBranch?: string | null
  workspaceGitBranchMode?: 'worktree' | 'current-branch'
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
  /** 该意图的 spec 会话是否运行中(specSessionId 对应会话活跃);直接编辑 spec 的门禁之一。 */
  specSessionRunning?: boolean
  /**
   * 最新工作会话(lastWorkSessionId)的运行状态,用于工作会话 tab 标签的运行中状态点。
   * 非 idle(running / awaiting_permission / team / reconnecting)时显示状态点;
   * idle / 未知(null)时不显示。由容器从 sessionStatus 派生透传。
   */
  workSessionStatus?: SessionStatus | null
  // ── 变更日志(changelog tab)──
  /** 选中意图的生命周期变更日志(倒序);切到 changelog tab 时懒加载。 */
  intentLogs: IntentLog[]
  intentLogsLoading: boolean
  /** One-shot request from WorkCenter jump-to-source: force a detail sub-tab switch
   * (intentSession / specSession). Cleared via `requested-subtab-consumed`. */
  requestedSubTab?: 'intentSession' | 'specSession' | null
}>()

const emit = defineEmits<{
  refine: [intentId: string]
  // 直接编辑意图正文:上抛 id + 新正文,由控制层透传为 update_intent_content。
  'save-intent-content': [intentId: string, content: string]
  'write-spec': [intentId: string]
  'approve-spec': [intentId: string]
  'start-dev': [intentId: string, hasUnfinishedDeps: boolean]
  // 内嵌工作会话 tab 激活:请求控制层把 lastWorkSessionId 选为全局活动会话(不进会话页)。
  'open-work-session': [sessionId: string]
  'set-status': [intentId: string, status: IntentStatus]
  'set-automate': [intentId: string, automate: boolean]
  'create-pr': [intentId: string]
  'sync-pr-status': [intentId: string]
  'update-deps': [intentId: string, deps: { dependsOnId: string; depType: DepType }[]]
  'select-dependency': [intentId: string]
  // 分享:上抛意图 id,由 App 组装深链复制(workspace/typeLabel 在上层)。
  share: [intentId: string]
  // ── 会话/spec 打开 ──
  'open-intent-session': [sessionId: string]
  'open-spec-session': [intentId: string]
  'read-spec': [intentId: string, specPath: string]
  // 直接编辑 spec 源码:上抛 id + 新内容,由控制层透传为 update_spec_content。
  'save-spec-content': [intentId: string, content: string]
  'list-intent-logs': [intentId: string]
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
  // ── 外部子 tab 请求消耗 ──
  'requested-subtab-consumed': []
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

const dependencyInfos = computed(() =>
  props.intent ? formatDependsOn(props.intent, props.intents) : [],
)

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
    if (next === prev) return
    // 任一 intent.* 动作被服务端拒绝都会自增该 seq;释放所有在途保存守卫,让被拒的
    // 直接编辑退出「保存中」态(按钮重新可点),编辑框保留草稿供重试。
    startDevInFlight.value = false
    savingContent.value = false
    savingSpec.value = false
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

// ── 正文直接编辑(仅 draft / todo,服务端为最终门禁) ───────────────────────
// 编辑态与草稿只活在组件内,不写入全局 intent;保存只 emit,退出编辑态由服务端
// 回填(intent.updatedAt 变化)驱动,契合「后写覆盖、无锁」语义。
const editingContent = ref(false)
const contentDraft = ref('')
const savingContent = ref(false)

// 仅 draft / todo 显示「编辑」入口;其它状态既不显示按钮,服务端也拒绝其编辑请求。
const canEditContent = computed<boolean>(() => {
  const s = props.intent?.status
  return s === 'draft' || s === 'todo'
})

function startEditContent(): void {
  const r = props.intent
  if (!r || !canEditContent.value) return
  contentDraft.value = r.content
  savingContent.value = false
  editingContent.value = true
}

function cancelEditContent(): void {
  // 丢弃本地草稿,恢复渲染态。
  editingContent.value = false
  savingContent.value = false
}

function saveEditContent(): void {
  const r = props.intent
  if (!r || savingContent.value) return
  savingContent.value = true
  emit('save-intent-content', r.id, contentDraft.value)
}

// 服务端成功回填最新意图后(updated_at 必然刷新)退出编辑态,展示服务端内容。
// 仅在提交在途(savingContent)时响应,避免其它广播误关编辑框。
watch(
  () => props.intent?.updatedAt,
  () => {
    if (savingContent.value) {
      savingContent.value = false
      editingContent.value = false
    }
  },
)

// ── spec 源码直接编辑(spec tab;三门禁,服务端为最终门禁) ───────────────────
// 纯文本 Markdown 源码编辑;草稿只活在组件内。保存只 emit,退出编辑态由服务端
// 回填(intent.updatedAt 变化,含审批重置的 setSpecApproved 幂等 bump)驱动,
// 随后重新 read-spec 拉取覆盖后的内容渲染。
const editingSpec = ref(false)
const specDraft = ref('')
const savingSpec = ref(false)

// 三门禁全满足才允许直接编辑 spec:specPath 存在、未启动开发
// (todo 且无 lastWorkSessionId)、无运行中 spec 会话。任一不满足则隐藏入口。
const canEditSpec = computed<boolean>(() => {
  const r = props.intent
  return (
    !!r && !!r.specPath && r.status === 'todo' && !r.lastWorkSessionId && !props.specSessionRunning
  )
})

function startEditSpec(): void {
  if (!canEditSpec.value || props.intentSpecContent === null) return
  specDraft.value = props.intentSpecContent ?? ''
  savingSpec.value = false
  editingSpec.value = true
}

function cancelEditSpec(): void {
  editingSpec.value = false
  savingSpec.value = false
}

function saveEditSpec(): void {
  const r = props.intent
  if (!r || savingSpec.value) return
  savingSpec.value = true
  emit('save-spec-content', r.id, specDraft.value)
}

// 保存成功:服务端广播回填(updated_at 变化)后退出编辑态,并重新拉取覆盖后的
// spec 渲染。仅在提交在途(savingSpec)时响应,避免其它广播误关编辑框。
watch(
  () => props.intent?.updatedAt,
  () => {
    if (savingSpec.value) {
      savingSpec.value = false
      editingSpec.value = false
      const r = props.intent
      if (r?.specPath) emit('read-spec', r.id, r.specPath)
    }
  },
)

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
const specDependencyBlocked = computed<boolean>(() =>
  hasDependencyBlockingSpecSession(
    props.intent,
    props.intents,
    props.workspaceGitBranchMode,
    props.workspaceMainBranch,
  ),
)
const mainActionDisabled = computed<boolean>(
  () =>
    (mainAction.value === 'startDev' && startDevInFlight.value) ||
    (mainAction.value === 'writeSpec' && specDependencyBlocked.value),
)
const mainActionTitle = computed<string>(() =>
  mainAction.value === 'writeSpec' && specDependencyBlocked.value
    ? t('intent.specLaunch.dependencyNotMerged')
    : mainActionLabel.value,
)

// ── 防误审门 + 自动切 Tab 定时器 ───────────────────────────────────────────
// gateTick 仅作 approveGateBlocked 的响应式触发源:到点的定时器自增它,强制重算。
const gateTick = ref(0)
let approveGateTimer: ReturnType<typeof setTimeout> | null = null
let switchSpecTabTimer: ReturnType<typeof setTimeout> | null = null

// 当前审批动作处于 approveSpec 态、且本会话点过该意图的「编写 Spec」、且距触发不足
// 10 秒时为 true → spec tab 内的真正批准入口不可见。不依赖 specPath 出现先后:
// 本会话未点编写的意图不武装门,批准入口照常立即可见。
const approveGateBlocked = computed<boolean>(() => {
  void gateTick.value
  const r = props.intent
  if (!r || mainAction.value !== 'approveSpec') return false
  const at = writeSpecTriggeredAt.get(r.id)
  if (at === undefined) return false
  return Date.now() - at < APPROVE_GATE_MS
})

function clearApproveGateTimer(): void {
  if (approveGateTimer !== null) {
    clearTimeout(approveGateTimer)
    approveGateTimer = null
  }
}

function clearSwitchSpecTabTimer(): void {
  if (switchSpecTabTimer !== null) {
    clearTimeout(switchSpecTabTimer)
    switchSpecTabTimer = null
  }
}

// 为当前意图的防误审门排程一个「剩余时间」定时器,到点放行(自增 gateTick 触发重算)。
function automationApproveGate(): void {
  clearApproveGateTimer()
  const r = props.intent
  if (!r) return
  const at = writeSpecTriggeredAt.get(r.id)
  if (at === undefined) return
  const remaining = APPROVE_GATE_MS - (Date.now() - at)
  if (remaining <= 0) return
  approveGateTimer = setTimeout(() => {
    approveGateTimer = null
    gateTick.value++
  }, remaining)
}

// 意图切换或 specPath 回填(mainAction 变化)时重排门定时器;immediate 覆盖挂载/重挂载。
watch(
  () => [props.intent?.id, mainAction.value] as const,
  () => {
    automationApproveGate()
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  clearApproveGateTimer()
  clearSwitchSpecTabTimer()
})

const showCreatePr = computed<boolean>(() => {
  const r = props.intent
  const branchName = normalizeBranchName(r?.branchName)
  return (
    !!r &&
    branchName !== null &&
    !!r.lastWorkSessionId &&
    !r.prId &&
    !isIntentOnWorkspaceMainBranch(r.branchName, props.workspaceMainBranch)
  )
})

const canSyncPrStatus = computed<boolean>(() => {
  const r = props.intent
  return !!r && r.status === 'done' && !!r.prId && r.prStatus === 'reviewing'
})

const currentPrSync = computed(() => {
  const id = props.intent?.id
  return id ? props.intentPrSync?.[id] : undefined
})

const prSyncInFlight = computed<boolean>(() => currentPrSync.value?.state === 'syncing')

function syncPrStatus(): void {
  const r = props.intent
  if (!r || !canSyncPrStatus.value || prSyncInFlight.value) return
  emit('sync-pr-status', r.id)
}

function onMainAction(): void {
  const r = props.intent
  if (!r) return
  if (mainAction.value === 'writeSpec') {
    emit('write-spec', r.id)
    // 武装防误审门(以触发时刻锚定),并约 1 秒后自动切到 spec session Tab。
    writeSpecTriggeredAt.set(r.id, Date.now())
    automationApproveGate()
    clearSwitchSpecTabTimer()
    const triggeredId = r.id
    switchSpecTabTimer = setTimeout(() => {
      switchSpecTabTimer = null
      // 仅当触发时的意图仍是当前选中意图时才切,用户已切走则不抢回。
      if (props.intent?.id === triggeredId) selectTab('specSession')
    }, SWITCH_SPEC_TAB_MS)
    return
  }
  if (mainAction.value === 'approveSpec') {
    selectTab('spec')
    return
  }
  startDev()
}

// ── Tab 状态 ────────────────────────────────────────────────────────────────
type DetailTab = 'intent' | 'intentSession' | 'spec' | 'specSession' | 'workSession' | 'changelog'
const activeTab = ref<DetailTab>('intent')

const TABS: { key: DetailTab; label: string }[] = [
  { key: 'intent', label: t('intent.tab.intent.label') },
  { key: 'intentSession', label: t('intent.tab.intentSession.label') },
  { key: 'spec', label: t('intent.tab.spec.label') },
  { key: 'specSession', label: t('intent.tab.specSession.label') },
  { key: 'workSession', label: t('intent.tab.workSession.label') },
  { key: 'changelog', label: t('intent.tab.changelog.label') },
]

// spec / spec session 两 tab 的可见条件:workspace 开启 SDD,或当前意图已有历史 spec 数据
// (specPath 或 specSessionId 非空)。SDD 关闭且无历史数据时隐藏,避免暴露两个空态 tab 入口。
// 纯 UI 隐藏,不影响已有 spec 内容/会话的读取。
const specTabsVisible = computed<boolean>(() => {
  if (props.sddEnabled) return true
  const r = props.intent
  return !!(r?.specPath || r?.specSessionId)
})
// 工作会话 tab 仅当选中意图存在 lastWorkSessionId(最新工作会话)时可见;不做历史列表。
const workSessionTabVisible = computed<boolean>(() => !!props.intent?.lastWorkSessionId)
const visibleTabs = computed<{ key: DetailTab; label: string }[]>(() =>
  TABS.filter((tab) => {
    if (tab.key === 'spec' || tab.key === 'specSession') return specTabsVisible.value
    if (tab.key === 'workSession') return workSessionTabVisible.value
    return true
  }),
)
function isTabVisible(tab: DetailTab): boolean {
  return visibleTabs.value.some((t) => t.key === tab)
}

// 工作会话 tab 标签的运行中状态点:非 idle/未知(null)才显示,值即 .session-status 的类。
const workSessionStatusDot = computed<SessionStatus | null>(() => {
  const st = props.workSessionStatus
  return st && st !== 'idle' ? st : null
})

// props 变化(SDD 开关切换 / 意图 spec 字段变化)导致当前激活 tab 不再可见时回退到 intent。
// 意图切换时的复位由下方 intent.id watch 负责,intent tab 恒可见故与本 watch 不冲突。
watch(visibleTabs, () => {
  if (!isTabVisible(activeTab.value)) activeTab.value = 'intent'
})

// ── 变更日志(changelog tab)──────────────────────────────────────────────
// 操作类型 → 本地化标签。key 全为字面量,拼错走 vue-tsc 失败(typed t)。
const OP_LABELS: Record<IntentLogOperation, string> = {
  intent_created: t('intent.changelog.operationType.created'),
  intent_updated: t('intent.changelog.operationType.updated'),
  status_changed: t('intent.changelog.operationType.statusChanged'),
  spec_created: t('intent.changelog.operationType.specCreated'),
  spec_updated: t('intent.changelog.operationType.specUpdated'),
  spec_approved: t('intent.changelog.operationType.specApproved'),
  spec_unapproved: t('intent.changelog.operationType.specUnapproved'),
  pr_created: t('intent.changelog.operationType.prCreated'),
  pr_merged: t('intent.changelog.operationType.prMerged'),
  pr_closed: t('intent.changelog.operationType.prClosed'),
  pr_updated: t('intent.changelog.operationType.prUpdated'),
}

function opLabel(op: IntentLogOperation): string {
  return OP_LABELS[op] ?? op
}

// spec tab「我要修改」提交后,待新 spec 会话真正创建(specSessionId 回填为新非空值)
// 再自动切到 spec session tab 的一次性状态。记录待切意图 id 与提交时刻的旧 specSessionId,
// 用于判定"是否换了新会话"。提交失败/未创建时 specSessionId 不变,该状态不触发切换。
const pendingSpecSwitch = ref<{ intentId: string; oldSpecSessionId: string | null } | null>(null)

// 选中意图切换:复位到 intent tab 与 in-flight 守卫(不自动打开其他意图的会话)。
watch(
  () => props.intent?.id,
  () => {
    activeTab.value = 'intent'
    startDevInFlight.value = false
    // 切走意图:丢弃未保存的正文/spec 草稿并退出编辑态,避免草稿串到别的意图。
    editingContent.value = false
    savingContent.value = false
    editingSpec.value = false
    savingSpec.value = false
    // 切走意图:取消挂起的自动切 Tab,避免切到别的意图后误切。门定时器由上方
    // [intent.id, mainAction] watch 负责重排。
    clearSwitchSpecTabTimer()
    // 切走意图:清除「我要修改」待切状态,避免新会话回填后误切回上一个意图的 spec session。
    pendingSpecSwitch.value = null
  },
)

// 外部子 tab 请求(WorkCenter 溯源跳转),在 intent 选中复位 tab 后再切换。
watch(
  () => props.requestedSubTab,
  (tab) => {
    if (tab) {
      selectTab(tab)
      emit('requested-subtab-consumed')
    }
  },
)

// 切到会话/spec tab 时按需读取 spec；会话打开由下方 watch 统一处理，避免
// 「切 tab 时已有 id」与「id 在激活 tab 下回填」两条路径重复发出 open。
function selectTab(tab: DetailTab): void {
  // 可见性门:不可见 tab(SDD 关闭且无历史 spec 数据时的 spec/specSession)不切换、不触发副作用。
  // 外部一次性请求(requestedSubTab)命中不可见 tab 时由此静默忽略,消费仍在 watcher 内照常进行。
  if (!isTabVisible(tab)) return
  activeTab.value = tab
  const r = props.intent
  if (!r) return
  if (tab === 'spec' && r.specPath) {
    emit('read-spec', r.id, r.specPath)
  }
  // changelog 懒加载:该意图的日志尚未拉过(空)才发起,已有缓存直接渲染。
  if (tab === 'changelog' && props.intentLogs.length === 0) {
    emit('list-intent-logs', r.id)
  }
}

// 会话 tab 激活期间，sessionId 可能在切 tab 后才由服务端回填。统一监听 tab、
// 当前意图的两个 id 与活动会话：期望 id 存在但尚未对齐时补发 open；已对齐则不发。
function openActiveSessionIfNeeded(): void {
  const r = props.intent
  if (!r) return
  if (
    activeTab.value === 'intentSession' &&
    r.intentSessionId &&
    props.activeSession !== r.intentSessionId
  ) {
    emit('open-intent-session', r.intentSessionId)
  } else if (
    activeTab.value === 'specSession' &&
    r.specSessionId &&
    props.activeSession !== r.specSessionId
  ) {
    emit('open-spec-session', r.id)
  } else if (
    activeTab.value === 'workSession' &&
    r.lastWorkSessionId &&
    props.activeSession !== r.lastWorkSessionId
  ) {
    emit('open-work-session', r.lastWorkSessionId)
  }
}

watch(
  () =>
    [
      activeTab.value,
      props.intent?.id,
      props.intent?.intentSessionId,
      props.intent?.specSessionId,
      props.intent?.lastWorkSessionId,
      props.activeSession,
    ] as const,
  openActiveSessionIfNeeded,
  { flush: 'sync' },
)

// spec tab「我要修改」提交后,以新 spec 会话实际创建为触发条件自动切到 spec session tab:
// 待切状态存在、意图匹配、且 specSessionId 变为非空且不同于提交时记录的旧值时切换并清除。
// 切到该 tab 后,上方 openActiveSessionIfNeeded 会自动补发 open-spec-session 绑定聊天列。
watch(
  () => props.intent?.specSessionId,
  (specSessionId) => {
    const pending = pendingSpecSwitch.value
    if (!pending) return
    const r = props.intent
    if (!r || r.id !== pending.intentId) return
    if (specSessionId && specSessionId !== pending.oldSpecSessionId) {
      pendingSpecSwitch.value = null
      selectTab('specSession')
    }
  },
)

// 当前会话 tab 期望的会话 id,以及活动会话是否已对齐(对齐才渲染聊天列)。
const expectedSessionId = computed<string | null>(() => {
  const r = props.intent
  if (!r) return null
  if (activeTab.value === 'intentSession') return r.intentSessionId
  if (activeTab.value === 'specSession') return r.specSessionId
  if (activeTab.value === 'workSession') return r.lastWorkSessionId
  return null
})
const chatReady = computed<boolean>(
  () => expectedSessionId.value !== null && props.activeSession === expectedSessionId.value,
)

// ── 会话重置弹框(intent session / spec session 共用,按入口分流) ─────────────
const resetDialogOpen = ref(false)
const resetDialogTarget = ref<'intentSession' | 'specSession'>('intentSession')

const canResetIntentSession = computed<boolean>(
  () => !!props.intent && !props.intent.lastWorkSessionId,
)
const canResetSpecSession = computed<boolean>(
  () => !!props.intent && !props.intent.lastWorkSessionId && !!props.intent.specPath,
)
const showSpecApproveAction = computed<boolean>(
  () => !!props.intent && props.intent.status === 'todo' && mainAction.value === 'approveSpec',
)
const showSpecModifyAction = computed<boolean>(
  () => canResetSpecSession.value || specDependencyBlocked.value,
)
const showSpecActions = computed<boolean>(
  () =>
    !!props.intent?.specPath &&
    ((showSpecApproveAction.value && !approveGateBlocked.value) || showSpecModifyAction.value),
)
const resetDialogTitle = computed<string>(() =>
  resetDialogTarget.value === 'specSession'
    ? t('intent.resetSession.specSession.title')
    : t('intent.resetSession.intentSession.title'),
)
const resetDialogMessage = computed<string>(() =>
  resetDialogTarget.value === 'specSession'
    ? t('intent.resetSession.specSession.message')
    : t('intent.resetSession.intentSession.message'),
)

function openResetDialog(target: 'intentSession' | 'specSession'): void {
  if (target === 'intentSession' && !canResetIntentSession.value) return
  if (target === 'specSession' && !canResetSpecSession.value) return
  resetDialogTarget.value = target
  resetDialogOpen.value = true
}
function onResetConfirm(text: string): void {
  const r = props.intent
  resetDialogOpen.value = false
  if (!r) return
  if (resetDialogTarget.value === 'specSession') {
    // 记录待切状态:新 spec 会话创建成功后由 specSessionId watcher 自动切到 spec session tab。
    pendingSpecSwitch.value = { intentId: r.id, oldSpecSessionId: r.specSessionId }
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
      <!-- 常驻头部:标题信息 + 右侧操作 -->
      <header class="intent-detail-head">
        <div class="intent-detail-titlebar">
          <div class="intent-detail-title-main">
            <h2 class="intent-detail-title" :title="intent.content">{{ intent.title }}</h2>
            <span v-if="intent.module" class="req-module" :title="intent.module">{{
              intent.module
            }}</span>
            <span class="req-priority" :class="intent.priority">{{ intent.priority }}</span>
            <span class="req-status" :class="intent.status">{{ statusLabel(intent.status) }}</span>
          </div>
          <div class="intent-detail-title-meta">
            <div class="intent-detail-actions" data-testid="intent-detail-actions">
              <button
                v-if="intent.status === 'draft'"
                type="button"
                class="req-btn"
                data-action="markTodo"
                data-testid="intent-detail-mark-todo"
                @click="emit('set-status', intent.id, 'todo')"
              >
                {{ t('intent.action.markTodo.label') }}
              </button>
              <button
                v-else-if="intent.status === 'todo'"
                type="button"
                class="req-btn"
                data-action="backToDraft"
                data-testid="intent-detail-back-to-draft"
                @click="emit('set-status', intent.id, 'draft')"
              >
                {{ t('intent.action.backToDraft.label') }}
              </button>
              <button
                v-if="canResetIntentSession"
                type="button"
                class="req-btn"
                data-testid="intent-detail-intent-modify"
                @click="openResetDialog('intentSession')"
              >
                {{ t('intent.action.modifySession.label') }}
              </button>
              <button
                v-if="intent.status === 'todo'"
                class="req-btn primary"
                :data-action="mainAction"
                :aria-label="mainActionTitle"
                :title="mainActionTitle"
                :disabled="mainActionDisabled"
                @click="onMainAction"
              >
                {{ mainActionLabel }}
              </button>
              <button
                v-if="
                  intent.lastWorkSessionId &&
                  intent.status !== 'done' &&
                  intent.status !== 'cancelled'
                "
                class="req-btn"
                data-action="markDone"
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
                v-if="showCreatePr"
                class="req-btn primary"
                data-action="createPr"
                @click="emit('create-pr', intent.id)"
              >
                {{ t('intent.action.createPr.label') }}
              </button>
              <a
                v-if="intent.prId && intent.prUrl"
                class="req-btn pr-link"
                :href="intent.prUrl"
                target="_blank"
                rel="noopener noreferrer"
                :title="t('intent.action.pr.open.tooltip')"
              >
                {{ t('intent.action.pr.label', { id: intent.prId }) }}
              </a>
              <button
                v-else-if="intent.prId"
                class="req-btn pr-link"
                :title="t('intent.action.pr.tooltip')"
                @click="copyPrId(intent.prId as string)"
              >
                {{ t('intent.action.pr.label', { id: intent.prId }) }}
              </button>
              <button
                v-if="canSyncPrStatus"
                type="button"
                class="req-btn"
                data-action="syncPrStatus"
                :disabled="prSyncInFlight"
                @click="syncPrStatus"
              >
                {{ prSyncInFlight ? t('intent.prSync.syncing') : t('intent.prSync.label') }}
              </button>
              <button
                type="button"
                class="req-share"
                data-testid="share-button"
                :title="t('share.tooltip')"
                :aria-label="t('share.ariaLabel')"
                @click="emit('share', intent.id)"
              >
                🔗
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
                {{ intent.automate ? '⚙' : '🖱' }}
              </button>
            </div>
          </div>
        </div>
      </header>

      <!-- Tab 条 -->
      <nav class="intent-detail-tabs" data-testid="intent-detail-tabs">
        <div v-for="tab in visibleTabs" :key="tab.key" class="intent-detail-tab-item">
          <button
            type="button"
            class="intent-detail-tab"
            :class="{ active: activeTab === tab.key }"
            :data-tab="tab.key"
            :aria-pressed="activeTab === tab.key"
            @click="selectTab(tab.key)"
          >
            {{ tab.label }}
            <span
              v-if="tab.key === 'workSession' && workSessionStatusDot"
              class="session-status"
              :class="workSessionStatusDot"
              :title="workSessionStatusDot"
              data-testid="intent-detail-work-session-status"
            ></span>
          </button>
        </div>
      </nav>

      <!-- intent tab:正文 + 元信息 -->
      <div v-if="activeTab === 'intent'" class="intent-detail-body" data-testid="tab-intent">
        <div
          v-if="!editingContent && (intent.status === 'todo' || canEditContent)"
          class="intent-detail-section-actions"
        >
          <button
            v-if="intent.status === 'todo'"
            class="req-btn"
            @click="emit('refine', intent.id)"
          >
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
        <div
          v-if="editingContent"
          class="req-content-edit"
          data-testid="intent-detail-content-editor"
        >
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
        <div class="req-meta">
          <span class="req-meta-item"
            >{{ t('intent.meta.created.label') }} {{ formatDate(intent.createdAt, locale) }}</span
          >
          <span v-if="intent.completedAt" class="req-meta-item"
            >{{ t('intent.meta.completed.label') }}
            {{ formatDate(intent.completedAt, locale) }}</span
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
          <span class="req-meta-item"
            >{{ t('intent.meta.updated.label') }} {{ formatDate(intent.updatedAt, locale) }}</span
          >
          <span class="req-meta-item">{{ t('intent.meta.id.label') }} {{ intent.id }}</span>
          <span v-if="intent.branchName" class="req-meta-item">
            {{ t('intent.meta.branch.label') }} {{ intent.branchName
            }}<span v-if="intent.latestCommitHash">
              · {{ intent.latestCommitHash.slice(0, 7) }}</span
            >
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

      <!-- spec tab:渲染 spec.md(或纯文本源码直接编辑) -->
      <div v-else-if="activeTab === 'spec'" class="intent-detail-body" data-testid="tab-spec">
        <!-- 操作区:编辑态下整体隐藏,避免审批/会话重置与源码保存同区并发。 -->
        <div
          v-if="!editingSpec && (showSpecActions || canEditSpec)"
          class="intent-detail-section-actions"
          data-testid="intent-detail-spec-actions"
        >
          <button
            v-if="showSpecApproveAction && !approveGateBlocked"
            type="button"
            class="req-btn primary"
            data-testid="intent-detail-spec-approve"
            @click="emit('approve-spec', intent.id)"
          >
            {{ t('intent.action.approveSpec.confirmLabel') }}
          </button>
          <button
            v-if="canEditSpec"
            type="button"
            class="req-btn"
            data-testid="intent-detail-spec-edit"
            @click="startEditSpec"
          >
            {{ t('intent.action.editSpec.label') }}
          </button>
          <button
            v-if="showSpecModifyAction"
            type="button"
            class="req-btn"
            data-testid="intent-detail-spec-modify"
            :title="specDependencyBlocked ? t('intent.specLaunch.dependencyNotMerged') : undefined"
            :disabled="specDependencyBlocked"
            @click="openResetDialog('specSession')"
          >
            {{ t('intent.action.modifySession.label') }}
          </button>
        </div>
        <p
          v-if="!intent.specPath"
          class="intent-detail-empty"
          data-testid="intent-detail-spec-empty"
        >
          {{ t('intent.spec.empty') }}
        </p>
        <!-- 编辑态:纯文本 Markdown 源码框 + 框下方左侧蓝色「保存」+ 取消。 -->
        <div
          v-else-if="editingSpec"
          class="req-content-edit"
          data-testid="intent-detail-spec-editor"
        >
          <textarea
            v-model="specDraft"
            class="req-content-textarea"
            data-testid="intent-detail-spec-textarea"
          ></textarea>
          <div class="req-content-edit-actions">
            <button
              type="button"
              class="req-btn primary"
              data-testid="intent-detail-spec-save"
              :disabled="savingSpec"
              @click="saveEditSpec"
            >
              {{ t('common.action.save.label') }}
            </button>
            <button
              type="button"
              class="req-btn"
              data-testid="intent-detail-spec-cancel"
              @click="cancelEditSpec"
            >
              {{ t('common.action.cancel.label') }}
            </button>
          </div>
        </div>
        <p v-else-if="intentSpecLoading" class="intent-detail-empty">
          {{ t('intent.spec.loading') }}
        </p>
        <div v-else-if="intentSpecContent !== null" class="req-detail">
          <MarkdownText :text="intentSpecContent" markdown />
        </div>
      </div>

      <!-- changelog tab:生命周期变更日志(倒序) -->
      <div
        v-else-if="activeTab === 'changelog'"
        class="intent-detail-body"
        data-testid="tab-changelog"
      >
        <p v-if="intentLogsLoading && intentLogs.length === 0" class="intent-detail-empty">
          {{ t('intent.changelog.loading') }}
        </p>
        <p
          v-else-if="intentLogs.length === 0"
          class="intent-detail-empty"
          data-testid="intent-detail-changelog-empty"
        >
          {{ t('intent.changelog.empty') }}
        </p>
        <ul v-else class="req-changelog" data-testid="intent-detail-changelog-list">
          <li v-for="log in intentLogs" :key="log.id" class="req-changelog-row">
            <span class="req-changelog-op" :class="'req-changelog-op--' + log.operationType">{{
              opLabel(log.operationType)
            }}</span>
            <span class="req-changelog-summary">{{ log.summary }}</span>
            <span class="req-changelog-actor">{{ log.actor }}</span>
            <span class="req-changelog-time">{{ formatDate(log.createdAt, locale) }}</span>
          </li>
        </ul>
      </div>

      <!-- intent session / spec session / work session tab:复用聊天列 -->
      <template v-else>
        <p
          v-if="!expectedSessionId"
          class="intent-detail-empty"
          :data-testid="
            activeTab === 'intentSession'
              ? 'intent-detail-intent-session-empty'
              : activeTab === 'workSession'
                ? 'intent-detail-work-session-empty'
                : 'intent-detail-spec-session-empty'
          "
        >
          {{
            activeTab === 'intentSession'
              ? t('intent.intentSession.empty')
              : activeTab === 'workSession'
                ? t('intent.workSession.empty')
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

    <!-- 会话重置输入弹框 -->
    <ResetSessionDialog
      :open="resetDialogOpen"
      :title="resetDialogTitle"
      :message="resetDialogMessage"
      :placeholder="t('intent.resetSession.placeholder')"
      :confirm-label="t('intent.action.modifySession.label')"
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
  height: auto;
  flex-shrink: 0;
  padding: var(--sp-3);
  border-bottom: 1px solid var(--c-border);
  display: flex;
  flex-direction: column;
  align-items: stretch;
  box-sizing: border-box;
}
.intent-detail-titlebar {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: var(--sp-3);
}
.intent-detail-title-main {
  display: flex;
  align-items: baseline;
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: var(--sp-2);
  min-width: 0;
  text-align: left;
}
.intent-detail-title-meta {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--sp-2);
  min-width: 0;
  text-align: right;
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
  width: auto;
  max-width: min(58vw, 720px);
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  justify-content: flex-end;
  gap: var(--sp-2);
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 1px;
}
.intent-detail-actions .req-btn,
.intent-detail-actions .req-automate,
.intent-detail-actions .req-share {
  flex: 0 0 auto;
  white-space: nowrap;
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
.intent-detail-tab-item {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
  gap: var(--sp-1);
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
/* 工作会话 tab 标签内联运行中状态点(复用全局 .session-status 视觉,inline 对齐文字)。 */
.intent-detail-tab .session-status {
  display: inline-block;
  margin-left: var(--sp-1);
  vertical-align: middle;
}
@media (max-width: 640px) {
  .intent-detail-titlebar {
    grid-template-columns: minmax(0, 1fr);
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
  .intent-detail-actions {
    width: 100%;
    max-width: 100%;
    justify-content: flex-start;
  }
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

/* 主按钮两态语义色:writeSpec 维持主色蓝(生成动作),approveSpec 改用成功色
 * (审核放行)以与编写明确区分;白字保证对比度,data-action 为稳定可访问锚点。 */
.intent-detail-actions .req-btn.primary[data-action='approveSpec'] {
  background: var(--c-success);
  border-color: var(--c-success);
  color: #fff;
}

/* 变更日志:一行一条(操作类型标签 + 摘要 + 操作人 + 时间),倒序由数据保证。 */
.req-changelog {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.req-changelog-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--sp-2);
  padding: var(--sp-2);
  border: 1px solid var(--c-border);
  border-radius: 6px;
  font-size: var(--fs-caption);
}
.req-changelog-op {
  flex: 0 0 auto;
  padding: 0 var(--sp-1);
  border-radius: 4px;
  background: var(--c-bg-muted, rgba(127, 127, 127, 0.12));
  color: var(--c-text);
  white-space: nowrap;
}
.req-changelog-summary {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--c-text);
  word-break: break-word;
}
.req-changelog-actor {
  flex: 0 0 auto;
  color: var(--c-text-muted);
}
.req-changelog-time {
  flex: 0 0 auto;
  color: var(--c-text-muted);
  white-space: nowrap;
}
</style>
