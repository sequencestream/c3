<script setup lang="ts">
/*
 * Discussions.vue — 讨论页容器。
 *
 * 桌面两栏容器:左侧纯讨论列表(选中) + 右侧「常驻标题栏 + Tab 面板」。标题栏
 * (讨论标题 + Start/Pause/Resume/Stop/Convert 动作 + 运行状态)跨 tab 不变;其下 Tab 栏
 * 切换互斥内容区:
 *  - 目标 / 上下文 / 研究 / 结论:markdown 字段(空则该 tab 不渲染),经 MarkdownText 渲染;
 *  - 研究会话:讨论的研究跑批本身就是一个正式会话,此 tab 以复用的 ChatColumn 渲染其完整
 *    transcript(含工具块)+ 状态栏(运行态/停止)+ 输入框;沿用意图详情会话 tab 的「单一
 *    活动会话」对齐规则(仅当全局活动会话 === 期望的 researchSessionId 才渲染,避免串台),
 *    未对齐时由本组件补发 open-research-session 交回控制层。仅在讨论已有 researchSessionId
 *    时出现;在此追问会 resume 该会话并改写「研究」tab 的内容;
 *  - 过程会话:现有右栏过程内容 —— research 阶段研究流 / discussion 阶段 AgendaProgress +
 *    讨论流 transcript + dispatch 在途/失败状态 + composer 输入框,逻辑整体归位于此;
 *  - 详情:结构化元信息(类型/状态/创建/完成时间)。
 * 过程会话 / 详情恒存在;研究运行中默认落「研究会话」,否则按 conclusion → process →
 * research → goal 取首个可见项。新建讨论时详情先于 researchSessionId 绑定到达,「研究会话」
 * tab 尚不存在而短暂落「过程会话」(其中正展示实时研究流),tab 一出现即自动跟随过去;
 * 用户本讨论内亲手点过任一 tab 后不再自动跟随,切讨论复位。
 *
 * 标题栏的启动按钮由 `launchAction` 单独驱动:draft 显示「开始」(研究未自动启动时的兜底),
 * `in_progress` 但没有存活运行(引擎报错 / 服务端重启打断)显示「重新运行」—— 两者都 emit
 * `start`,服务端据持久化转录/议程续跑,不追加任何消息。
 *
 * 「停止」按钮只在 draft / in_progress 两个非终态出现(与 Pause/Resume 并列),点击先弹
 * ConfirmDialog(danger)二次确认,确认后才 emit `cancel` —— 终止为 cancelled 不可撤销;
 * 确认框敞开期间讨论自行走到终态则收框且不放行,切讨论同样收框。
 *
 * 所有数据与运行态由 App.vue 持有,经 props 注入;用户动作(打开/创建/开始/暂停/恢复/
 * 停止/转需求/发言)经 emit 上抛。tab 选中态是页面内部展示状态,不写回 App 或协议。
 *
 * 移动端退化为两级 drill-down 栈:讨论列表 → 右栏 tab 化详情逐级滑入/返回(MobileStack)。
 */
import { computed, ref, watch } from 'vue'
import MobileStack from '../../components/MobileStack/MobileStack.vue'
import DiscussionList from './components/DiscussionList/DiscussionList.vue'
import AgendaProgress from './components/AgendaProgress/AgendaProgress.vue'
import SessionTitleBar from '../../components/SessionTitleBar/SessionTitleBar.vue'
import ChatMessages from '../../components/ChatMessages/ChatMessages.vue'
import ChatColumn from '../../components/ChatColumn/ChatColumn.vue'
import MarkdownText from '../../components/MarkdownText/MarkdownText.vue'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import {
  canCancelDiscussion,
  correctActiveTab,
  defaultDiscussionTab,
  discussionDetailTabs,
  discussionRunLabel,
  statusLabel as discussionStatusLabel,
  type DiscussionLaunchAction,
  type DiscussionPhase,
  type DiscussionTabKind,
  type DispatchView,
} from '../../lib/discussion-view'
import { formatDate } from '../../lib/intent-list-view'
import { listDiscussionTypes } from '@ccc/shared/discussion-types'
import { useTypedI18n } from '@/i18n'
import type {
  AgentConfig,
  Discussion,
  PromptImage,
  SessionAgentSwitch,
  SlashCommandInfo,
  VendorId,
} from '@ccc/shared/protocol'
import type { ChatMsg, PermissionMsg, RunActivity } from '../../lib/chat-types'
import type { PendingItem } from '../../lib/pending-queue'
import type { TaskListModel } from '../../lib/task-list'

