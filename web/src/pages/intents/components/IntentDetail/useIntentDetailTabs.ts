import { computed, ref, watch } from 'vue'
import type { Intent, SessionStatus } from '@ccc/shared/protocol'
import { useTypedI18n } from '@/i18n'

export type DetailTab =
  | 'intent'
  | 'intentSession'
  | 'spec'
  | 'specSession'
  | 'specReviewSession'
  | 'workSession'
  | 'changelog'

/** The sub-tabs an external one-shot request (jump-to-source / post-Start-Work) may target. */
export type RequestedDetailSubTab =
  'intentSession' | 'specSession' | 'specReviewSession' | 'workSession' | 'spec'

export interface DetailTabItem {
  key: DetailTab
  label: string
}

/**
 * 意图详情页的会话 Tab 状态机——统一持有 activeTab、可见 Tab、默认 Tab 与当前期望会话。
 * 只编排页面状态并返回声明式结果:不直接操作 DOM、不持有全局活动会话;打开会话、读取
 * spec、加载日志均通过注入回调交回现有控制层。负责:SDD / 历史 Spec 可见性、空正文默认进
 * 意图会话、切换意图复位、隐藏 Tab 回退、外部 requestedSubTab 覆盖并恰好消费一次、changelog
 * / spec 的按需加载信号、四类会话 ID 异步回填补发一次 open、活动会话对齐去重、评审 Tab 的
 * 只读呈现开关,以及「编写 Spec 后待新会话创建再切」的一次性协调。
 */
