import { onMounted, onUnmounted, watch } from 'vue'
import { createWsClient } from '@/lib/ws'
import { parseDeepLink } from '@/lib/deep-link'
import { FILES_GIT_STATUS_INTERVAL_MS } from '@/lib/files-git-poller'
import { createGatedPoller } from '@/lib/poller'
import { useTypedI18n } from '@/i18n'
import { useModeLabel } from '@/composables/useModeLabel'
import { useAuth } from '@/composables/useAuth'
import { createState } from './state'
import { installPersistence } from './persistence'
import { installMessageHandler } from './message-handler'
import { installSessionActions } from './session-actions'
import { installIntentActions } from './intent-actions'
import { installQueueActions } from './queue-actions'
import { installDiscussionActions } from './discussion-actions'
import { installDeliveryActions } from './delivery-actions'
import { installAutomationActions } from './automation-actions'
import { installFilesActions } from './files-actions'
import { installChatActions } from './chat-actions'
import { installSettingsActions } from './settings-actions'
import { installWorkcenterActions } from './workcenter-actions'
import { installDashboardActions } from './dashboard-actions'
import { installShareActions } from './share-actions'
import { installUpdateActions } from './update-actions'
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
  installQueueActions(ctx)
  installDiscussionActions(ctx)
  installDeliveryActions(ctx)
  installAutomationActions(ctx)
  installFilesActions(ctx)
  installChatActions(ctx)
  installSettingsActions(ctx)
  installWorkcenterActions(ctx)
  installDashboardActions(ctx)
  installShareActions(ctx)
  installUpdateActions(ctx)

  onMounted(() => {
    // Read the startup hash for deep-link routing (before creating the WS client).
    // Parsed and stored as a one-shot pending target consumed by the `ready` handler.
    // Cleared immediately so it doesn't replay on reconnect.
    const rawHash = location.hash?.slice(1) ?? ''
    const parsed = parseDeepLink(rawHash)
    if (parsed) {
      ctx.pendingDeepLink.value = parsed
      // Clear the hash so it won't be re-read on next page load.
      history.replaceState(null, '', document.location.pathname + document.location.search)
    }

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
          ctx.send({ type: 'load_workspace_setting', workspaceName: ctx.intentsProject.value })
          ctx.send({ type: 'open_intent_session', workspaceName: ctx.intentsProject.value })
          ctx.send({ type: 'list_intent_sessions', workspaceName: ctx.intentsProject.value })
        } else if (ctx.activeTab.value === 'deliveries' && ctx.deliveriesProject.value) {
          // Re-fetch the workspace setting (the merge block gates on git-branch
          // mode), the list + badge count, and re-open the viewed delivery.
          ctx.send({ type: 'load_workspace_setting', workspaceName: ctx.deliveriesProject.value })
          ctx.send({ type: 'list_deliveries', workspaceName: ctx.deliveriesProject.value })
          if (ctx.activeDeliveryId.value)
            ctx.send({ type: 'get_delivery_detail', deliveryId: ctx.activeDeliveryId.value })
        } else if (ctx.activeTab.value === 'discussion' && ctx.discussionsProject.value) {
          // Re-fetch the list and re-open the viewed discussion (read path).
          ctx.send({ type: 'list_discussions', workspaceName: ctx.discussionsProject.value })
          if (ctx.activeDiscussionId.value)
            ctx.send({ type: 'open_discussion', discussionId: ctx.activeDiscussionId.value })
        } else if (ctx.activeTab.value === 'automations' && ctx.automationsProject.value) {
          // Re-fetch the automation list (read path) + settings (timezone preview).
          ctx.send({ type: 'list_automations', workspaceName: ctx.automationsProject.value })
          ctx.send({ type: 'get_settings' })
        } else if (ctx.activeTab.value === 'files') {
          // The file tree/tabs are a stateless read path that survives the reconnect
          // (expanded dirs / open files re-fetch on demand). The embedded ChatColumn
          // is a real work session, so re-select it to replay its history + stream.
          if (ctx.activeWorkspace.value && ctx.activeSession.value) {
            ctx.send({
              type: 'select_session',
              workspaceName: ctx.activeWorkspace.value,
              sessionId: ctx.activeSession.value,
            })
          }
        } else if (ctx.viewMode.value === 'workcenter') {
          if (ctx.workcenterPage.value === 'dashboard') {
            // The fresh socket dropped any in-flight snapshot request — reset the
            // coalescing flags and pull a clean snapshot.
            ctx.dashboardLoading.value = false
            ctx.dashboardRefreshPending.value = false
            ctx.loadDashboard()
          } else {
            // Re-fetch the event list (read path).
            ctx.reloadWorkcenter()
          }
        } else if (ctx.activeWorkspace.value && ctx.activeSession.value) {
          ctx.send({
            type: 'select_session',
            workspaceName: ctx.activeWorkspace.value,
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

    // Files Git-status auto-poll: only while ON the Files view AND the page is
    // visible AND the window is focused. Activating fetches immediately, then every
    // 15s; leaving/hiding/blurring pauses. Request coalescing lives in the action.
    const filesGitPoller = createGatedPoller({
      intervalMs: FILES_GIT_STATUS_INTERVAL_MS,
      isActive: () =>
        ctx.activeTab.value === 'files' &&
        document.visibilityState === 'visible' &&
        document.hasFocus(),
      request: () => ctx.requestFilesGitStatus(),
    })
    const syncFilesGitPoller = (): void => filesGitPoller.sync()
    // React to every gate: view switch (watch), visibility, and window focus/blur.
    const stopFilesTabWatch = watch(() => ctx.activeTab.value, syncFilesGitPoller)
    window.addEventListener('focus', syncFilesGitPoller)
    window.addEventListener('blur', syncFilesGitPoller)
    // Evaluate the current state once at mount, in case the app boots directly on
    // the Files view (the watch only fires on a subsequent change).
    syncFilesGitPoller()

    // Tab restored from background → fetch fresh status.
    const onVis = (): void => {
      if (document.visibilityState === 'visible') {
        ctx.send({ type: 'request_session_status' })
      }
      syncFilesGitPoller()
    }
    document.addEventListener('visibilitychange', onVis)

    // MarkdownText 文件链接导航事件:点击文件链接时切换到 files 页并打开文件。
    const onFileClick = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { path?: unknown; line?: unknown } | undefined
      if (!detail || typeof detail.path !== 'string' || !detail.path) return
      if (detail.line != null && typeof detail.line !== 'number') return
      ctx.navigateToFile(detail.path, detail.line as number | undefined)
    }
    document.addEventListener('c3:file-click', onFileClick)

    onUnmounted(() => {
      clearInterval(hbTimer)
      clearInterval(sessionsTimer)
      document.removeEventListener('visibilitychange', onVis)
      document.removeEventListener('c3:file-click', onFileClick)
      stopFilesTabWatch()
      window.removeEventListener('focus', syncFilesGitPoller)
      window.removeEventListener('blur', syncFilesGitPoller)
      filesGitPoller.stop()
    })
  })

  return ctx
}
