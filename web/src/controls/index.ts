import { onMounted, onUnmounted } from 'vue'
import { createWsClient } from '@/lib/ws'
import { useTypedI18n } from '@/i18n'
import { useModeLabel } from '@/composables/useModeLabel'
import { useAuth } from '@/composables/useAuth'
import { createState } from './state'
import { installPersistence } from './persistence'
import { installMessageHandler } from './message-handler'
import { installSessionActions } from './session-actions'
import { installIntentActions } from './intent-actions'
import { installDiscussionActions } from './discussion-actions'
import { installScheduleActions } from './schedule-actions'
import { installChatActions } from './chat-actions'
import { installSettingsActions } from './settings-actions'
import { installWorkcenterActions } from './workcenter-actions'
import type { AppCtx } from './types'

export type { AppCtx } from './types'

/**
 * The single composable behind App.vue. It builds the shared controller `ctx`
 * (reactive state + runtime plumbing + all domain actions), wires the WebSocket
 * client lifecycle, and returns the ctx for the template to bind against.
 *
 * The decomposition lives under `controls/`: `state.ts` owns every ref/computed,
 * each `*-actions.ts` installs its domain's handlers onto the ctx (cross-domain
 * calls resolve through late binding), and `message-handler.ts` owns the inbound
 * WS switch. App.vue stays a thin entry that destructures this object.
 */
export function useAppController(): AppCtx {
  const { t } = useTypedI18n()
  const modeLabel = useModeLabel()
  const auth = useAuth()

  const state = createState({ t, modeLabel, auth })

  // Build the shared ctx: spread the reactive state, then attach runtime plumbing.
  // Methods are populated by the installers below; the cast asserts that contract.
  const ctx = state as unknown as AppCtx
  ctx.client = null
  ctx.send = (msg): void => {
    ctx.client?.send(msg)
  }
  ctx.reconnect = (): void => {
    ctx.client?.reconnect()
  }
  ctx.t = t
  ctx.auth = auth

  installPersistence(ctx)
  installMessageHandler(ctx)
  installSessionActions(ctx)
  installIntentActions(ctx)
  installDiscussionActions(ctx)
  installScheduleActions(ctx)
  installChatActions(ctx)
  installSettingsActions(ctx)
  installWorkcenterActions(ctx)

  onMounted(() => {
    const client = createWsClient({
      onMessage: ctx.handleMessage,
      onStatus: (s) => (ctx.status.value = s),
      // Present the persisted session token on the handshake (`?token=`).
      getToken: auth.currentToken,
      // After a reconnect the server has a fresh per-connection view. Re-select
      // the active session so its history + live stream replay.
      onReopen: () => {
        // In the intent view, resume the comm session; otherwise re-select normally.
        if (ctx.activeTab.value === 'intents' && ctx.intentsProject.value) {
          ctx.send({ type: 'open_intent_chat', projectPath: ctx.intentsProject.value })
          ctx.send({ type: 'list_intent_sessions', projectPath: ctx.intentsProject.value })
        } else if (ctx.activeTab.value === 'discussion' && ctx.discussionsProject.value) {
          // Re-fetch the list and re-open the viewed discussion (read path).
          ctx.send({ type: 'list_discussions', projectPath: ctx.discussionsProject.value })
          if (ctx.activeDiscussionId.value)
            ctx.send({ type: 'open_discussion', discussionId: ctx.activeDiscussionId.value })
        } else if (ctx.activeTab.value === 'schedules' && ctx.schedulesProject.value) {
          // Re-fetch the schedule list (read path) + settings (timezone preview).
          ctx.send({ type: 'list_schedules', workspacePath: ctx.schedulesProject.value })
          ctx.send({ type: 'get_settings' })
        } else if (ctx.viewMode.value === 'workcenter') {
          // Re-fetch the pending event list (read path).
          if (ctx.currentWorkspace.value)
            ctx.send({ type: 'list_wait_user_events', projectPath: ctx.currentWorkspace.value })
        } else if (ctx.activeWorkspace.value && ctx.activeSession.value) {
          ctx.send({
            type: 'select_session',
            workspacePath: ctx.activeWorkspace.value,
            sessionId: ctx.activeSession.value,
          })
        }
        // Reconnect is a high-risk window for a stale status; pull a fresh snapshot.
        ctx.send({ type: 'request_session_status' })
      },
    })
    ctx.client = client

    // Let the auth store fire `login` / `logout` over this connection.
    auth.bindSender(client.send)

    // Session-layer status heartbeat.
    const hbTimer = setInterval(() => {
      ctx.send({ type: 'request_session_status' })
    }, 15_000)

    // While on the console tab, re-fetch the current workspace's sessions every 10s.
    const sessionsTimer = setInterval(() => {
      if (ctx.activeTab.value === 'console' && ctx.currentWorkspace.value) {
        ctx.refreshSessions(ctx.currentWorkspace.value)
      }
    }, 10_000)

    // Tab restored from background → fetch fresh status.
    const onVis = (): void => {
      if (document.visibilityState === 'visible') {
        ctx.send({ type: 'request_session_status' })
      }
    }
    document.addEventListener('visibilitychange', onVis)

    onUnmounted(() => {
      clearInterval(hbTimer)
      clearInterval(sessionsTimer)
      document.removeEventListener('visibilitychange', onVis)
    })
  })

  return ctx
}