export function useIntentDetailTabs(opts: {
  intent: () => Intent | null
  sddEnabled: () => boolean
  activeSession: () => string | null
  requestedSubTab: () => RequestedDetailSubTab | null | undefined
  intentLogsLength: () => number
  workSessionStatus: () => SessionStatus | null | undefined
  intentSessionStatus: () => SessionStatus | null | undefined
  specSessionStatus: () => SessionStatus | null | undefined
  specReviewSessionStatus: () => SessionStatus | null | undefined
  onReadSpec: (intentId: string, specPath: string) => void
  onListIntentLogs: (intentId: string) => void
  onOpenIntentSession: (sessionId: string) => void
  onOpenSpecSession: (intentId: string) => void
  onOpenSpecReviewSession: (intentId: string) => void
  onOpenWorkSession: (sessionId: string) => void
  onRequestedSubTabConsumed: () => void
}) {
  const {
    intent,
    sddEnabled,
    activeSession,
    requestedSubTab,
    intentLogsLength,
    workSessionStatus,
    intentSessionStatus,
    specSessionStatus,
    specReviewSessionStatus,
    onReadSpec,
    onListIntentLogs,
    onOpenIntentSession,
    onOpenSpecSession,
    onOpenSpecReviewSession,
    onOpenWorkSession,
    onRequestedSubTabConsumed,
  } = opts

  const { t } = useTypedI18n()

  const activeTab = ref<DetailTab>('intent')

  const TABS: DetailTabItem[] = [
    { key: 'intent', label: t('intent.tab.intent.label') },
    { key: 'intentSession', label: t('intent.tab.intentSession.label') },
    // 规范会话排在规范之前:真实工作流是先在会话里撰写/打磨规范,再回看规范正文。
    { key: 'specSession', label: t('intent.tab.specSession.label') },
    { key: 'spec', label: t('intent.tab.spec.label') },
    { key: 'specReviewSession', label: t('intent.tab.specReviewSession.label') },
    { key: 'workSession', label: t('intent.tab.workSession.label') },
    { key: 'changelog', label: t('intent.tab.changelog.label') },
  ]

  // spec / spec session 两 tab 的可见条件:workspace 开启 SDD,或当前意图已有历史 spec 数据
  // (specPath 或 specSessionId 非空)。SDD 关闭且无历史数据时隐藏,避免暴露两个空态 tab 入口。
  // 纯 UI 隐藏,不影响已有 spec 内容/会话的读取。
  const specTabsVisible = computed<boolean>(() => {
    if (sddEnabled()) return true
    const r = intent()
    return !!(r?.specPath || r?.specSessionId)
  })
  // 评审 tab 只是既有只读评审会话的查看入口:工作区开启 SDD 且当前意图确有
  // specReviewSessionId 才可见。不为没有评审会话的意图显示空态入口,也不因此创建评审会话。
  const specReviewSessionTabVisible = computed<boolean>(
    () => sddEnabled() && !!intent()?.specReviewSessionId,
  )
  // 工作会话 tab 仅当选中意图存在 lastWorkSessionId(最新工作会话)时可见;不做历史列表。
  const workSessionTabVisible = computed<boolean>(() => !!intent()?.lastWorkSessionId)
  const visibleTabs = computed<DetailTabItem[]>(() =>
    TABS.filter((tab) => {
      if (tab.key === 'spec' || tab.key === 'specSession') return specTabsVisible.value
      if (tab.key === 'specReviewSession') return specReviewSessionTabVisible.value
      if (tab.key === 'workSession') return workSessionTabVisible.value
      return true
    }),
  )
  function isTabVisible(tab: DetailTab): boolean {
    return visibleTabs.value.some((x) => x.key === tab)
  }

  // 工作会话 tab 标签的运行中状态点:非 idle/未知(null)才显示,值即 .session-status 的类。
  const workSessionStatusDot = computed<SessionStatus | null>(() => {
    const st = workSessionStatus()
    return st && st !== 'idle' ? st : null
  })
  // 意图会话 tab 标签的运行中状态点:与工作会话一致,非 idle/未知(null)才显示。
  // reconnecting 是退避重连的活跃中间态,同样显示。
  const intentSessionStatusDot = computed<SessionStatus | null>(() => {
    const st = intentSessionStatus()
    return st && st !== 'idle' ? st : null
  })
  // 编写规范(spec 会话)tab 标签的运行中状态点:与上面两类会话同构,非 idle/未知(null)
  // 才显示。仅供标签呈现,不参与直接编辑 spec 的门禁判定。
  const specSessionStatusDot = computed<SessionStatus | null>(() => {
    const st = specSessionStatus()
    return st && st !== 'idle' ? st : null
  })
  // 评审(spec_review 会话)tab 标签的运行中状态点:与其余三类会话同构,非 idle/未知
  // (null)才显示。只读会话同样会运行(机器评审中),状态点让用户看到评审正在进行。
  const specReviewSessionStatusDot = computed<SessionStatus | null>(() => {
    const st = specReviewSessionStatus()
    return st && st !== 'idle' ? st : null
  })

  // spec tab「我要修改」提交后,待新 spec 会话真正创建(specSessionId 回填为新非空值)
  // 再自动切到 spec session tab 的一次性状态。记录待切意图 id 与提交时刻的旧 specSessionId,
  // 用于判定"是否换了新会话"。提交失败/未创建时 specSessionId 不变,该状态不触发切换。
  const pendingSpecSwitch = ref<{ intentId: string; oldSpecSessionId: string | null } | null>(null)
  function markPendingSpecSwitch(intentId: string, oldSpecSessionId: string | null): void {
    pendingSpecSwitch.value = { intentId, oldSpecSessionId }
  }

  // 切到会话/spec tab 时按需读取 spec;会话打开由下方 watch 统一处理,避免
  // 「切 tab 时已有 id」与「id 在激活 tab 下回填」两条路径重复发出 open。
  function selectTab(tab: DetailTab): void {
    // 可见性门:不可见 tab(SDD 关闭且无历史 spec 数据时的 spec/specSession)不切换、不触发副作用。
    // 外部一次性请求(requestedSubTab)命中不可见 tab 时由此静默忽略,消费仍在 watcher 内照常进行。
    if (!isTabVisible(tab)) return
    activeTab.value = tab
    const r = intent()
    if (!r) return
    if (tab === 'spec' && r.specPath) {
      onReadSpec(r.id, r.specPath)
    }
    // changelog 懒加载:该意图的日志尚未拉过(空)才发起,已有缓存直接渲染。
    if (tab === 'changelog' && intentLogsLength() === 0) {
      onListIntentLogs(r.id)
    }
  }

  // 会话 tab 激活期间,sessionId 可能在切 tab 后才由服务端回填。统一监听 tab、
  // 当前意图的两个 id 与活动会话:期望 id 存在但尚未对齐时补发 open;已对齐则不发。
  function openActiveSessionIfNeeded(): void {
    const r = intent()
    if (!r) return
    if (
      activeTab.value === 'intentSession' &&
      r.intentSessionId &&
      activeSession() !== r.intentSessionId
    ) {
      onOpenIntentSession(r.intentSessionId)
    } else if (
      activeTab.value === 'specSession' &&
      r.specSessionId &&
      activeSession() !== r.specSessionId
    ) {
      onOpenSpecSession(r.id)
    } else if (
      activeTab.value === 'specReviewSession' &&
      r.specReviewSessionId &&
      activeSession() !== r.specReviewSessionId
    ) {
      // 评审会话的恢复必须走服务端按意图解析的专用入口(只读 runtime + 评审绑定事实),
      // 故传的是意图 id 而非会话 id。
      onOpenSpecReviewSession(r.id)
    } else if (
      activeTab.value === 'workSession' &&
      r.lastWorkSessionId &&
      activeSession() !== r.lastWorkSessionId
    ) {
      onOpenWorkSession(r.lastWorkSessionId)
    }
  }

  // props 变化(SDD 开关切换 / 意图 spec 字段变化)导致当前激活 tab 不再可见时回退到 intent。
  // 意图切换时的复位由下方 intent.id watch 负责,intent tab 恒可见故与本 watch 不冲突。
  watch(visibleTabs, () => {
    if (!isTabVisible(activeTab.value)) activeTab.value = 'intent'
  })

  // 选中意图切换:复位默认 tab。默认 tab 按新意图正文取舍:正文为空(含仅空白)时无内容可看,
  // 直接落到意图会话方便开始对话;正文非空仍落到 intent tab 先看内容。只在 id 变化时判定,
  // 同一意图的正文增删不抢占用户当前 tab。切走意图同时清除「我要修改」待切状态,避免新会话
  // 回填后误切回上一个意图的 spec session。
  watch(
    () => intent()?.id,
    () => {
      activeTab.value = (intent()?.content ?? '').trim() === '' ? 'intentSession' : 'intent'
      pendingSpecSwitch.value = null
    },
  )

  // 外部子 tab 请求(WorkCenter 溯源跳转 / Start Work 后落到工作会话),在 intent 选中复位 tab 后再切换。
  watch(
    () => requestedSubTab(),
    (tab) => {
      if (tab) {
        selectTab(tab)
        onRequestedSubTabConsumed()
      }
    },
  )

  // spec tab「我要修改」提交后,以新 spec 会话实际创建为触发条件自动切到 spec session tab:
  // 待切状态存在、意图匹配、且 specSessionId 变为非空且不同于提交时记录的旧值时切换并清除。
  // 切到该 tab 后,openActiveSessionIfNeeded 会自动补发 open-spec-session 绑定聊天列。
  watch(
    () => intent()?.specSessionId,
    (specSessionId) => {
      const pending = pendingSpecSwitch.value
      if (!pending) return
      const r = intent()
      if (!r || r.id !== pending.intentId) return
      if (specSessionId && specSessionId !== pending.oldSpecSessionId) {
        pendingSpecSwitch.value = null
        selectTab('specSession')
      }
    },
  )

  watch(
    () =>
      [
        activeTab.value,
        intent()?.id,
        intent()?.intentSessionId,
        intent()?.specSessionId,
        intent()?.specReviewSessionId,
        intent()?.lastWorkSessionId,
        activeSession(),
      ] as const,
    openActiveSessionIfNeeded,
    { flush: 'sync' },
  )

  // 当前会话 tab 期望的会话 id,以及活动会话是否已对齐(对齐才渲染聊天列)。
  const expectedSessionId = computed<string | null>(() => {
    const r = intent()
    if (!r) return null
    if (activeTab.value === 'intentSession') return r.intentSessionId
    if (activeTab.value === 'specSession') return r.specSessionId
    if (activeTab.value === 'specReviewSession') return r.specReviewSessionId
    if (activeTab.value === 'workSession') return r.lastWorkSessionId
    return null
  })
  const chatReady = computed<boolean>(
    () => expectedSessionId.value !== null && activeSession() === expectedSessionId.value,
  )
  const firstIntentTurn = computed<boolean>(
    () => activeTab.value === 'intentSession' && expectedSessionId.value === null,
  )

  // 意图会话 / spec 会话的权限模式由服务端钉死为默认(权限网关必须触发),标题栏
  // 仍展示当前生效值但只读;只有工作会话 tab 的模式可切换。
  const modeLocked = computed<boolean>(() => activeTab.value !== 'workSession')

  // 评审 tab 是纯回放:整条聊天列进入只读态(无输入、无待发队列、无运行控制、
  // 无权限决策控件)。与 spec_review 的服务端权限模型一致,前端只负责不呈现这些入口。
  const chatReadonly = computed<boolean>(() => activeTab.value === 'specReviewSession')

  return {
    activeTab,
    visibleTabs,
    isTabVisible,
    workSessionStatusDot,
    intentSessionStatusDot,
    specSessionStatusDot,
    specReviewSessionStatusDot,
    expectedSessionId,
    chatReady,
    chatReadonly,
    firstIntentTurn,
    modeLocked,
    selectTab,
    markPendingSpecSwitch,
  }
}
