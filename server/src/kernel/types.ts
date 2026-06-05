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
 * - Slice 2/3a moved the feature-PRIVATE state out of here: the requirement
 *   runStatus cache + judged-session de-dup now live in `requirements/run-status`,
 *   the live discussion/research run maps in `discussions/run-controls`. Only
 *   genuinely cross-feature services remain on the context (the hard rule:
 *   transport-shared / cross-feature → context; feature-private → feature store).
 */
import type { AutomationStatus, Discussion, DiscussionMessage } from '@ccc/shared/protocol'
import type { AutomationHooks } from '../requirements/automation.js'
import type { SessionRuntime } from '../runs.js'

/** Connection-injected callbacks the run launcher fires (see `launchRun`). */
export interface LaunchCbs {
  onSessionId?: (prevId: string, realId: string) => void
  onSettled?: (workspacePath: string) => void | Promise<void>
}

/**
 * Closure-captured dependencies the top-level `launchRun` reads. Declared here
 * (not in `server.ts`) so `AppContext` can reference the type without a cycle.
 * Slice 2/3 folds these into `AppContext` directly.
 */
export interface LaunchRunDeps {
  broadcastStatuses: () => void
  broadcastRequirements: (projectPath: string) => void
}

/**
 * The long-lived kernel context injected into every handler as its first
 * argument. It carries the cross-feature shared services — the run launcher, the
 * broadcast hooks, the discussion run starters, the automation hooks. Per-request
 * state (which session a connection watches, how to deliver) lives on `Conn` /
 * `RequestContext` in `transport/`, NOT here. Feature-private state lives in the
 * owning feature's store, NOT here.
 */
export interface KernelContext {
  // ── run launcher dependencies (the launcher itself is the top-level `launchRun`) ──
  readonly launchDeps: LaunchRunDeps
  /**
   * The shared run launcher with `launchDeps` baked in (so handlers call
   * `ctx.launchRun(rt, prompt, cbs)` without re-passing deps, and without
   * importing the `server.ts` entry — avoiding a transport↔entry cycle). Wraps
   * the top-level `launchRun` in `server.ts`.
   */
  readonly launchRun: (rt: SessionRuntime, prompt: string, cbs?: LaunchCbs) => Promise<void>

  // ── broadcasts (transport-owned in spirit; slice 2/3b folds them into a single
  //    transport/Broadcaster — for now they are closure refs reached via ctx) ──
  readonly broadcastStatuses: () => void
  readonly broadcastRequirements: (projectPath: string) => void
  readonly broadcastDiscussions: (projectPath: string) => void
  readonly broadcastSchedules: (workspacePath: string) => void
  readonly broadcastAutomation: (status: AutomationStatus) => void
  readonly broadcastDiscussionMessage: (discussionId: string, message: DiscussionMessage) => void
  readonly broadcastDiscussionRunStatus: (
    discussionId: string,
    state: 'running' | 'paused' | 'ended',
  ) => void

  // ── background run starters (still live in the server.ts closure; move to the
  //    discussions feature in slice 2/3c) ──
  readonly startDiscussionRun: (discussion: Discussion) => void
  readonly startResearchRun: (discussion: Discussion) => void

  // ── automation orchestrator hooks ──
  readonly automationHooks: AutomationHooks
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