const { t, locale } = useTypedI18n()

const props = defineProps<{
  discussions: Discussion[]
  activeId: string | null
  runState: Record<string, 'running' | 'paused'>
  activeDiscussion: Discussion | null
  activeRunState: 'running' | 'paused' | undefined
  messages: ChatMsg[]
  // The live research stream for the open discussion (shown while `phase === 'research'`).
  // Runtime-only; resets on switch (see App.vue).
  researchMessages: ChatMsg[]
  // Right-pane phase: 'research' shows the live research stream, 'discussion' shows the
  // discussion stream (agenda + transcript + dispatch + composer). Lives inside the
  // `process` tab.
  phase: DiscussionPhase
  // The manual launch action the title bar offers, or null for none: 'start' for a draft
  // whose research ended/died without auto-starting, 'restart' for an `in_progress`
  // discussion left dangling (engine error / server restart) with no live run.
  launchAction: DiscussionLaunchAction | null
  // Transient in-flight (pending) / failed status of dispatched agents, rendered in
  // the chat tail. Runtime-only; never part of the persisted transcript.
  dispatch: DispatchView
  input: string
  // All configured agents — passed through to the create modal's participant picker.
  agents: AgentConfig[]
  // The organizer (default agent) id — its participant row is locked on.
  defaultAgentId: string | null
  // ---- Research session tab (the shared chat column) ----
  // The globally active session id. The research chat renders only once it matches
  // the open discussion's `researchSessionId` (single-active-session alignment).
  activeSession: string | null
  sessionTitle: string
  sessionHasActive: boolean
  sessionMessages: ChatMsg[]
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
  vendor?: VendorId | null
  agentSwitch?: SessionAgentSwitch | null
}>()

const emit = defineEmits<{
  open: [discussionId: string]
  create: [
    payload: {
      type: string
      goal: string
      context: string
      participantAgentIds: string[]
      organizerAgentId: string
    },
  ]
  start: []
  pause: []
  resume: []
  cancel: []
  convert: []
  // 分享:由 App 组装深链复制(workspace/id/title/typeLabel 在上层)。
  share: []
  'update:input': [value: string]
  'submit-input': []
  // mobile drill-down: back to a previous pane
  'mobile-back': [targetKey: string]
  // ---- Research session tab → the existing session channel ----
  // Bind the global active session to the open discussion's research session.
  'open-research-session': [sessionId: string]
  respond: [m: PermissionMsg, decision: 'allow' | 'deny']
  'submit-ask': [m: PermissionMsg, answers: Record<string, string>]
  refresh: []
  'edit-queued': [item: PendingItem]
  'delete-queued': [id: number]
  'session-submit': [text: string, images: PromptImage[]]
  'session-enqueue': [text: string, images: PromptImage[]]
  stop: []
  continue: []
  'list-commands': []
}>()

// ---- Mobile drill-down state ----
// Two panes: discussion list → right-pane tab detail. The stack top is derived from the
// open discussion (activeId); the toolbar title for the detail pane shows the discussion's
// own title so the user keeps context after drilling in.
const mobilePanes = computed(() => [
  { key: 'discussions', title: t('discussion.list.title.label') },
  { key: 'history', title: props.activeDiscussion?.title ?? t('discussion.list.title.label') },
])
const mobileActiveKey = computed(() => (props.activeId ? 'history' : 'discussions'))
const mobileActiveToken = computed(() => props.activeId ?? 'discussions')

// Title-bar status label — pure display mapper (no state), same as App.vue used.
function statusLabel(status: Discussion['status']): string {
  return discussionRunLabel(status, props.activeRunState, t)
}

// `<agent>` segment for the active discussion's run-state row indicator: the first
// in-flight dispatched agent. Only the active discussion has a dispatch view, so the
// map carries at most one entry; other rows omit the agent (graceful fallback).
const runAgentNames = computed<Record<string, string>>(() => {
  const name = props.dispatch.pending[0]?.name
  return props.activeId && name ? { [props.activeId]: name } : {}
})

