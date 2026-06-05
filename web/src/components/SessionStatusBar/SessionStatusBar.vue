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
import { sessionStatusIndicator, TONE_ICON } from '../../lib/status-indicator'
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
  /**
   * The viewed session's agent run hit a socket disconnect and is backing off
   * before a single auto-`resume` of the same run (SessionStatus `reconnecting`,
   * AVAIL-7). A transient running-state hold — distinct from `connection`, which
   * is the browser↔server WebSocket link (AVAIL-6).
   */
  reconnecting?: boolean
  /**
   * The last turn's auto-resume was refused by the side-effect gate: a write-class
   * `tool_use` (Edit/Write/Bash) was unclosed when the socket dropped, so c3 ended
   * the turn (`turn_end { side_effect_pending: true }`) and settled to idle. The
   * user must confirm no side effects and continue manually (AS-R19). Mutually
   * exclusive with `reconnecting` (that's the auto path; this is the refused path).
   */
  sideEffectPending?: boolean
}>()

const emit = defineEmits<{ refresh: []; stop: []; continue: [] }>()

// Stop control lives here now (not the composer). It's actionable whenever the
// viewed session has work to interrupt: an ordinary turn in flight OR a live
// team. Both route through the same `stop_run` link (App.stopRun); the title
// distinguishes "stop this turn" from "end the whole team".
const canStop = computed(() => props.running || props.teamActive)

// Unified indicator: the shared `sessionStatusIndicator` reduces running +
// activity + reconnecting + sideEffectPending to one `StatusIndicator` (tone,
// spin, status i18n key/params, optional agent), preserving the old precedence.
// Rendered as `<icon> <agent>.<status>` via the shared icon map + join key.
const indicator = computed(() =>
  sessionStatusIndicator({
    running: props.running,
    teamActive: props.teamActive,
    activity: props.activity,
    currentAgentName: props.currentAgentName,
    reconnecting: props.reconnecting,
    sideEffectPending: props.sideEffectPending,
  }),
)

const icon = computed(() => TONE_ICON[indicator.value.tone])

// `<agent>.<status>` text. The status segment resolves first (params for the
// error/tool variants); the agent prefix is joined via `statusIndicator.agentStatus`
// and dropped entirely when there's no resolved agent (no leftover dot).
const statusText = computed(() => {
  const ind = indicator.value
  const status = ind.statusParams ? t(ind.statusKey, ind.statusParams) : t(ind.statusKey)
  return ind.agent ? t('statusIndicator.agentStatus', { agent: ind.agent, status }) : status
})

// Refresh re-selects the session, so it only works on an open socket; the
// auto-reconnect handles the closed case (and re-selects on reopen).
const canRefresh = computed(() => props.hasActiveSession && props.connection === 'open')
</script>

<template>
  <div v-if="hasActiveSession" class="status-bar">
    <span class="status-indicator" :class="indicator.tone">
      <span class="status-icon" :class="{ spin: indicator.spin }" aria-hidden="true">{{
        icon
      }}</span>
      <span class="status-text">{{ statusText }}</span>
    </span>
    <span v-if="connection === 'closed'" class="status-muted">{{
      t('session.statusBar.disconnected')
    }}</span>
    <div class="status-actions">
      <button
        v-if="sideEffectPending"
        class="status-continue"
        :title="t('session.statusBar.continue.tooltip')"
        @click="emit('continue')"
      >
        {{ t('session.statusBar.continue.label') }}
      </button>
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
  </div>
</template>
