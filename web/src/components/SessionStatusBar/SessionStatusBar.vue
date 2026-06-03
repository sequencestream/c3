<script setup lang="ts">
/*
 * SessionStatusBar.vue — 输入框上方的细行状态条。
 *
 * 直观展示当前查看 session 的运行状态：思考中 / 正在执行<工具> / 等待授权 /
 * 出错 / 就绪。`running`（来自服务端广播的 sessionStatus）是权威开关，`activity`
 * （前端从事件流推断）决定细粒度文案。右侧刷新按钮在怀疑状态过期时重新同步视图。
 */
import { computed } from 'vue'
import type { RunActivity } from '../../lib/chat-types'

const props = defineProps<{
  hasActiveSession: boolean
  running: boolean
  /** Persistent agent-team session: the lead stays alive between turns. */
  teamActive: boolean
  connection: 'connecting' | 'open' | 'closed'
  activity: RunActivity
}>()

const emit = defineEmits<{ refresh: [] }>()

// Dot color class + label + whether to spin, derived from running + activity.
const view = computed(() => {
  if (props.activity.phase === 'error') {
    return { dot: 'error', label: `Error: ${props.activity.message}`, spin: false }
  }
  if (!props.running) {
    return { dot: 'idle', label: 'Ready', spin: false }
  }
  if (props.activity.phase === 'awaiting') {
    return { dot: 'awaiting', label: 'Awaiting permission', spin: false }
  }
  // Team session between lead turns: not "thinking", but waiting on teammates.
  if (props.teamActive && props.activity.phase === 'idle') {
    return { dot: 'team', label: 'Team running · waiting on teammates', spin: true }
  }
  if (props.activity.phase === 'tool') {
    return { dot: 'running', label: `Running ${props.activity.toolName}…`, spin: true }
  }
  return { dot: 'running', label: 'Thinking…', spin: true }
})

// Refresh re-selects the session, so it only works on an open socket; the
// auto-reconnect handles the closed case (and re-selects on reopen).
const canRefresh = computed(() => props.hasActiveSession && props.connection === 'open')
</script>

<template>
  <div v-if="hasActiveSession" class="status-bar">
    <span class="status-dot" :class="view.dot" />
    <span v-if="view.spin" class="status-spinner" />
    <span class="status-label">{{ view.label }}</span>
    <span v-if="connection === 'closed'" class="status-muted">· Disconnected, reconnecting…</span>
    <button
      class="status-refresh"
      :disabled="!canRefresh"
      title="Resync session status"
      @click="emit('refresh')"
    >
      ↻
    </button>
  </div>
</template>
