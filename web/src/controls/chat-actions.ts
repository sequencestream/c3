import { watch } from 'vue'
import type { CodexPolicy, ModeToken, PromptImage } from '@ccc/shared/protocol'
import type { PermissionMsg } from '@/lib/chat-types'
import {
  appendItem,
  mergeImages,
  mergeQueue,
  removeItem,
  shouldFlush,
  type PendingItem,
} from '@/lib/pending-queue'
import type { AppCtx } from './types'

// Install chat/composer actions plus the client-side pending-send queue onto the ctx.
export function installChatActions(ctx: AppCtx): void {
  const send = ctx.send
  const {
    activeSession,
    hasActiveSession,
    sessionStatus,
    activity,
    mode,
    codexPolicy,
    running,
    activeIsTeam,
    currentQueue,
    pendingQueues,
    composer,
    setQueue,
    counters,
    clearSideEffectPending,
  } = ctx

  // A follow-up that the server rejected because the previous turn had not let
  // go yet. Held so it can be put back instead of disappearing.
  let heldFlush: { sessionId: string; items: PendingItem[] } | null = null
  let retryNotBefore = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const REJECTED_PROMPT_RETRY_MS = 1000

  function clearRetry(): void {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    retryNotBefore = 0
  }

  // ---- Pending send queue ----
  ctx.onEnqueue = (text: string, images?: PromptImage[]): void => {
    const sid = activeSession.value
    if (!sid) return
    setQueue(sid, appendItem(currentQueue.value, text, counters.nextQueueId++, images))
  }

  ctx.onDeleteQueued = (id: number): void => {
    const sid = activeSession.value
    if (!sid) return
    setQueue(sid, removeItem(currentQueue.value, id))
  }

  // Edit: pull the item out of the queue and fold its text + images back into the composer.
  ctx.onEditQueued = (item: PendingItem): void => {
    const sid = activeSession.value
    if (!sid) return
    setQueue(sid, removeItem(currentQueue.value, item.id))
    composer.value?.prefill(item.text, item.images)
  }

  ctx.onSendQueued = (id: number): void => {
    const sid = activeSession.value
    if (!ctx.client || !sid || !hasActiveSession.value) return
    if (!currentQueue.value.some((item) => item.id === id)) return
    if (currentQueue.value.some((item) => item.immediate)) return
    setQueue(
      sid,
      currentQueue.value.map((item) => (item.id === id ? { ...item, immediate: true } : item)),
    )
    if (running.value || activeIsTeam.value) ctx.stopRun()
    else ctx.flushIfReady()
  }

  // Wait for confirmed idle before submitting a new turn to the same session.
  ctx.flushIfReady = (): void => {
    const sid = activeSession.value
    if (!ctx.client || !sid || !hasActiveSession.value) return
    if (!shouldFlush(running.value, activeIsTeam.value, currentQueue.value.length)) return
    if (Date.now() < retryNotBefore) return
    const immediate = currentQueue.value.find((item) => item.immediate)
    const items = immediate ? [immediate] : [...currentQueue.value]
    const merged = mergeQueue(items)
    const mergedImages = mergeImages(items)
    heldFlush = { sessionId: sid, items }
    setQueue(sid, immediate ? removeItem(currentQueue.value, immediate.id) : [])
    ctx.onSubmit(merged, mergedImages)
  }

  // The server echoed the prompt, so the held copy must not be sent again.
  ctx.notePromptDelivered = (): void => {
    heldFlush = null
    clearRetry()
  }

  // `session.turnRunning` means the stop had not finished letting go. Put the
  // prompt back and try once more after a short gap, once the session is idle.
  ctx.restoreRejectedPrompt = (code: string): boolean => {
    if (code !== 'session.turnRunning' || !heldFlush) return false
    const { sessionId, items } = heldFlush
    heldFlush = null
    const ids = new Set(items.map((item) => item.id))
    const existing = pendingQueues.value[sessionId] ?? []
    setQueue(sessionId, [...items, ...existing.filter((item) => !ids.has(item.id))])
    retryNotBefore = Date.now() + REJECTED_PROMPT_RETRY_MS
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      retryNotBefore = 0
      ctx.flushIfReady()
    }, REJECTED_PROMPT_RETRY_MS)
    return true
  }

  // Trigger on a running→idle transition or when switching to an already-idle
  // session that still holds a queue.
  watch([running, activeSession, activeIsTeam], () => ctx.flushIfReady())

  // ---- Chat actions ----
  ctx.onSubmit = (text: string, images?: PromptImage[]): void => {
    if (!ctx.client || !hasActiveSession.value) return
    send({ type: 'user_prompt', text, ...(images && images.length > 0 ? { images } : {}) })
    // Optimistic lock; the server confirms via `session_status`.
    sessionStatus.value = { ...sessionStatus.value, [activeSession.value as string]: 'running' }
    // Clear any held error and show progress immediately.
    activity.value = { phase: 'thinking' }
    // A new turn is starting — the danger state (if any) is being resolved.
    clearSideEffectPending(activeSession.value as string)
  }

  // Manual continue from the side-effect danger state (AS-R19).
  ctx.onContinue = (): void => {
    ctx.onSubmit('continue')
  }

  ctx.stopRun = (): void => {
    send({ type: 'stop_run' })
  }

  // Re-sync the viewed session's status/history (re-select it).
  ctx.refreshStatus = (): void => {
    if (!ctx.activeWorkspace.value || !activeSession.value) return
    send({
      type: 'select_session',
      workspaceName: ctx.activeWorkspace.value,
      sessionId: activeSession.value,
    })
  }

  ctx.setMode = (next: ModeToken): void => {
    if (!ctx.client || next === mode.value || !hasActiveSession.value) return
    // Optimistic; server echoes a `mode_changed` that confirms it.
    mode.value = next
    send({ type: 'set_mode', mode: next })
  }

  ctx.setCodexPolicy = (policy: CodexPolicy): void => {
    if (!ctx.client || !hasActiveSession.value) return
    // Optimistic; server echoes a `mode_changed` with codexPolicy that confirms it.
    codexPolicy.value = policy
    send({ type: 'set_mode', mode: policy })
  }

  // Re-target the viewed session's agent to another same-vendor one (ADR-0015).
  ctx.onSetSessionAgent = (agentId: string): void => {
    if (!ctx.client || !activeSession.value) return
    send({ type: 'set_session_agent', sessionId: activeSession.value, agentId })
  }

  ctx.respond = (m: PermissionMsg, decision: 'allow' | 'deny'): void => {
    if (!ctx.client || m.decision) return
    send({ type: 'permission_response', requestId: m.requestId, decision })
    m.decision = decision
  }

  ctx.submitAsk = (m: PermissionMsg, answers: Record<string, string>): void => {
    if (!ctx.client || m.decision) return
    send({ type: 'permission_response', requestId: m.requestId, decision: 'allow', answers })
    m.decision = 'allow'
  }

  ctx.listCommands = (): void => {
    send({ type: 'list_commands' })
  }
}
