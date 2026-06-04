/**
 * Kernel boundary types — slice 1/3 of the server refactor (ADR-0009).
 *
 * `AppContext` is the explicit composition-root injection: it is constructed
 * ONCE at startup (inside `startServer`) and threaded to every handler as its
 * first argument. It carries references to the shared domain services and live
 * runtime state.
 *
 * IMPORTANT (ADR-0009 R1/R2/R6, slice-1 reality):
 * - This file is `kernel/` and MUST NOT import from `transport/` or `features/`,
 *   and MUST NOT touch ws/HTTP semantics. It only DECLARES types — the function
 *   *implementations* (broadcasts, launchers) still live in the `server.ts`
 *   entry closure for this slice; `AppContext` merely holds references to them.
 * - "共享状态暂留闭包": the `Map`s below are the SAME objects the `server.ts`
 *   closure owns; `AppContext` borrows references, it does not (yet) own them.
 *   Slice 2/3 moves true ownership here and routes broadcasts through a kernel
 *   event bus consumed by `transport/`.
 */
import type {
  AutomationStatus,
  Discussion,
  DiscussionMessage,
  Requirement,
  RequirementRunStatus,
} from '@ccc/shared/protocol'
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
 * Per-run control for a live discussion orchestration. `abort` tears it down;
 * `paused` + `resumeWaiters` implement a pause gate the loop awaits at each
 * round boundary. (Moved here from the `server.ts` closure so `AppContext` can
 * type `discussionRuns` without a cycle — behavior unchanged.)
 */
export interface DiscussionRunControl {
  abort: AbortController
  paused: boolean
  resumeWaiters: Array<() => void>
}

/**
 * The application context injected into every handler. Slice 1/3: a reference
 * bag over the `server.ts` closure (state still owned there). Slice 2/3: the
 * real owner of this state, with broadcasts moved behind a kernel event bus.
 */
export interface AppContext {
  // ── run launcher dependencies (the launcher itself is the top-level `launchRun`) ──
  readonly launchDeps: LaunchRunDeps
  /**
   * The shared run launcher with `launchDeps` baked in (so handlers call
   * `ctx.launchRun(rt, prompt, cbs)` without re-passing deps, and without
   * importing the `server.ts` entry — avoiding a transport↔entry cycle). Wraps
   * the top-level `launchRun` in `server.ts`.
   */
  readonly launchRun: (rt: SessionRuntime, prompt: string, cbs?: LaunchCbs) => Promise<void>

  // ── broadcasts (transport-owned in spirit; slice 2/3 moves them behind the
  //    kernel event bus — for slice 1 they are closure refs reached via ctx) ──
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

  // ── derived-field enrichment (R4: pure, read-only over its input) ──
  readonly enrichRunStatus: (items: Requirement[]) => Requirement[]

  // ── shared runtime state (same Map objects as the closure owns) ──
  readonly runStatusCache: Map<string, RequirementRunStatus>
  readonly judgedSessions: Map<string, string>
  readonly discussionRuns: Map<string, DiscussionRunControl>
  readonly researchRuns: Map<string, AbortController>
  readonly discussionRunSnapshot: (items: Discussion[]) => Record<string, 'running' | 'paused'>
  readonly researchRunSnapshot: (items: Discussion[]) => Record<string, 'running'>

  // ── background run starters (still live in the server.ts closure) ──
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
