/**
 * Generic in-process event bus (ADR-0018).
 *
 * A typed publish/subscribe infrastructure for kernel-layer events. Producers
 * `publish(topic, payload)`, consumers `subscribe(topic, handler)`. The bus is
 * self-contained — it does NOT import from `features/` or `transport/`
 * (ADR-0009 R1) — and is the canonical kernel event backplane.
 *
 * ── Semantics ───────────────────────────────────────────────────────────────
 *  - **Dispatch:** synchronous, in subscriber-registration order. `publish()`
 *    returns `void` — it does NOT await async handlers.
 *  - **Error isolation:** every handler is wrapped in try/catch. A thrown
 *    handler is silently caught and logged; it does NOT cancel subsequent
 *    handlers or propagate to the publisher.
 *  - **Async handlers:** if a handler returns a Promise, the bus does NOT await
 *    it — the promise is discarded (unhandled rejections are caught and
 *    logged). Use async handlers only for fire-and-forget side effects.
 *  - **Cleanup:** `subscribe()` returns a dispose function. Call it to
 *    unsubscribe. A handler that is no longer needed MUST be disposed to
 *    prevent memory leaks (especially within per-launchRun subscriptions).
 *
 * ── Type safety ─────────────────────────────────────────────────────────────
 *  - The event map (`EventBusEvents`) defines all valid topics and their
 *    payload types at compile time.
 *  - `publish(topic, payload)` is statically checked: an unknown topic or a
 *    mismatched payload is a TYPE error.
 *  - `subscribe(topic, handler)` narrows the handler parameter type to the
 *    corresponding payload type.
 */

import type {
  IntentStatus,
  IntentLifecycleEvent,
  PrOperationEvent,
  RunEndReason,
  RunKind,
  SessionKind,
  VendorId,
} from '@ccc/shared/protocol'

/** Default event map for c3 kernel events. Extend this interface to add new topics. */
export interface EventBusEvents {
  /**
   * A pending session id bound to the real SDK session id (first bind only).
   * Carries `workspacePath` so domain listeners can match the bind to a workspace
   * without a separate lookup (2026-06-08).
   */
  'run:bound': { prevId: string; realId: string; workspacePath: string }
  /**
   * A run started — `launchRun` began a turn (published once per launchRun,
   * before the vendor fork, so it covers both the claude and driver paths).
   * `sessionKind` is the run's {@link SessionKind} business origin (listeners
   * route by source — event-triggered automations only fire on `'work'`); `runKind`
   * is its {@link RunKind} execution form (recorded for audit/extensibility).
   */
  'run:started': {
    sessionId: string
    workspacePath: string
    sessionKind: SessionKind
    runKind: RunKind
  }
  /**
   * The run is fully over (terminal state backstop reached). Carries the bound
   * session id, the terminal `reason`, the run's {@link SessionKind} business
   * origin (so event-triggered automations can filter by workspace + reason and skip
   * non-`work` runs) and its {@link RunKind} execution form (audit/extensibility).
   */
  'run:settled': {
    sessionId: string
    workspacePath: string
    reason: RunEndReason
    sessionKind: SessionKind
    runKind: RunKind
  }
  /**
   * A single agent attempt in the degradation chain failed (the bus twin of the
   * `onDegradableError` collection point, 2026-06-08). An **event-化 bypass** of
   * the existing degradation control flow: it does NOT replace the wire
   * `agent_failed` frame (which still fires only on a fresh fallback advance) —
   * it lets actions beyond "switch to the next agent" (trigger a automation, notify
   * the discussion engine, audit) hang off agent failure via subscription.
   * `degradable` is currently always `true` (only the degradable-error path is
   * eventized; a non-degradable infra throw keeps the existing catch path and is
   * not eventized — the field is reserved for that future extension).
   */
  'agent:error': {
    sessionId: string
    workspacePath: string
    agentId: string
    agentName: string
    error: string
    degradable: boolean
  }
  /**
   * The launcher advanced from one failed agent to the next in the degradation
   * chain (the bus twin of the FSM `fallback` step, 2026-06-08). Bypass-only: the
   * actual switch (and its wire `agent_failed` announcement) is unchanged.
   */
  'agent:fallback': {
    sessionId: string
    workspacePath: string
    fromAgentId: string
    fromAgentName: string
    toAgentId: string
    toAgentName: string
  }
  /**
   * The degradation chain is exhausted — every agent failed (the bus twin of the
   * wire `all_agents_failed` frame, 2026-06-08). Carries the full failure list
   * and any cross-vendor candidates that were skipped (AS-R22). Bypass-only: the
   * wire `all_agents_failed` + terminal `turn_end` are emitted exactly as before.
   */
  'agent:all_failed': {
    sessionId: string
    workspacePath: string
    agents: ReadonlyArray<{ agentId: string; agentName: string; error: string }>
    crossVendorSkipped?: ReadonlyArray<{ agentId: string; agentName: string; vendor: VendorId }>
  }
  /**
   * An intent's status changed. Published by the `update_intent_status` handler
   * when `canTransition` passes. Carries the old and new status plus the owning
   * project path so subscribers (e.g. automation orchestrator, audit logger) can
   * react without a separate lookup.
   */
  'intent:status_changed': {
    intentId: string
    workspacePath: string
    fromStatus: IntentStatus
    toStatus: IntentStatus
  }
  /**
   * A non-persistent intent lifecycle boundary. It is separate from generic
   * status changes: creation and abnormal automation termination are not a
   * one-to-one status transition.
   */
  'intent:lifecycle': { workspacePath: string } & IntentLifecycleEvent
  /**
   * A model-published, vendor-neutral PR operation event (2026-06-20). Published
   * by the `publish_pr_event` MCP tool's handler AFTER the model performed a PR
   * operation with its own tools — c3 never executes the operation itself. The
   * `workspacePath` + `sessionId` come from the per-run binding closure (the
   * model cannot forge another workspace), and the rest is the validated,
   * safely-normalized {@link PrOperationEvent}. Event-triggered automations
   * subscribed to `'pr:operation'` match it by operation + result.
   */
  'pr:operation': { workspacePath: string; sessionId: string } & PrOperationEvent
}

