/**
 * The automation-side entry the queue's PR review / fix relay launches through.
 *
 * A relay phase is an unattended agent turn, so it reuses the automation
 * dispatcher wholesale — the vendor launch path, the wall-clock guard, the
 * three-tier MCP security model, the tool freeze, the viewer stream and the
 * session projection. What it does NOT reuse is the automation RECORD: there is
 * no saved template behind a relay phase, nothing to re-arm on a cron, and its
 * serialization is the queue's own per-intent occupancy. So the spec here is
 * assembled in memory, per phase, from facts the server owns.
 *
 * Two deliberate differences from a saved automation:
 *
 *  - the working directory is the intent's own worktree, not the workspace root.
 *    That is where the PR's head branch is checked out, and a fix session that
 *    ran at the root would edit the wrong tree. Workspace ownership and the MCP
 *    closure still point at the original project.
 *  - no `automation_execution_logs` row is created. The execution id is a
 *    transient handle for the dispatcher's own bookkeeping; the durable record of
 *    a relay phase is the intent's session field plus its WorkNote history, and
 *    inventing rows under an automation that does not exist would leave orphans
 *    the automation page could never show or clean up.
 */
import { randomUUID } from 'node:crypto'
import type { Automation, ModeToken, VendorId } from '@ccc/shared/protocol'
import { execute } from './dispatcher.js'

/** Everything one relay phase needs to execute. */
export interface RelaySessionSpec {
  /** Workspace name / path the execution belongs to (never overridden by `cwd`). */
  workspaceName: string
  /** The vendor + agent chosen ONCE when the phase was claimed. */
  vendor: VendorId
  agentId: string
  /** The server-built turn. Never model-authored, never event-carried. */
  prompt: string
  /** The tools this phase may use — the phase's whole authority surface. */
  toolAllowlist: readonly string[]
  /** The intent's worktree; the vendor's working directory for this execution. */
  cwd: string
  /** Wall-clock ceiling for this phase. */
  maxWallClockMs: number
  /** Shown on the session projection row. */
  title: string
  /** Called once, with the real session id the vendor bound. */
  onSessionBound?: (sessionId: string) => void
}

/** How a relay phase's execution ended, as the queue's executor reads it. */
export interface RelaySessionOutcome {
  /** `false` when the dispatcher reported a failure or the turn threw. */
  ok: boolean
  /** The dispatcher's structured failure code, or the thrown message. */
  error: string | null
  /** The real session id the vendor bound; `null` when it never bound one. */
  sessionId: string | null
}

/** The execution mode a relay phase runs under, per vendor shape. */
function relayMode(): ModeToken {
  return 'bypassPermissions'
}

/**
 * Run ONE relay phase to completion and report how it ended.
 *
 * The outcome says only whether the TURN succeeded. It never says the PR was
 * approved or fixed: a clean exit with no `sync_intent_*` call is a phase with no
 * conclusion, and the queue treats it as a failed attempt, never as a pass.
 */
export async function runRelaySession(spec: RelaySessionSpec): Promise<RelaySessionOutcome> {
  const executionId = randomUUID()
  // The in-memory record the dispatcher executes. `id` is a transient handle: it
  // is never persisted, never listed, and never re-armed — the queue owns this
  // phase's identity through the intent's session field.
  const automation: Automation = {
    id: `relay:${executionId}`,
    type: 'llm',
    config: { prompt: spec.prompt },
    maxWallClockMs: spec.maxWallClockMs,
    workspaceName: spec.workspaceName,
    triggerType: 'event',
    cronExpression: '',
    nextRunAt: null,
    eventFilters: null,
    eventSessionKindFilter: null,
    metadata: {},
    runningSessionId: null,
    status: 'active',
    mode: relayMode(),
    toolAllowlist: [...spec.toolAllowlist],
    toolDenylist: [],
    vendor: spec.vendor,
    agentId: spec.agentId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  let ok = true
  let error: string | null = null
  let sessionId: string | null = null

  try {
    await execute(
      automation,
      executionId,
      (_id, patch) => {
        if (typeof patch.sessionId === 'string' && patch.sessionId && !sessionId) {
          sessionId = patch.sessionId
          spec.onSessionBound?.(patch.sessionId)
        }
        if (patch.status === 'failed' || patch.status === 'cancelled') {
          ok = false
          if (typeof patch.error === 'string' && patch.error) error = patch.error
        }
      },
      undefined,
      { cwd: spec.cwd },
    )
  } catch (err) {
    ok = false
    error = err instanceof Error ? err.message : String(err)
  }

  return { ok, error, sessionId }
}
