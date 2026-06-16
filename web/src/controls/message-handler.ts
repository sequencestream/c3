import type { ServerToClient, SessionRunStatus, SessionStatus } from '@ccc/shared/protocol'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import { resolveCurrentWorkspace } from '@/lib/current-workspace'
import {
  discussionMessageToChat,
  discussionMessagesToChat,
  reconcileRunState,
  reconcileResearchState,
  researchMessageToChat,
  applyDispatchStatus,
  clearDispatchAgent,
} from '@/lib/discussion-view'
import { applyTaskEvent, emptyTaskModel } from '@/lib/task-list'
import { advanceOnFailure, resolveAgentIndex } from '@/lib/agent-prefix'
import { activeSessionTitleFromSessions } from '@/lib/session-title-sync'
import { applyLocale, setStoredLocale, i18n } from '@/i18n'
import { translateUiError } from '@/i18n/errors'
import { transcriptToChat } from './transcript'
import type { AppCtx } from './types'

// Install the WebSocket message router (`handleMessage`) plus its status helpers
// onto the shared ctx. The router is the app's single inbound switch: it folds
// every `ServerToClient` event into reactive state. It reads cross-domain
// methods (restore/refresh/notify/flush) off the ctx via late binding.
export function installMessageHandler(ctx: AppCtx): void {
  const t = ctx.t
  const auth = ctx.auth
  const send = ctx.send
  const add = ctx.add
  const {
    workspaces,
    workspaceSettingOpen,
    currentWorkspaceSetting,
    detectedMainBranch,
    currentWorkspace,
    sessionsByWorkspace,
    activeWorkspace,
    activeSession,
    activeTitle,
    activeVendor,
    activeAgentSwitch,
    mode,
    codexPolicy,
    sessionStatus,
    messages,
    counters,
    availableCommands,
    activity,
    sideEffectPendingBySession,
    currentAgentIndexBySession,
    taskModel,
    selectedIntentSessionId,
    teamSessions,
    serverSettings,
    hostStatus,
    bindingStats,
    sessionCapabilities,
    vendorCapabilities,
    vendorModes,
    skillSupport,
    skillLinkStatuses,
    installingSkillIds,
    skillApprovalRequest,
    intents,
    intentSessions,
    intentSessionRunStates,
    intentsProject,
    automation,
    discussions,
    discussionRunState,
    researchState,
    activeDiscussion,
    activeDiscussionId,
    discussionMessages,
    discussionMaxSeq,
    researchMessages,
    researchMaxSeq,
    discussionDispatch,
    schedules,
    schedulesProject,
    selectedScheduleId,
    scheduleLogs,
    scheduleToolManifest,
    scheduleToolManifestLoading,
    scheduleToolManifestError,
    executionTranscripts,
    activeTab,
    workcenterEvents,
    intentActionErrorSeq,
    clearSideEffectPending,
  } = ctx

  ctx.handleMessage = (msg: ServerToClient): void => {
    switch (msg.type) {
      case 'login_result':
        auth.handleLoginResult(msg.result)
        // Login minted a token but this socket is still unauthenticated — force a
        // fresh handshake so `buildUrl()` carries the `?token=` and the server
        // admits us + emits `ready` (with the workspaces snapshot).
        if (msg.result.ok) ctx.reconnect()
        break
      case 'admin_password_result':
        if (msg.result.ok) {
          ctx.showToast(t('settings.auth.password.result.ok'))
          // Refresh settings so the panel sees the new "password set" signal.
          send({ type: 'get_settings' })
        } else {
          ctx.showToast(
            t(
              msg.result.code === 'not_authenticated'
                ? 'settings.auth.password.error.not_authenticated'
                : 'settings.auth.password.error.invalid',
            ),
          )
        }
        break
      case 'unauthenticated': {
        // The WS analogue of HTTP 401 — drop the local session, show the login
        // gate, and surface why (session expired / invalid / sign-in required).
        auth.handleUnauthenticated(msg.reason)
        const reasonKey =
          msg.reason === 'expired'
            ? 'auth.session.expired'
            : msg.reason === 'invalid'
              ? 'auth.session.invalid'
              : 'auth.session.missing'
        ctx.showToast(t(reasonKey))
        break
      }
      case 'ready':
        workspaces.value = msg.workspaces
        // Close workspace setting on reconnect — workspace may have changed.
        workspaceSettingOpen.value = false
        currentWorkspaceSetting.value = null
        detectedMainBranch.value = null
        ctx.applyStatuses(msg.statuses)
        // Restore the persisted current workspace (or fall back to most-recent),
        // then load its sessions for the sidebar.
        currentWorkspace.value = resolveCurrentWorkspace(ctx.readStoredWorkspace(), msg.workspaces)
        ctx.persistCurrentWorkspace()
        ctx.ensureSessions(currentWorkspace.value)
        // Pull settings up front so the new-session agent picker has the agent list +
        // per-vendor host-CLI status ready before the user clicks "+".
        send({ type: 'get_settings' })
        // Restore the intent / discussion / schedules view if a hard refresh left us in it.
        ctx.maybeRestoreIntents(msg.workspaces)
        ctx.maybeRestoreDiscussions(msg.workspaces)
        ctx.maybeRestoreSchedules(msg.workspaces)
        break
      case 'workspaces': {
        workspaces.value = msg.workspaces
        // If the current workspace was removed, fall back to the most-recent one.
        const resolved = resolveCurrentWorkspace(currentWorkspace.value, msg.workspaces)
        if (resolved !== currentWorkspace.value) {
          currentWorkspace.value = resolved
          ctx.persistCurrentWorkspace()
          ctx.ensureSessions(resolved)
        }
        break
      }
      case 'session_status':
        ctx.applyStatuses(msg.statuses)
        break
      case 'sessions':
        sessionsByWorkspace.value = {
          ...sessionsByWorkspace.value,
          [msg.workspaceId]: msg.sessions,
        }
        activeTitle.value =
          activeSessionTitleFromSessions({
            activeWorkspace: activeWorkspace.value,
            activeSession: activeSession.value,
            workspacePath: msg.workspaceId,
            sessions: msg.sessions,
          }) ?? activeTitle.value
        // A workspace switch cleared the chat column and flagged a pending re-bind.
        // Now that the new workspace's session list has landed, bind its first
        // session (or stay empty when it has none).
        if (ctx.flags.pendingConsoleBind && msg.workspaceId === currentWorkspace.value) {
          ctx.flags.pendingConsoleBind = false
          if (activeTab.value === 'console') ctx.bindConsoleSession()
        }
        break
      case 'session_selected':
        activeWorkspace.value = msg.workspaceId
        activeSession.value = msg.sessionId
        activeTitle.value = msg.title
        // The resolved agent vendor for the title dot (absent on comm sessions).
        activeVendor.value = msg.vendor ?? null
        // The same-vendor agent switcher data (absent ⇒ no switcher).
        activeAgentSwitch.value = msg.agentSwitch ?? null
        mode.value = msg.mode
        codexPolicy.value = msg.codexPolicy ?? null
        // Remember this as the console tab's own session ONLY when the selection
        // originated on the console tab.
        if (activeTab.value === 'console') {
          ctx.consoleSession.value = { workspacePath: msg.workspaceId, sessionId: msg.sessionId }
        }
        messages.value = []
        counters.nextId = 1
        // Commands are per-cwd; drop the old set so the next `/` refetches.
        availableCommands.value = []
        // Seed this session's live status from the authoritative snapshot.
        sessionStatus.value = { ...sessionStatus.value, [msg.sessionId]: msg.status }
        activity.value = { phase: 'idle' }
        // Clear any stale danger flag on (re)select.
        clearSideEffectPending(msg.sessionId)
        // Resolve the agent prefix from the session's bound agent.
        currentAgentIndexBySession.value = {
          ...currentAgentIndexBySession.value,
          [msg.sessionId]: resolveAgentIndex(
            serverSettings.value,
            msg.agentSwitch?.current.id,
            msg.agentSwitch?.current.id,
          ),
        }
        // Reset the task panel on every (re)select; the server re-sends the derived
        // `task_list` right after this message.
        taskModel.value = emptyTaskModel()
        selectedIntentSessionId.value = null
        for (const item of msg.history) {
          add(transcriptToChat(item))
        }
        // When on the intents tab, keep the middle-column selection in sync.
        if (activeTab.value === 'intents') {
          selectedIntentSessionId.value = msg.sessionId
        }
        break
      case 'session_started':
        if (activeSession.value === msg.clientId) {
          activeAgentSwitch.value = msg.agentSwitch ?? null
          activeSession.value = msg.sessionId
          // Carry the agent degradation index from the pending clientId to the real
          // sessionId.
          const prevIdx = currentAgentIndexBySession.value[msg.clientId] ?? 0
          const resolved = resolveAgentIndex(
            serverSettings.value,
            msg.agentSwitch?.current.id,
            msg.agentSwitch?.current.id,
          )
          currentAgentIndexBySession.value = {
            ...currentAgentIndexBySession.value,
            [msg.sessionId]: Math.max(prevIdx, resolved),
          }
          delete currentAgentIndexBySession.value[msg.clientId]
          send({ type: 'rebind_view', from: msg.clientId, to: msg.sessionId })
        }
        break
      case 'session_agent_changed': {
        if (msg.sessionId !== activeSession.value) break
        if (!msg.ok) {
          // Cross-vendor rejection — vendor is frozen (AC-R17).
          ctx.showToast(t('session.titleBar.agent.changeFailed'))
          break
        }
        // Re-target succeeded: rebuild the switcher locally.
        const s = activeAgentSwitch.value
        if (s) {
          const all = [s.current, ...s.candidates]
          const picked = all.find((c) => c.id === msg.agentId)
          if (picked) {
            activeAgentSwitch.value = {
              current: picked,
              candidates: all.filter((c) => c.id !== msg.agentId),
              currentUnavailable: false,
            }
            currentAgentIndexBySession.value = {
              ...currentAgentIndexBySession.value,
              [msg.sessionId]: resolveAgentIndex(serverSettings.value, msg.agentId, msg.agentId),
            }
          }
        }
        break
      }
      case 'mode_changed':
        mode.value = msg.mode
        codexPolicy.value = msg.codexPolicy ?? null
        break
      case 'commands':
        availableCommands.value = msg.commands
        break
      case 'workspace_setting':
        currentWorkspaceSetting.value = msg.config
        detectedMainBranch.value = msg.detectedMainBranch ?? null
        break
      case 'settings':
        serverSettings.value = msg.settings
        hostStatus.value = msg.hostStatus
        bindingStats.value = msg.bindingStats
        sessionCapabilities.value = msg.sessionCapabilities
        vendorCapabilities.value = msg.vendorCapabilities ?? null
        vendorModes.value = msg.vendorModes ?? null
        skillSupport.value = msg.skillSupport ?? null
        // Server is the single source of truth for UI language. Reconcile exactly
        // once and only when it disagrees with the live locale.
        if (msg.settings.uiLang && msg.settings.uiLang !== i18n.global.locale.value) {
          applyLocale(msg.settings.uiLang)
          setStoredLocale(msg.settings.uiLang)
        }
        break
      case 'skill_link_status':
        // Only adopt statuses for the workspace currently being edited.
        if (msg.workspaceId === currentWorkspace.value) {
          skillLinkStatuses.value = msg.statuses
        }
        break
      case 'skill_install_result':
        // Clear the row's busy flag, then re-fetch link status.
        installingSkillIds.value = installingSkillIds.value.filter((id) => id !== msg.skillId)
        if (msg.workspaceId === currentWorkspace.value) ctx.querySkillLinkStatus()
        break
      case 'skill_load_approval_request':
        skillApprovalRequest.value = {
          requestId: msg.requestId,
          kind: msg.kind,
          id: msg.id,
          vendor: msg.vendor,
          repo: msg.repo,
          ref: msg.ref,
          detail: msg.detail,
        }
        break
      case 'intents':
        intents.value = { ...intents.value, [msg.workspaceId]: msg.items }
        break
      case 'intent_sessions':
        intentSessions.value = { ...intentSessions.value, [msg.workspaceId]: msg.items }
        // Authoritatively reconcile the live run-state from the snapshot.
        if (msg.runStates) {
          intentSessionRunStates.value = msg.runStates
        }
        // Update the selected session id when the list changes.
        if (msg.workspaceId === intentsProject.value && msg.items.length > 0) {
          const active = msg.items.find((s) => s.sessionId === activeSession.value)
          if (active) {
            selectedIntentSessionId.value = active.sessionId
            // Sync the right-panel title with the DB title.
            if (active.title) {
              activeTitle.value = active.title
            }
          } else if (activeSession.value) {
            selectedIntentSessionId.value = activeSession.value
          } else {
            selectedIntentSessionId.value = msg.items[0].sessionId
          }
        }
        break
      case 'automation_status':
        automation.value = { ...automation.value, [msg.status.workspaceId]: msg.status }
        break
      case 'discussions': {
        discussions.value = { ...discussions.value, [msg.workspaceId]: msg.items }
        // Authoritatively reconcile the live run-state for THIS list's discussions.
        discussionRunState.value = reconcileRunState(
          discussionRunState.value,
          msg.items,
          msg.runStates,
        )
        // Same authoritative reconcile for the research phase (id → running).
        researchState.value = reconcileResearchState(
          researchState.value,
          msg.items,
          msg.researchStates,
        )
        // Keep the open discussion's status/conclusion in sync.
        if (activeDiscussionId.value) {
          const updated = msg.items.find((d) => d.id === activeDiscussionId.value)
          if (updated) activeDiscussion.value = updated
        }
        break
      }
      case 'schedules':
        schedules.value = { ...schedules.value, [msg.workspaceId]: msg.items }
        // After a run completes the server re-broadcasts the list; refresh the open
        // schedule's execution logs so history stays current.
        if (
          activeTab.value === 'schedules' &&
          schedulesProject.value === msg.workspaceId &&
          selectedScheduleId.value
        ) {
          send({ type: 'get_schedule_detail', scheduleId: selectedScheduleId.value })
        }
        break
      case 'schedule_detail':
        scheduleLogs.value = { ...scheduleLogs.value, [msg.schedule.id]: msg.logs }
        break
      case 'schedule_tool_manifest':
        scheduleToolManifest.value = { ...scheduleToolManifest.value, [msg.vendor]: msg.tools }
        scheduleToolManifestLoading.value = false
        scheduleToolManifestError.value = null
        break
      case 'execution_transcript':
        executionTranscripts.value = {
          ...executionTranscripts.value,
          [msg.executionId]: msg.items,
        }
        break
      case 'discussion_detail': {
        activeDiscussion.value = msg.discussion
        activeDiscussionId.value = msg.discussion.id
        // Render the persisted history as read-only chat bubbles (own id space).
        const agents = serverSettings.value?.agents ?? []
        const defaultAgentId = serverSettings.value?.defaultAgentId ?? SYSTEM_AGENT_ID
        discussionMessages.value = discussionMessagesToChat(
          msg.messages,
          agents,
          defaultAgentId,
          t,
        ).map((b, i) => ({
          ...b,
          id: i + 1,
        }))
        discussionMaxSeq.value = msg.messages.length ? msg.messages[msg.messages.length - 1].seq : 0
        // Research messages are runtime-only; reset the stream on every open/switch.
        researchMessages.value = []
        researchMaxSeq.value = 0
        ctx.persistViewMode()
        break
      }
      case 'discussion_message': {
        // A landed reply clears its author's in-flight (pending) status.
        const cleared = clearDispatchAgent(
          discussionDispatch.value[msg.discussionId],
          msg.message.speakerAgentId,
        )
        if (cleared !== discussionDispatch.value[msg.discussionId])
          discussionDispatch.value = {
            ...discussionDispatch.value,
            [msg.discussionId]: cleared!,
          }
        // Live append while the organizer engine runs.
        if (
          msg.discussionId === activeDiscussionId.value &&
          msg.message.seq > discussionMaxSeq.value
        ) {
          discussionMaxSeq.value = msg.message.seq
          const liveAgents = serverSettings.value?.agents ?? []
          const liveDefaultAgentId = serverSettings.value?.defaultAgentId ?? SYSTEM_AGENT_ID
          discussionMessages.value.push({
            ...discussionMessageToChat(msg.message, liveAgents, liveDefaultAgentId, t),
            id: discussionMessages.value.length + 1,
          })
        }
        break
      }
      case 'discussion_dispatch_status': {
        // Transient in-flight/failed status of dispatched agents.
        discussionDispatch.value = {
          ...discussionDispatch.value,
          [msg.discussionId]: applyDispatchStatus(discussionDispatch.value[msg.discussionId], msg),
        }
        break
      }
      case 'discussion_run_status': {
        // Track the live run-state; `ended` drops the entry.
        const next = { ...discussionRunState.value }
        if (msg.state === 'ended') delete next[msg.discussionId]
        else next[msg.discussionId] = msg.state
        discussionRunState.value = next
        // The run ending clears any lingering dispatch status for that discussion.
        if (msg.state === 'ended' && discussionDispatch.value[msg.discussionId]) {
          const d = { ...discussionDispatch.value }
          delete d[msg.discussionId]
          discussionDispatch.value = d
        }
        break
      }
      case 'research_message': {
        // Live append of a research turn while the read-only research agent works.
        if (
          msg.discussionId === activeDiscussionId.value &&
          msg.message.seq > researchMaxSeq.value
        ) {
          researchMaxSeq.value = msg.message.seq
          researchMessages.value.push({
            ...researchMessageToChat(msg.message, {
              researcher: t('discussion.speaker.researcher'),
              tool: (toolName) => t('discussion.research.toolActivity', { tool: toolName }),
            }),
            id: researchMessages.value.length + 1,
          })
        }
        break
      }
      case 'research_run_status': {
        // Track research liveness; `ended` drops the entry.
        const next = { ...researchState.value }
        if (msg.state === 'ended') delete next[msg.discussionId]
        else next[msg.discussionId] = 'running'
        researchState.value = next
        break
      }
      case 'user_text':
        add({ kind: 'user', text: msg.text })
        activity.value = { phase: 'thinking' }
        break
      case 'assistant_text':
        add({ kind: 'assistant', text: msg.text })
        activity.value = { phase: 'thinking' }
        break
      case 'notice':
        // A turn that produced no visible output (thinking-only).
        add({ kind: 'system', text: msg.text })
        break
      case 'tool_use':
        add({
          kind: 'tool-use',
          toolUseId: msg.toolUseId,
          toolName: msg.toolName,
          input: msg.input,
          // Audit hint from the driver path: vendor rule engine auto-allowed this tool.
          ...(msg.preApproved ? { preApproved: true } : {}),
          // User-interaction tool flag (AskUserQuestion / ExitPlanMode)
          ...(msg.isUserInteraction ? { isUserInteraction: true } : {}),
        })
        activity.value = { phase: 'tool', toolName: msg.toolName }
        break
      case 'tool_result':
        add({
          kind: 'tool-result',
          toolUseId: msg.toolUseId,
          content: msg.content,
          isError: msg.isError,
          // Carry the user-interaction flag from the matched tool-use
          ...(msg.isUserInteraction ? { isUserInteraction: true } : {}),
        })
        // Tool returned — the model is now deciding the next step.
        activity.value = { phase: 'thinking' }
        break
      // Task-list wire path (2026-06-07-009): server-derived.
      case 'task_list':
      case 'task_created':
      case 'task_updated':
      case 'task_deleted':
        taskModel.value = applyTaskEvent(taskModel.value, msg)
        break
      case 'permission_request':
        add({
          kind: 'permission',
          requestId: msg.requestId,
          toolName: msg.toolName,
          input: msg.input,
          decision: null,
          consensus: msg.consensus,
          // User-interaction tool flag (AskUserQuestion / ExitPlanMode)
          ...(msg.isUserInteraction ? { isUserInteraction: true } : {}),
        })
        activity.value = { phase: 'awaiting' }
        break
      case 'consensus_auto':
        add({
          kind: 'consensus',
          toolName: msg.toolName,
          input: msg.input,
          outcome: msg.outcome,
        })
        activity.value = { phase: 'thinking' }
        break
      case 'turn_end':
        // A turn finished — the session stays active for the next prompt.
        if (msg.reason === 'error') {
          add({
            kind: 'system',
            text: t('session.turn.error', { error: msg.error ?? t('common.unknown.label') }),
          })
          activity.value = { phase: 'error', message: msg.error ?? 'unknown' }
          // Danger state (AS-R19): the side-effect gate refused auto-resume.
          if (msg.side_effect_pending && activeSession.value) {
            sideEffectPendingBySession.value = {
              ...sideEffectPendingBySession.value,
              [activeSession.value]: true,
            }
          }
        } else {
          activity.value = { phase: 'idle' }
        }
        break
      case 'team_upgraded':
        // The viewed session became a persistent agent team.
        if (activeSession.value) {
          teamSessions.value = new Set(teamSessions.value).add(activeSession.value)
        }
        add({ kind: 'system', text: t('session.team.upgraded') })
        break
      case 'agent_failed':
        // The current agent hit a rate-limit/auth/connection error.
        add({
          kind: 'system',
          text: t('session.agent.failed', { agentName: msg.agentName, error: msg.error }),
        })
        // The failed agent is handing off to the next in the chain.
        if (activeSession.value) {
          const sid = activeSession.value
          currentAgentIndexBySession.value = {
            ...currentAgentIndexBySession.value,
            [sid]: advanceOnFailure(
              serverSettings.value,
              activeAgentSwitch.value?.current.id,
              currentAgentIndexBySession.value[sid] ?? 0,
              msg.agentId,
            ),
          }
        }
        break
      case 'all_agents_failed':
        // Every agent in the degradation chain failed. The turn ends with error.
        add({ kind: 'system', text: `— ${msg.message} —` })
        // Honestly note any cross-vendor fallback that was skipped.
        if (msg.crossVendorSkipped && msg.crossVendorSkipped.length > 0) {
          add({
            kind: 'system',
            text: t('session.agent.crossVendorSkipped', {
              count: msg.crossVendorSkipped.length,
              agents: msg.crossVendorSkipped.map((a) => a.agentName).join(', '),
            }),
          })
        }
        break
      case 'error':
        // Machine-readable code translated locally via the web i18n catalog (spec 003).
        if (msg.error.code.startsWith('intent.')) intentActionErrorSeq.value += 1
        add({ kind: 'system', text: `— ${translateUiError(msg.error)} —` })
        break
      case 'wait_user_events':
        workcenterEvents.value = msg.items
        break
    }
  }

  // Replace the status map and fire a notification when a *background* session
  // newly enters `awaiting_permission` (one you're not currently looking at).
  ctx.applyStatuses = (statuses: SessionRunStatus[]): void => {
    const prev = sessionStatus.value
    for (const s of statuses) {
      if (
        s.status === 'awaiting_permission' &&
        prev[s.sessionId] !== 'awaiting_permission' &&
        s.sessionId !== activeSession.value
      ) {
        ctx.notifyAwaitingPermission(s.sessionId)
      }
    }
    const next: Record<string, SessionStatus> = {}
    for (const s of statuses) next[s.sessionId] = s.status
    sessionStatus.value = next
    // A team session that drops to idle (or vanishes) has ended — clear its flag.
    if (teamSessions.value.size) {
      const live = new Set(
        [...teamSessions.value].filter((id) => {
          const st = next[id]
          return st === 'team' || st === 'running' || st === 'awaiting_permission'
        }),
      )
      if (live.size !== teamSessions.value.size) teamSessions.value = live
    }
    // Level-triggered flush backstop.
    ctx.flushIfReady()
  }

  // Browser notification for a background session needing approval.
  ctx.notifyAwaitingPermission = (id: string): void => {
    if (typeof Notification === 'undefined') return
    const show = (): Notification =>
      new Notification(t('permission.notification.title'), {
        body: t('permission.notification.body', { title: ctx.sessionTitleById(id) }),
      })
    if (Notification.permission === 'granted') show()
    else if (Notification.permission !== 'denied')
      Notification.requestPermission().then((p) => {
        if (p === 'granted') show()
      })
  }
}