/** A handler function for a given event topic. May return a Promise (fire-and-forget). */
type Listener<T> = (payload: T) => void | Promise<void>

/**
 * Lightweight, type-safe, synchronous in-process event bus.
 *
 * @typeParam T - Event map type, mapping topic string to payload type.
 *   Defaults to {@link EventBusEvents}.
 */
export class EventBus<T = EventBusEvents> {
  /** Internal listener storage: topic → set of handlers. */
  private readonly _listeners = new Map<keyof T, Set<Listener<unknown>>>()

  /**
   * Publish an event. All registered handlers are called synchronously in
   * subscription order. Error isolation applies: one handler's throw never
   * stops subsequent handlers or propagates to the caller.
   */
  publish<K extends keyof T>(topic: K, payload: T[K]): void {
    const handlers = this._listeners.get(topic)
    if (!handlers) return

    for (const handler of handlers) {
      try {
        const result = handler(payload as unknown) as unknown
        // Duck-type check for thenable (avoids TS2358 on void | Promise<void>).
        if (result != null && typeof (result as { then?: unknown }).then === 'function') {
          ;(result as Promise<void>).catch((err: unknown) => {
            console.error(`[EventBus] async handler rejection for "${String(topic)}":`, err)
          })
        }
      } catch (err) {
        console.error(`[EventBus] handler error for "${String(topic)}":`, err)
      }
    }
  }

  /**
   * Subscribe to a topic. Returns a dispose function; call it to unsubscribe.
   * The handler receives the topic's typed payload.
   *
   * **IMPORTANT:** call the dispose function when the subscription is no longer
   * needed. Per-launchRun subscriptions should be disposed after `settled`
   * fires, or on cleanup, to prevent memory leaks.
   */
  subscribe<K extends keyof T>(topic: K, handler: Listener<T[K]>): () => void {
    if (!this._listeners.has(topic)) {
      this._listeners.set(topic, new Set())
    }
    const handlers = this._listeners.get(topic)!
    const wrapped = handler as Listener<unknown>
    handlers.add(wrapped)

    return (): void => {
      handlers.delete(wrapped)
      if (handlers.size === 0) {
        this._listeners.delete(topic)
      }
    }
  }

  /**
   * Remove all listeners. Useful for cleanup in tests or between sessions.
   */
  clear(): void {
    this._listeners.clear()
  }
}