// ---- Right-pane tabs ----
// Visible tabs for the open discussion (empty markdown fields dropped; process + details
// always present). The active tab is page-internal state; the title bar stays constant.
const tabs = computed(() =>
  props.activeDiscussion ? discussionDetailTabs(props.activeDiscussion, t) : [],
)
const activeTab = ref<DiscussionTabKind>('process')
// 本讨论内用户是否亲手点过 tab。只有 tab 按钮点击算数(默认落点、可见性回落、
// 研究自动跟随都不算),切讨论时复位 —— 用来保证自动跟随永不把正在阅读的用户拽走。
const tabPickedByUser = ref(false)
function selectTab(kind: DiscussionTabKind): void {
  tabPickedByUser.value = true
  activeTab.value = kind
}

// Research liveness — the parent's right-pane phase is exactly「研究跑批在跑吗」.
const researchLive = computed(() => props.phase === 'research')

// On discussion switch, drop the manual-pick guard and land on the default tab: research
// running (with the session already bound) ⇒ 研究会话 (watch and steer the run), else
// conclusion → process → research → goal — a finished discussion opens on its conclusion,
// an in-progress one on the live process.
watch(
  () => props.activeDiscussion?.id,
  () => {
    tabPickedByUser.value = false
    activeTab.value = defaultDiscussionTab(tabs.value, researchLive.value)
  },
  { immediate: true },
)
// On live state changes within the same discussion — visible tabs (a markdown tab or the
// research session appears/disappears) or research liveness — re-run the correction. This
// is what lands the create flow on 研究会话: the detail arrives before the run binds a
// session id, so we open on `process` and follow over the moment the tab shows up (unless
// the user has picked a tab meanwhile). Research ending never jumps back.
watch([tabs, researchLive], ([next]) => {
  activeTab.value = correctActiveTab(
    next,
    activeTab.value,
    researchLive.value,
    tabPickedByUser.value,
  )
})

// ---- Research session chat column ----
// The session this tab expects to render, and whether the global active session has
// caught up with it. Rendering only on alignment is what keeps a fast discussion
// switch from cross-wiring two transcripts (same rule as the intent detail's tabs).
const expectedResearchSessionId = computed<string | null>(
  () => props.activeDiscussion?.researchSessionId ?? null,
)
const researchChatReady = computed<boolean>(
  () =>
    expectedResearchSessionId.value !== null &&
    props.activeSession === expectedResearchSessionId.value,
)
// While the research-session tab is open, ask the control layer to select that session
// whenever it is not the active one — including when the id only arrives later (the
// research run binds it mid-flight). Already aligned ⇒ no re-send.
watch(
  () => [activeTab.value, expectedResearchSessionId.value, props.activeSession] as const,
  () => {
    const expected = expectedResearchSessionId.value
    if (activeTab.value !== 'researchSession' || !expected) return
    if (props.activeSession !== expected) emit('open-research-session', expected)
  },
  // `immediate` covers the case where the tab is already the default at mount
  // (research running when the discussion opens) — the id watch above runs during
  // setup, so a lazy watcher would never see that first value.
  { immediate: true, flush: 'sync' },
)

// Readable discussion-type label for the details tab; unknown type falls back to its id.
const TYPE_LABEL = new Map(listDiscussionTypes().map((ty) => [ty.id, ty.label]))
function typeLabel(d: Discussion): string {
  return TYPE_LABEL.get(d.type) ?? d.type
}

// ---- Stop (terminate as cancelled) ----
// Visible for the two non-terminal statuses only; the dialog owns the irreversible
// confirmation, so `cancel` is emitted only after an explicit confirm. Reopening a
// different discussion closes a stale dialog (the confirm would otherwise apply to
// whatever is open now).
const stopVisible = computed(
  () => !!props.activeDiscussion && canCancelDiscussion(props.activeDiscussion.status),
)
const stopDialogOpen = ref(false)
watch(
  () => props.activeDiscussion?.id,
  () => {
    stopDialogOpen.value = false
  },
)
// A discussion that reaches a terminal state while the dialog is open (it concluded
// on its own) closes it — the same 「敞开期间动作已不可用则收框且不放行」 rule the
// intent title bar follows.
watch(stopVisible, (can) => {
  if (!can) stopDialogOpen.value = false
})
function confirmStop(): void {
  stopDialogOpen.value = false
  emit('cancel')
}
</script>

