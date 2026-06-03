<script setup lang="ts">
/*
 * Discussions.vue — 讨论页容器。
 *
 * 纯容器:左侧讨论列表 + 右侧只读历史(标题栏 Start/Pause/Resume/Convert 动作 +
 * AgendaProgress + ChatMessages + composer)。所有数据与运行态由 App.vue 持有,经
 * props 注入;用户动作(打开/创建/开始/暂停/恢复/转需求/发言)经 emit 上抛。
 */
import DiscussionList from './components/DiscussionList/DiscussionList.vue'
import AgendaProgress from './components/AgendaProgress/AgendaProgress.vue'
import SessionTitleBar from '../../components/SessionTitleBar/SessionTitleBar.vue'
import ChatMessages from '../../components/ChatMessages/ChatMessages.vue'
import { discussionRunLabel } from '../../lib/discussion-view'
import type { Discussion } from '@ccc/shared/protocol'
import type { ChatMsg } from '../../lib/chat-types'

const props = defineProps<{
  discussions: Discussion[]
  activeId: string | null
  runState: Record<string, 'running' | 'paused'>
  activeDiscussion: Discussion | null
  activeRunState: 'running' | 'paused' | undefined
  messages: ChatMsg[]
  input: string
}>()

const emit = defineEmits<{
  open: [discussionId: string]
  create: [payload: { type: string; goal: string; context: string }]
  start: []
  pause: []
  resume: []
  convert: []
  'update:input': [value: string]
  'submit-input': []
}>()

// Title-bar status label — pure display mapper (no state), same as App.vue used.
function statusLabel(status: Discussion['status']): string {
  return discussionRunLabel(status, props.activeRunState)
}
</script>

<template>
  <DiscussionList
    :discussions="discussions"
    :active-id="activeId"
    :run-state="runState"
    @open="(id: string) => emit('open', id)"
    @create="(payload) => emit('create', payload)"
  />

  <div class="content">
    <!-- Discussion tab: read-only history of the opened discussion. No input,
         status bar, or task panel — R1 has no live discussion session. -->
    <SessionTitleBar
      v-if="activeDiscussion"
      :active-title="activeDiscussion.title"
      :show-mode="false"
    >
      <template #action>
        <!-- A draft auto-starts after research; the Start button stays as a
             manual fallback (e.g. research failed or stalled). -->
        <button
          v-if="activeDiscussion.status === 'draft'"
          type="button"
          class="disc-start-btn"
          @click="emit('start')"
        >
          Start
        </button>
        <button
          v-if="activeDiscussion.status === 'in_progress' && activeRunState === 'running'"
          type="button"
          class="disc-start-btn"
          @click="emit('pause')"
        >
          Pause
        </button>
        <button
          v-else-if="activeDiscussion.status === 'in_progress' && activeRunState === 'paused'"
          type="button"
          class="disc-start-btn"
          @click="emit('resume')"
        >
          Resume
        </button>
        <button
          v-if="activeDiscussion.status === 'completed'"
          type="button"
          class="disc-start-btn"
          @click="emit('convert')"
        >
          Convert to Requirement
        </button>
        <span class="disc-status" :class="activeDiscussion.status">
          {{ statusLabel(activeDiscussion.status) }}
        </span>
      </template>
    </SessionTitleBar>
    <!-- Agenda progress: subtopic list + current subtopic + completion, live as
         the organizer engine advances the agenda index. -->
    <AgendaProgress :discussion="activeDiscussion" />
    <ChatMessages
      :messages="messages"
      :has-active-session="activeId !== null"
      :actionable-permission-id="null"
      @respond="() => {}"
      @submit-ask="() => {}"
    />
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
            ? 'Ask a follow-up to start a new round…'
            : 'Speak in this discussion…'
        "
        @input="emit('update:input', ($event.target as HTMLInputElement).value)"
      />
      <button type="submit" class="disc-start-btn" :disabled="!input.trim()">
        {{ activeDiscussion.status === 'completed' ? 'Continue' : 'Speak' }}
      </button>
    </form>
  </div>
</template>
