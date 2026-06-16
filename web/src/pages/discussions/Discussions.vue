<script setup lang="ts">
/*
 * Discussions.vue — 讨论页容器。
 *
 * 桌面两栏容器:左侧讨论列表 + 右侧只读历史(标题栏 Start/Pause/Resume/Convert 动作 +
 * AgendaProgress + ChatMessages + composer)。所有数据与运行态由 App.vue 持有,经
 * props 注入;用户动作(打开/创建/开始/暂停/恢复/转需求/发言)经 emit 上抛。
 *
 * 移动端退化为两级 drill-down 栈:讨论列表 → 只读历史逐级滑入/返回(MobileStack)。
 * 选中态(activeId)推导栈顶 pane;桌面经 MobileStack 的 display:contents 两栏不变。
 */
import { computed } from 'vue'
import MobileStack from '../../components/MobileStack/MobileStack.vue'
import DiscussionList from './components/DiscussionList/DiscussionList.vue'
import AgendaProgress from './components/AgendaProgress/AgendaProgress.vue'
import SessionTitleBar from '../../components/SessionTitleBar/SessionTitleBar.vue'
import ChatMessages from '../../components/ChatMessages/ChatMessages.vue'
import {
  discussionRunLabel,
  type DispatchView,
  type DiscussionPhase,
} from '../../lib/discussion-view'
import { useTypedI18n } from '@/i18n'
import type { AgentConfig, Discussion } from '@ccc/shared/protocol'
import type { ChatMsg } from '../../lib/chat-types'

const { t } = useTypedI18n()

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
  // discussion stream (agenda + transcript + dispatch + composer).
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
  'update:input': [value: string]
  'submit-input': []
  // mobile drill-down: back to a previous pane
  'mobile-back': [targetKey: string]
}>()

// ---- Mobile drill-down state ----
// Two panes: discussion list → read-only history. The stack top is derived from the
// open discussion (activeId); the toolbar title for history shows the discussion's own
// title so the user keeps context after drilling in.
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
        <!-- Discussion tab: read-only history of the opened discussion. No input,
         status bar, or task panel — R1 has no live discussion session. -->
        <SessionTitleBar
          v-if="activeDiscussion"
          :active-title="activeDiscussion.title"
          :show-mode="false"
        >
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
          </template>
        </SessionTitleBar>
        <!-- Right pane, phase 1 — research: the live research stream while the read-only
         research agent works. No agenda/dispatch/composer (research isn't a discussion
         run). Switches to phase 2 when research ends and the orchestration auto-starts. -->
        <div
          v-if="activeDiscussion && phase === 'research'"
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
        <!-- Right pane, phase 2 — discussion: agenda + transcript + dispatch + composer. -->
        <template v-else>
          <!-- Agenda progress: subtopic list + current subtopic + completion, live as
           the organizer engine advances the agenda index. -->
          <AgendaProgress :discussion="activeDiscussion" />
          <ChatMessages
            :messages="messages"
            :has-active-session="activeId !== null"
            :actionable-permission-id="null"
            data-testid="discussion-stream"
            @respond="() => {}"
            @submit-ask="() => {}"
          />
        </template>
        <!-- Transient dispatch status at the chat tail: which agents are replying right
         now (broadcast shows several), plus any reply failures. Runtime-only — clears
         when the reply lands / the run ends / the discussion is switched. Discussion
         phase only. -->
        <div
          v-if="
            activeDiscussion &&
            phase === 'discussion' &&
            (dispatch.pending.length || dispatch.errors.length)
          "
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
         question that drives a new round once concluded. Hidden for a draft. -->
        <form
          v-if="
            activeDiscussion &&
            (activeDiscussion.status === 'in_progress' || activeDiscussion.status === 'completed')
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
    </template>
  </MobileStack>
</template>