<template>
  <MobileStack
    :panes="mobilePanes"
    :active-key="mobileActiveKey"
    :active-token="mobileActiveToken"
    :back-label="t('discussion.list.title.label')"
    @back="(targetKey: string) => emit('mobile-back', targetKey)"
  >
    <template #discussions>
      <DiscussionList
        :discussions="discussions"
        :active-id="activeId"
        :run-state="runState"
        :run-agent-names="runAgentNames"
        :agents="agents"
        :default-agent-id="defaultAgentId"
        @open="(id: string) => emit('open', id)"
        @create="(payload) => emit('create', payload)"
      />
    </template>

    <template #history>
      <div class="content">
        <template v-if="activeDiscussion">
          <!-- Constant title bar: discussion title + Start/Pause/Resume/Convert actions
           + run-state label. Unchanged across tabs; actions depend only on the open
           discussion and its run state. -->
          <SessionTitleBar :active-title="activeDiscussion.title" :show-mode="false">
            <template #action>
              <!-- A draft auto-starts after research; Start is the manual fallback, shown
               only once research has ended/died and the orchestration hasn't started
               (e.g. research failed) — never while research is still running. The same
               button restarts a dangling `in_progress` discussion (engine error / server
               restart killed its run) — the engine resumes from the persisted transcript. -->
              <button
                v-if="launchAction"
                type="button"
                class="disc-start-btn"
                :data-testid="`discussion-launch-${launchAction}`"
                @click="emit('start')"
              >
                {{
                  launchAction === 'restart'
                    ? t('discussion.action.restart.label')
                    : t('discussion.action.start.label')
                }}
              </button>
              <button
                v-if="activeDiscussion.status === 'in_progress' && activeRunState === 'running'"
                type="button"
                class="disc-start-btn"
                @click="emit('pause')"
              >
                {{ t('discussion.action.pause.label') }}
              </button>
              <button
                v-else-if="activeDiscussion.status === 'in_progress' && activeRunState === 'paused'"
                type="button"
                class="disc-start-btn"
                @click="emit('resume')"
              >
                {{ t('discussion.action.resume.label') }}
              </button>
              <!-- Stop: terminate a draft / in-progress discussion as `cancelled`. Shown
               for those two statuses only (terminal ones hide it, including one that
               concluded while the dialog was open), and only ever emits after the
               ConfirmDialog below confirms — the action is irreversible. -->
              <button
                v-if="stopVisible"
                type="button"
                class="disc-start-btn disc-stop-btn"
                data-testid="discussion-stop"
                @click="stopDialogOpen = true"
              >
                {{ t('discussion.action.cancel.label') }}
              </button>
              <button
                v-if="activeDiscussion.status === 'completed'"
                type="button"
                class="disc-start-btn"
                @click="emit('convert')"
              >
                {{ t('discussion.action.convert.label') }}
              </button>
              <span class="disc-status" :class="activeDiscussion.status">
                {{ statusLabel(activeDiscussion.status) }}
              </span>
              <button
                type="button"
                class="share-btn"
                data-testid="share-button"
                :title="t('share.tooltip')"
                :aria-label="t('share.ariaLabel')"
                @click="emit('share')"
              >
                🔗
              </button>
            </template>
          </SessionTitleBar>

          <!-- Tab bar under the title bar: goal / context / research / conclusion (only
           when non-empty) + research session (only with a bound session) + process
           session + details. -->
          <nav class="disc-pane-tabs" data-testid="discussion-pane-tabs">
            <button
              v-for="tab in tabs"
              :key="tab.kind"
              type="button"
              class="disc-pane-tab"
              :class="{ active: tab.kind === activeTab }"
              :data-tab="tab.kind"
              :data-testid="`discussion-pane-tab-${tab.kind}`"
              :aria-pressed="tab.kind === activeTab"
              @click="selectTab(tab.kind)"
            >
              {{ tab.label }}
            </button>
          </nav>

          <!-- Research session tab: the discussion's research run rendered as a real
           session — full transcript with tool blocks, status bar (live state + Stop)
           and a composer whose follow-up resumes the research and rewrites the
           「研究」 tab. Only rendered once the global active session matches this
           discussion's research session, so a rapid discussion switch cannot show
           another discussion's transcript here. -->
          <div
            v-if="activeTab === 'researchSession'"
            class="disc-pane-process"
            data-testid="discussion-research-session"
          >
            <p v-if="!researchChatReady" class="disc-research-loading">
              {{ t('intent.chat.loading') }}
            </p>
            <ChatColumn
              v-else
              :active-title="sessionTitle"
              :vendor="vendor"
              :agent-switch="agentSwitch"
              :show-title-bar="false"
              :has-active-session="sessionHasActive"
              :session-bound="researchChatReady"
              :messages="sessionMessages"
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
              @respond="(m: PermissionMsg, d: 'allow' | 'deny') => emit('respond', m, d)"
              @submit-ask="
                (m: PermissionMsg, a: Record<string, string>) => emit('submit-ask', m, a)
              "
              @refresh="emit('refresh')"
              @edit-queued="(item: PendingItem) => emit('edit-queued', item)"
              @delete-queued="(id: number) => emit('delete-queued', id)"
              @submit="(text: string, imgs: PromptImage[]) => emit('session-submit', text, imgs)"
              @enqueue="(text: string, imgs: PromptImage[]) => emit('session-enqueue', text, imgs)"
              @stop="emit('stop')"
              @continue="emit('continue')"
              @list-commands="emit('list-commands')"
            />
          </div>

          <!-- Process tab: the existing right-pane process content, kept in one flex
           column so ChatMessages still fills and scrolls. A real <div> (not a <template>)
           anchors the v-if chain so happy-dom can unmount it cleanly on tab switch.
           Research phase shows the live research stream; discussion phase shows agenda +
           transcript + dispatch + composer. -->
          <div v-else-if="activeTab === 'process'" class="disc-pane-process">
            <div
              v-if="phase === 'research'"
              class="disc-research-stream"
              data-testid="research-stream"
            >
              <ChatMessages
                :messages="researchMessages"
                :has-active-session="activeId !== null"
                :actionable-permission-id="null"
                @respond="() => {}"
                @submit-ask="() => {}"
              />
            </div>
            <!-- Agenda progress: subtopic list + current subtopic + completion, live as
             the organizer engine advances the agenda index (discussion phase only). -->
            <AgendaProgress v-else :discussion="activeDiscussion" />
            <ChatMessages
              v-if="phase !== 'research'"
              :messages="messages"
              :has-active-session="activeId !== null"
              :actionable-permission-id="null"
              data-testid="discussion-stream"
              @respond="() => {}"
              @submit-ask="() => {}"
            />
            <!-- Transient dispatch status at the chat tail: which agents are replying right
             now (broadcast shows several), plus any reply failures. Runtime-only — clears
             when the reply lands / the run ends / the discussion is switched. Discussion
             phase only. -->
            <div
              v-if="phase === 'discussion' && (dispatch.pending.length || dispatch.errors.length)"
              class="disc-dispatch"
            >
              <p
                v-for="a in dispatch.pending"
                :key="`p-${a.id}`"
                class="disc-dispatch-pending"
                data-testid="discussion-pending"
              >
                <span class="disc-dispatch-dot" aria-hidden="true">●</span>
                {{ t('discussion.dispatch.replying', { name: a.name }) }}
              </p>
              <p
                v-for="e in dispatch.errors"
                :key="`e-${e.id}`"
                class="disc-dispatch-error"
                data-testid="discussion-error"
              >
                {{ t('discussion.dispatch.failed', { name: e.name, error: e.error }) }}
              </p>
            </div>
            <!-- Discussion composer: human interjection while running, or a follow-up
             question that drives a new round once concluded. Hidden for a draft. The
             input value comes from a parent prop, so its content survives tab switches. -->
            <form
              v-if="
                activeDiscussion.status === 'in_progress' || activeDiscussion.status === 'completed'
              "
              class="disc-composer"
              @submit.prevent="emit('submit-input')"
            >
              <input
                :value="input"
                type="text"
                class="disc-composer-input"
                :placeholder="
                  activeDiscussion.status === 'completed'
                    ? t('discussion.composer.followUp.placeholder')
                    : t('discussion.composer.speak.placeholder')
                "
                @input="emit('update:input', ($event.target as HTMLInputElement).value)"
              />
              <button type="submit" class="disc-start-btn" :disabled="!input.trim()">
                {{
                  activeDiscussion.status === 'completed'
                    ? t('discussion.composer.continue.label')
                    : t('discussion.composer.speak.label')
                }}
              </button>
            </form>
          </div>

          <!-- Details tab: structured meta (type / status / created / completed). -->
          <dl v-else-if="activeTab === 'details'" class="disc-pane-meta">
            <div class="disc-meta-row" data-testid="disc-meta-type">
              <dt>{{ t('discussion.meta.type.label') }}</dt>
              <dd>{{ typeLabel(activeDiscussion) }}</dd>
            </div>
            <div class="disc-meta-row" data-testid="disc-meta-status">
              <dt>{{ t('discussion.meta.status.label') }}</dt>
              <dd>{{ discussionStatusLabel(activeDiscussion.status, t) }}</dd>
            </div>
            <div class="disc-meta-row" data-testid="disc-meta-created">
              <dt>{{ t('discussion.meta.created.label') }}</dt>
              <dd>{{ formatDate(activeDiscussion.createdAt, locale) }}</dd>
            </div>
            <div
              v-if="activeDiscussion.completedAt"
              class="disc-meta-row"
              data-testid="disc-meta-completed"
            >
              <dt>{{ t('discussion.meta.completed.label') }}</dt>
              <dd>{{ formatDate(activeDiscussion.completedAt, locale) }}</dd>
            </div>
          </dl>

          <!-- Markdown tabs: goal / context / research / conclusion (one body at a time). -->
          <div v-else class="disc-pane-md" data-testid="discussion-pane-md">
            <template v-for="tab in tabs" :key="tab.kind">
              <MarkdownText
                v-if="tab.kind === activeTab && tab.body !== null"
                :text="tab.body"
                :markdown="true"
              />
            </template>
          </div>

          <!-- Stop confirmation: irreversible (cancelled is terminal like completed),
           so it is a danger dialog and nothing is sent until it confirms. -->
          <ConfirmDialog
            :open="stopDialogOpen"
            :title="t('discussion.cancel.title')"
            :message="t('discussion.cancel.confirm', { title: activeDiscussion.title })"
            :confirm-label="t('discussion.action.cancel.label')"
            :cancel-label="t('common.action.cancel.label')"
            danger
            @confirm="confirmStop"
            @cancel="stopDialogOpen = false"
          />
        </template>
      </div>
    </template>
  </MobileStack>
