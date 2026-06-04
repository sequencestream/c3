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
import { useTypedI18n } from '@/i18n'

const { t } = useTypedI18n()

const props = defineProps<{
  hasActiveSession: boolean
  running: boolean
  /** Persistent agent-team session: the lead stays alive between turns. */
  teamActive: boolean
  connection: 'connecting' | 'open' | 'closed'
  activity: RunActivity
  /**
   * Display name of the agent the viewed session is currently running (client-
   * inferred, advances down the degradation chain on `agent_failed`). Rendered as
   * a prefix before the status label. Empty/undefined ⇒ no prefix (no leftover
   * separator) — the degradation path must never break the bar.
   */
  currentAgentName?: string
}>()

const emit = defineEmits<{ refresh: []; stop: [] }>()

// Stop control lives here now (not the composer). It's actionable whenever the
// viewed session has work to interrupt: an ordinary turn in flight OR a live
// team. Both route through the same `stop_run` link (App.stopRun); the title
// distinguishes "stop this turn" from "end the whole team".
const canStop = computed(() => props.running || props.teamActive)

// Dot color class + label + whether to spin, derived from running + activity.
const view = computed(() => {
  if (props.activity.phase === 'error') {
    return {
      dot: 'error',
      label: t('session.statusBar.error', { message: props.activity.message }),
      spin: false,
    }
  }
  if (!props.running) {
    return { dot: 'idle', label: t('session.statusBar.ready'), spin: false }
  }
  if (props.activity.phase === 'awaiting') {
    return { dot: 'awaiting', label: t('session.statusBar.awaiting'), spin: false }
  }
  // Team session between lead turns: not "thinking", but waiting on teammates.
  if (props.teamActive && props.activity.phase === 'idle') {
    return { dot: 'team', label: t('session.statusBar.teamRunning'), spin: true }
  }
  if (props.activity.phase === 'tool') {
    return {
      dot: 'running',
      label: t('session.statusBar.runningTool', { toolName: props.activity.toolName }),
      spin: true,
    }
  }
  return { dot: 'running', label: t('session.statusBar.thinking'), spin: true }
})

// Refresh re-selects the session, so it only works on an open socket; the
// auto-reconnect handles the closed case (and re-selects on reopen).
const canRefresh = computed(() => props.hasActiveSession && props.connection === 'open')
</script>

<template>
  <div v-if="hasActiveSession" class="status-bar">
    <span class="status-dot" :class="view.dot" />
    <span v-if="view.spin" class="status-spinner" />
    <span class="status-label">
      <span v-if="currentAgentName" class="status-agent">{{
        t('session.statusBar.agentPrefix', { agent: currentAgentName })
      }}</span>
      <span>{{ view.label }}</span>
    </span>
    <span v-if="connection === 'closed'" class="status-muted">{{
      t('session.statusBar.disconnected')
    }}</span>
    <button
      class="status-stop"
      :disabled="!canStop"
      :title="
        teamActive
          ? t('session.statusBar.stop.endTeamTooltip')
          : t('session.statusBar.stop.tooltip')
      "
      :aria-label="t('session.statusBar.stop.ariaLabel')"
      @click="emit('stop')"
    />
    <button
      class="status-refresh"
      :disabled="!canRefresh"
      :title="t('session.statusBar.refresh.tooltip')"
      @click="emit('refresh')"
    >
      ↻
    </button>
  </div>
</template>
