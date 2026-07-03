/**
 * Kernel boundary types — server refactor (ADR-0009).
 *
 * `KernelContext` is the explicit composition-root injection: it is constructed
 * ONCE at startup (inside `startServer`) and threaded to every handler as its
 * first argument. It is the long-lived, cross-feature service bag — shared
 * domain services and the broadcast/launch hooks that more than one feature uses.
 *
 * IMPORTANT (ADR-0009 R1/R2/R6):
 * - This file is `kernel/` and MUST NOT import from `transport/` or `features/`,
 *   and MUST NOT touch ws/HTTP semantics. It only DECLARES types — the function
 *   *implementations* (broadcasts, launchers) still live in the `server.ts`
 *   entry closure; `KernelContext` holds references to them (slice 2/3b folds the
 *   broadcasts into a single `transport/Broadcaster`).
 * - Slice 2/3a moved the feature-PRIVATE state out of here: the intent
 *   runStatus cache + judged-session de-dup now live in `intents/run-status`,
 *   the live discussion/research run maps in `discussions/run-controls`. Only
 *   genuinely cross-feature services remain on the context (the hard rule:
 *   transport-shared / cross-feature → context; feature-private → feature store).
 */
import type { WorkflowStatus, Discussion, DiscussionMessage } from '@ccc/shared/protocol'
import type { SessionRuntime } from '../runs.js'
import { EventBus, type EventBusEvents } from './events/event-bus.js'

/**
 * The sealed-union typed DOMAIN events the run launcher fires (legacy type,
 * kept for the type-contract test in `run-domain-event.test.ts`). New code
 * should use the {@link EventBus} typed-event-map topics instead.
 *
 * Why a sealed union (server refactor 3/3e-4):
 *  - Each event is discriminated by `kind` — a `switch (event.kind)` over the
 *    union is exhaustive by construction; a future event added without
 *    handling every existing case is a TYPE error.
 *  - The shape carries everything a handler needs in one place; the
 *    `prevId`/`realId` of a bind lives on the event, not in an out-of-band
 *    closure variable.
 *
 * NOTE: As of ADR-0018, `launchRun` no longer accepts an `onEvent` callback.
 * Subscribe to the kernel {@link EventBus} topics `'run:bound'` / `'run:settled'`
 * on `KernelContext.eventBus` instead.
 */
export type RunDomainEvent =
  /** A pending session id bound to the real SDK session id (first bind only). */
  | { readonly kind: 'bound'; readonly prevId: string; readonly realId: string }
  /** The run is fully over (terminal state backstop reached). */
  | { readonly kind: 'settled'; readonly workspacePath: string }

/**
 * Closure-captured dependencies the top-level `launchRun` reads. Declared here
 * (not in `server.ts`) so `AppContext` can reference the type without a cycle.
 * Slice 2/3 folds these into `AppContext` directly.
 */
export interface LaunchRunDeps {
  broadcastStatuses: () => void
  broadcastIntents: (workspacePath: string) => void
  readonly eventBus: EventBus<EventBusEvents>
}

/**
 * The long-lived kernel context injected into every handler as its first
 * argument. It carries the cross-feature shared services — the run launcher, the
 * event bus, the broadcast hooks, the discussion run starters, the automation
 * hooks. Per-request state (which session a connection watches, how to deliver)
 * lives on `Conn` / `RequestContext` in `transport/`, NOT here. Feature-private
 * state lives in the owning feature's store, NOT here.
 */
export interface KernelContext {
  /** Shared kernel event bus (ADR-0018). Publish domain events; subscribe to consume them. */
  readonly eventBus: EventBus<EventBusEvents>

  // ── run launcher dependencies (the launcher itself is the top-level `launchRun`) ──
  readonly launchDeps: LaunchRunDeps
  /**
   * The shared run launcher with `launchDeps` baked in (so handlers call
   * `ctx.launchRun(rt, prompt)` without re-passing deps, and without
   * importing the `server.ts` entry — avoiding a transport↔entry cycle). Wraps
   * the top-level `launchRun` in `server.ts`.
   *
   * As of ADR-0018 the launcher no longer accepts an `onEvent` callback —
   * subscribe to `eventBus` topics `'run:bound'` / `'run:settled` instead.
   */
  readonly launchRun: (
    rt: SessionRuntime,
    prompt: string,
    images?: import('@ccc/shared/protocol').PromptImage[],
    inject?: import('./run/prompt-delivery.js').RunInject,
  ) => Promise<void>

  // ── broadcasts (transport-owned in spirit; slice 2/3b folds them into a single
  //    transport/Broadcaster — for now they are closure refs reached via ctx) ──
  readonly broadcastStatuses: () => void
  readonly broadcastIntents: (workspacePath: string) => void
  readonly broadcastIntentSessions: (workspacePath: string) => void
  readonly broadcastDiscussions: (workspacePath: string) => void
  readonly broadcastAutomations: (workspacePath: string) => void
  readonly broadcastWorkflow: (status: WorkflowStatus) => void
  readonly broadcastDiscussionMessage: (discussionId: string, message: DiscussionMessage) => void
  readonly broadcastDiscussionRunStatus: (
    discussionId: string,
    state: 'running' | 'paused' | 'ended',
  ) => void
  /** Push a project's refreshed wait-user-involve event list (todo status). */
  readonly broadcastWaitUserEvents: (workspacePath: string) => void

  // ── background run starters (still live in the server.ts closure) ──
  readonly startDiscussionRun: (discussion: Discussion) => void
  readonly startResearchRun: (discussion: Discussion) => void

  // The automation hooks bag is feature-private to `intents` (wired via
  // `setWorkflowHooks`, read via `getWorkflowHooks`), NOT on the kernel
  // context — keeping the kernel free of any `features/` import (ADR-0009 R1).
}

/**
 * Boot-time guard for ADR-0009 R6: a kernel event/context MUST NOT smuggle
 * transport concepts (a `sock`, a `Viewer`, a raw `connections` set). Called by
 * the `AppContext` factory at startup. Slice 1 keeps it lightweight — it scans
 * the top-level keys for forbidden transport field names.
 */
const FORBIDDEN_TRANSPORT_KEYS = ['sock', 'socket', 'ws', 'viewer', 'viewers', 'connections']
export function assertNoTransportFields(ctx: object): void {
  for (const key of Object.keys(ctx)) {
    if (FORBIDDEN_TRANSPORT_KEYS.includes(key.toLowerCase())) {
      throw new Error(
        `[c3] AppContext violates ADR-0009 R6: transport field '${key}' must not cross the kernel boundary`,
      )
    }
  }
}