</template>

<style scoped>
/* Tab bar under the title bar — mirrors the automations right-pane tab strip. */
.disc-pane-tabs {
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid var(--c-border);
  padding: 0 var(--sp-2);
  overflow-x: auto;
  scrollbar-width: none;
}
.disc-pane-tabs::-webkit-scrollbar {
  display: none;
}
.disc-pane-tab {
  flex-shrink: 0;
  padding: 0 var(--sp-3);
  font: inherit;
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--c-text-muted);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  white-space: nowrap;
  transition:
    color 0.15s ease,
    border-color 0.15s ease;
}
.disc-pane-tab:hover {
  color: var(--c-text);
}
.disc-pane-tab.active {
  color: var(--c-primary-text);
  border-bottom-color: var(--c-primary);
}

/* Process tab: a flex column so ChatMessages (flex:1) fills and scrolls, with the
   agenda / dispatch / composer stacked around it as before. */
.disc-pane-process {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* Research stream wrapper: let the inner ChatMessages take the remaining height. */
.disc-research-stream {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* Research session tab, before the active session has caught up with the tab. */
.disc-research-loading {
  margin: 0;
  padding: var(--sp-3) var(--sp-4);
  font-size: var(--fs-body);
  color: var(--c-text-muted);
}

/* Markdown tab content: scrollable, comfortable reading width. */
.disc-pane-md {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-3) var(--sp-4);
  font-size: var(--fs-body);
  line-height: 1.6;
  word-break: break-word;
}
.disc-pane-md :deep(.md-body) > :first-child {
  margin-top: 0;
}
.disc-pane-md :deep(.md-body) > :last-child {
  margin-bottom: 0;
}

/* Details tab: type / status / timestamps label-value list. */
.disc-pane-meta {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: var(--sp-3) var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.disc-meta-row {
  display: flex;
  gap: var(--sp-2);
  font-size: var(--fs-body);
}
.disc-meta-row dt {
  flex-shrink: 0;
  width: 96px;
  color: var(--c-text-muted);
}
.disc-meta-row dd {
  margin: 0;
  color: var(--c-text);
}
</style>
