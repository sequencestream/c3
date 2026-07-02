<script setup lang="ts">
/*
 * Discussions.vue — 讨论页容器。
 *
 * 桌面两栏容器:左侧纯讨论列表(选中) + 右侧「常驻标题栏 + Tab 面板」。标题栏
 * (讨论标题 + Start/Pause/Resume/Convert 动作 + 运行状态)跨 tab 不变;其下 Tab 栏
 * 切换互斥内容区:
 *  - 目标 / 上下文 / 研究 / 结论:markdown 字段(空则该 tab 不渲染),经 MarkdownText 渲染;
 *  - 过程:现有右栏过程内容 —— research 阶段研究流 / discussion 阶段 AgendaProgress +
 *    讨论流 transcript + dispatch 在途/失败状态 + composer 输入框,逻辑整体归位于此;
 *  - 详情:结构化元信息(类型/状态/创建/完成时间)。
 * 过程 / 详情恒存在;默认 tab 按 conclusion → process → research → goal 取首个可见项。
 *
 * 所有数据与运行态由 App.vue 持有,经 props 注入;用户动作(打开/创建/开始/暂停/恢复/
 * 转需求/发言)经 emit 上抛。tab 选中态是页面内部展示状态,不写回 App 或协议。
 *
 * 移动端退化为两级 drill-down 栈:讨论列表 → 右栏 tab 化详情逐级滑入/返回(MobileStack)。
 */
import { computed, ref, watch } from 'vue'
import MobileStack from '../../components/MobileStack/MobileStack.vue'
import DiscussionList from './components/DiscussionList/DiscussionList.vue'
import AgendaProgress from './components/AgendaProgress/AgendaProgress.vue'
import SessionTitleBar from '../../components/SessionTitleBar/SessionTitleBar.vue'
import ChatMessages from '../../components/ChatMessages/ChatMessages.vue'
import MarkdownText from '../../components/MarkdownText/MarkdownText.vue'
import {
  correctActiveTab,
  defaultDiscussionTab,
  discussionDetailTabs,
  discussionRunLabel,
  statusLabel as discussionStatusLabel,
  type DiscussionPhase,
  type DiscussionTabKind,
  type DispatchView,
} from '../../lib/discussion-view'
import { formatDate } from '../../lib/intent-list-view'
import { listDiscussionTypes } from '@ccc/shared/discussion-types'
import { useTypedI18n } from '@/i18n'
import type { AgentConfig, Discussion } from '@ccc/shared/protocol'
import type { ChatMsg } from '../../lib/chat-types'

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
  // Whether the manual Start fallback shows (a draft whose research ended/died and whose
  // orchestration hasn't started). Replaces the old `status === 'draft'` rule.
  showStart: boolean
  // Transient in-flight (pending) / failed status of dispatched agents, rendered in
  // the chat tail. Runtime-only; never part of the persisted transcript.
  dispatch: DispatchView
  input: string
  // All configured agents — passed through to the create modal's participant picker.
  agents: AgentConfig[]
  // The organizer (default agent) id — its participant row is locked on.
  defaultAgentId: string | null
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
  convert: []
  // 分享:由 App 组装深链复制(workspace/id/title/typeLabel 在上层)。
  share: []
  'update:input': [value: string]
  'submit-input': []
  // mobile drill-down: back to a previous pane
  'mobile-back': [targetKey: string]
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
  return discussionRunLabel(status, props.activeRunState)
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

// On discussion switch, land on the default tab (conclusion → process → research → goal):
// a finished discussion opens on its conclusion, an in-progress one on the live process.
watch(
  () => props.activeDiscussion?.id,
  () => {
    activeTab.value = defaultDiscussionTab(tabs.value)
  },
  { immediate: true },
)
// On live field changes within the same discussion (a markdown tab appears/disappears),
// keep the current tab if still visible, else fall back to the default chain.
watch(tabs, (next) => {
  activeTab.value = correctActiveTab(next, activeTab.value)
})

// Readable discussion-type label for the details tab; unknown type falls back to its id.
const TYPE_LABEL = new Map(listDiscussionTypes().map((ty) => [ty.id, ty.label]))
function typeLabel(d: Discussion): string {
  return TYPE_LABEL.get(d.type) ?? d.type
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
               (e.g. research failed) — never while research is still running. -->
              <button v-if="showStart" type="button" class="disc-start-btn" @click="emit('start')">
                {{ t('discussion.action.start.label') }}
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
           when non-empty) + process + details. -->
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
              @click="activeTab = tab.kind"
            >
              {{ tab.label }}
            </button>
          </nav>

          <!-- Process tab: the existing right-pane process content, kept in one flex
           column so ChatMessages still fills and scrolls. A real <div> (not a <template>)
           anchors the v-if chain so happy-dom can unmount it cleanly on tab switch.
           Research phase shows the live research stream; discussion phase shows agenda +
           transcript + dispatch + composer. -->
          <div v-if="activeTab === 'process'" class="disc-pane-process">
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
              <dd>{{ discussionStatusLabel(activeDiscussion.status) }}</dd>
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
        </template>
      </div>
    </template>
  </MobileStack>
</template>

<style scoped>
/* Tab bar under the title bar — mirrors the schedules right-pane tab strip. */
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
  color: var(--c-primary);
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
