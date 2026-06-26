import type { IntentStatus } from '@ccc/shared/protocol'
import {
  beginDevLaunch,
  reduceDevLaunch,
  DEV_LAUNCH_MIN_DWELL_MS,
  DEV_LAUNCH_SAFETY_TIMEOUT_MS,
  type DevLaunchEvent,
} from '@/lib/dev-launch-view'
import {
  beginSpecLaunch,
  reduceSpecLaunch,
  SPEC_LAUNCH_MIN_DWELL_MS,
  SPEC_LAUNCH_SAFETY_TIMEOUT_MS,
  type SpecLaunchEvent,
} from '@/lib/spec-launch-view'
import {
  shouldJumpAfterDevLaunch,
  resolveJumpTargetSessionId,
  resolvePendingWorkSessionSelect,
  WORK_SESSION_JUMP_DELAY_MS,
} from '@/lib/work-session-jump'
import type { DepType } from './state'
import type { AppCtx } from './types'

// Install intent-tab actions (filter / lifecycle / comm-session list) onto the ctx.
export function installIntentActions(ctx: AppCtx): void {
  const send = ctx.send
  const t = ctx.t
  const { intentsProject, selectedIntentSessionId, activeTab } = ctx

  // Fold one event through the overlay reducer, swap in the next model, and run
  // its close side-effects (clear timers + surface a toast on failure/timeout;
  // success closes silently). Shared by the dwell/safety timers and the
  // message handler's stage / terminal events.
  ctx.dispatchDevLaunch = (ev: DevLaunchEvent): void => {
    // The model being folded carries the target intentId; capture it before the
    // reducer swaps it out so the `ready` close can arm the jump in both paths
    // (immediate close, or close via the later dwell-complete event).
    const prev = ctx.devLaunch.value
    const tr = reduceDevLaunch(prev, ev)
    ctx.devLaunch.value = tr.model
    if (!tr.model) ctx.clearDevLaunchTimers()
    else if (tr.model.pendingCloseReason && !ctx.devLaunchTimers.dwell) {
      const dwellRemaining = Math.max(0, tr.model.visibleAt + DEV_LAUNCH_MIN_DWELL_MS - Date.now())
      ctx.devLaunchTimers.dwell = setTimeout(() => {
        ctx.dispatchDevLaunch({ kind: 'dwell-complete', now: Date.now() })
      }, dwellRemaining)
    }
    if (tr.closedReason === 'failed') ctx.showToast(t('intent.devLaunch.failed'))
    else if (tr.closedReason === 'timeout') ctx.showToast(t('intent.devLaunch.timeout'))
    // Success terminal: after the overlay closed silently, bridge launched → watch.
    else if (shouldJumpAfterDevLaunch(tr.closedReason) && prev)
      ctx.armWorkSessionJump(prev.intentId)
  }
  ctx.dispatchSpecLaunch = (ev: SpecLaunchEvent): void => {
    const tr = reduceSpecLaunch(ctx.specLaunch.value, ev)
    ctx.specLaunch.value = tr.model
    if (!tr.model) ctx.clearSpecLaunchTimers()
    else if (tr.model.pendingCloseReason && !ctx.specLaunchTimers.dwell) {
      ctx.specLaunchTimers.dwell = setTimeout(
        () => ctx.dispatchSpecLaunch({ kind: 'dwell-complete', now: Date.now() }),
        Math.max(0, tr.model.visibleAt + SPEC_LAUNCH_MIN_DWELL_MS - Date.now()),
      )
    }
    if (tr.closedReason === 'failed') ctx.showToast(t('intent.specLaunch.failed'))
    else if (tr.closedReason === 'timeout') ctx.showToast(t('intent.specLaunch.timeout'))
  }

  // Arm the post-`ready` jump: after the deliberate ~1s "已就绪" buffer, flip to
  // the console tab and select this intent's newly-launched work session
  // (`lastDevSessionId`). If the target is already loaded, select it now;
  // otherwise stage a one-shot pending request and refresh the list so it's
  // applied once the session lands (see `consumePendingWorkSessionSelect`). The
  // timer lives in `devLaunchTimers` so a new launch / overlay close cancels it.
  ctx.armWorkSessionJump = (intentId: string): void => {
    const workspace = ctx.currentWorkspace.value
    if (!workspace) return
    const targetSessionId = resolveJumpTargetSessionId(intentId, ctx.intents.value[workspace] ?? [])
    if (!targetSessionId) return
    ctx.devLaunchTimers.jump = setTimeout(() => {
      ctx.devLaunchTimers.jump = null
      ctx.enterConsole()
      const ready = resolvePendingWorkSessionSelect(targetSessionId, ctx.currentSessions.value)
      if (ready) {
        ctx.selectSession(workspace, ready)
      } else {
        ctx.requestedWorkSessionId.value = targetSessionId
        ctx.refreshSessions(workspace)
      }
    }, WORK_SESSION_JUMP_DELAY_MS)
  }

  // Consume the one-shot pending work-session select once its target lands in the
  // current workspace's session list: select it and clear the request. A target
  // that never appears is silently dropped (the works page keeps its own default).
  ctx.consumePendingWorkSessionSelect = (): void => {
    const req = ctx.requestedWorkSessionId.value
    const workspace = ctx.currentWorkspace.value
    if (!req || !workspace) return
    const hit = resolvePendingWorkSessionSelect(req, ctx.currentSessions.value)
    if (!hit) return
    ctx.requestedWorkSessionId.value = null
    ctx.selectSession(workspace, hit)
  }

  ctx.openIntents = (path: string): void => {
    activeTab.value = 'intents'
    intentsProject.value = path
    ctx.persistViewMode()
    // The response carries both the comm `session_selected` and the list.
    send({ type: 'open_intent_chat', workspaceId: path })
    // Populate the middle-column intent session list.
    send({ type: 'list_intent_sessions', workspaceId: path })
  }

  // Jump from a work session's title bar to its linked intent: navigate to the
  // intents tab (which loads the list) and stage a one-shot select request that
  // Intents.vue applies once the target lands in its list. If the intent was
  // deleted / never loads, Intents.vue falls back to its default selection.
  ctx.openLinkedIntent = (path: string, intentId: string): void => {
    ctx.openIntents(path)
    ctx.requestedIntentId.value = intentId
  }

  // "+" in the intent title bar: start a brand-new comm session.
  ctx.newIntentChat = (): void => {
    if (!intentsProject.value) return
    send({ type: 'new_intent_chat', workspaceId: intentsProject.value })
  }

  // Select an existing intent communication session by id.
  ctx.selectIntentSession = (sessionId: string): void => {
    if (!intentsProject.value) return
    selectedIntentSessionId.value = sessionId
    send({ type: 'open_intent_chat', workspaceId: intentsProject.value, sessionId })
  }

  ctx.renameIntentSession = (sessionId: string, title: string): void => {
    if (!intentsProject.value) return
    send({
      type: 'rename_intent_session',
      workspaceId: intentsProject.value,
      sessionId,
      title,
    })
  }

  // Delete an intent communication session.
  ctx.deleteIntentSession = (sessionId: string): void => {
    if (!intentsProject.value) return
    send({ type: 'delete_intent_session', workspaceId: intentsProject.value, sessionId })
  }

  ctx.setIntentFilter = (status: IntentStatus | null): void => {
    if (!intentsProject.value) return
    send({
      type: 'list_intents',
      workspaceId: intentsProject.value,
      ...(status ? { status } : {}),
    })
  }

  ctx.refineIntent = (intentId: string): void => {
    if (!intentsProject.value) return
    send({
      type: 'refine_intent',
      workspaceId: intentsProject.value,
      intentId,
    })
  }

  ctx.writeSpec = (intentId: string): void => {
    if (!intentsProject.value) return
    send({
      type: 'write_spec',
      workspaceId: intentsProject.value,
      intentId,
    })
    ctx.clearSpecLaunchTimers()
    ctx.specLaunch.value = beginSpecLaunch(intentId, Date.now())
    ctx.specLaunchTimers.safety = setTimeout(
      () => ctx.dispatchSpecLaunch({ kind: 'timeout', now: Date.now() }),
      SPEC_LAUNCH_SAFETY_TIMEOUT_MS,
    )
  }

  ctx.approveSpec = (intentId: string): void => {
    if (!intentsProject.value) return
    send({
      type: 'approve_spec',
      workspaceId: intentsProject.value,
      intentId,
    })
  }

  // Open an intent's spec-authoring session for the detail's `spec session` tab.
  // The server restores the write-confined spec runtime and replies with a
  // session_selected; the chat column rebinds to it like any other session.
  ctx.openSpecSession = (intentId: string): void => {
    if (!intentsProject.value) return
    send({ type: 'open_spec_session', workspaceId: intentsProject.value, intentId })
  }

  // Reset the intent's refine session: the server starts a fresh comm session
  // seeded with the new input + intent content, replacing intent_session_id.
  ctx.resetIntentSession = (intentId: string, userInput: string): void => {
    if (!intentsProject.value) return
    send({ type: 'reset_intent_session', workspaceId: intentsProject.value, intentId, userInput })
  }

  // Reset the intent's spec session: the server starts a fresh write-confined
  // spec session seeded with the new input + current spec content, replacing
  // spec_session_id.
  ctx.resetSpecSession = (intentId: string, userInput: string): void => {
    if (!intentsProject.value) return
    send({ type: 'reset_spec_session', workspaceId: intentsProject.value, intentId, userInput })
    ctx.clearSpecLaunchTimers()
    ctx.specLaunch.value = beginSpecLaunch(intentId, Date.now())
    ctx.specLaunchTimers.safety = setTimeout(
      () => ctx.dispatchSpecLaunch({ kind: 'timeout', now: Date.now() }),
      SPEC_LAUNCH_SAFETY_TIMEOUT_MS,
    )
  }

  // Fetch the selected intent's spec.md for the detail's `spec` tab. Specs live
  // OUTSIDE the workspace under the centralized root, so this uses `read_spec`
  // (keyed by intent id, server-resolved) rather than the workspace-confined
  // `read_file`. Tracks the awaited absolute spec path so the matching `file_read`
  // reply fills `intentSpecContent`.
  ctx.readIntentSpec = (intentId: string, specPath: string): void => {
    if (!intentsProject.value) return
    ctx.pendingSpecRel.value = specPath
    ctx.intentSpecLoading.value = true
    ctx.intentSpecContent.value = null
    send({ type: 'read_spec', workspaceId: intentsProject.value, intentId })
  }

  ctx.createPr = (intentId: string): void => {
    if (!intentsProject.value) return
    send({
      type: 'create_pr',
      workspaceId: intentsProject.value,
      intentId,
    })
  }

  ctx.startDevelopment = (intentId: string, hasUnfinishedDeps: boolean): void => {
    if (!intentsProject.value) return
    void hasUnfinishedDeps
    send({
      type: 'start_development',
      workspaceId: intentsProject.value,
      intentId,
    })
    // Arm the immediately-visible startup overlay. A terminal signal arriving
    // during its minimum dwell is closed by the dwell timer; the safety timeout
    // still guarantees closure if no terminal signal ever arrives.
    ctx.clearDevLaunchTimers()
    ctx.devLaunch.value = beginDevLaunch(intentId, Date.now())
    ctx.devLaunchTimers.safety = setTimeout(() => {
      ctx.dispatchDevLaunch({ kind: 'timeout', now: Date.now() })
    }, DEV_LAUNCH_SAFETY_TIMEOUT_MS)
  }

  ctx.setIntentStatus = (intentId: string, status: IntentStatus): void => {
    send({ type: 'update_intent_status', intentId, status })
  }

  ctx.setIntentAutomate = (intentId: string, automateOn: boolean): void => {
    // 仅 todo 意图可切换自动/手动模式;锁定态(in_progress/done/cancelled 等)点击给出
    // 不可修改提示,不下发协议消息。两个入口(列表行内 icon、IntentDetail)共用此门。
    const target = ctx.currentIntents.value.find((r) => r.id === intentId)
    if (target && target.status !== 'todo') {
      ctx.showToast(t('intent.automate.locked.toast'))
      return
    }
    send({ type: 'set_intent_automate', intentId, automate: automateOn })
  }

  ctx.updateIntentDeps = (
    intentId: string,
    deps: { dependsOnId: string; depType: DepType }[],
  ): void => {
    send({ type: 'update_intent_deps', intentId, deps })
  }

  ctx.startAutomation = (): void => {
    if (!intentsProject.value) return
    send({ type: 'start_automation', workspaceId: intentsProject.value })
  }

  ctx.stopAutomation = (): void => {
    if (!intentsProject.value) return
    send({ type: 'stop_automation', workspaceId: intentsProject.value })
  }
}
