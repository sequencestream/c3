/**
 * Pure payload builders for the agent-degradation bus events (2026-06-08).
 *
 * The degradation chain (`launchRun` in `run-lifecycle.ts`) publishes three
 * **bypass** events on the kernel event bus (ADR-0018) at its key nodes —
 * `agent:error` (a single agent failed), `agent:fallback` (switched to the next
 * agent), `agent:all_failed` (the chain is exhausted). These are an event-化
 *旁路 over the *unchanged* synchronous control flow: they let actions beyond
 * "switch to the next agent" (trigger a schedule, notify the discussion engine,
 * audit) hang off agent failure via subscription, without touching the existing
 * degradation behavior or the wire `agent_failed` / `all_agents_failed` frames.
 *
 * The publish *call sites* in `launchRun` are thin one-liners over these pure
 * builders, so the payload shape is unit-tested here (`agent-events.test.ts`)
 * rather than inside the heavily-dependency-bound launcher — the same
 * testability split used by {@link buildAgentsToTry} and {@link decideResume}.
 */
import type { EventBusEvents } from '../events/event-bus.js'
import type { SkippedAgent } from './build-chain.js'

/** One agent's failure record, as collected into `launchRun`'s `failedAgents`. */
export interface FailedAgent {
  agentId: string
  agentName: string
  error: string
}

/** Build the `agent:error` payload for a single failed agent attempt. */
export function agentErrorEvent(input: {
  sessionId: string
  workspacePath: string
  agentId: string
  agentName: string
  error: string
  /** Always `true` today (only the degradable-error path is eventized). */
  degradable: boolean
}): EventBusEvents['agent:error'] {
  return {
    sessionId: input.sessionId,
    workspacePath: input.workspacePath,
    agentId: input.agentId,
    agentName: input.agentName,
    error: input.error,
    degradable: input.degradable,
  }
}

/** Build the `agent:fallback` payload for a switch from one agent to the next. */
export function agentFallbackEvent(input: {
  sessionId: string
  workspacePath: string
  from: { agentId: string; agentName: string }
  to: { agentId: string; agentName: string }
}): EventBusEvents['agent:fallback'] {
  return {
    sessionId: input.sessionId,
    workspacePath: input.workspacePath,
    fromAgentId: input.from.agentId,
    fromAgentName: input.from.agentName,
    toAgentId: input.to.agentId,
    toAgentName: input.to.agentName,
  }
}

/** Build the `agent:all_failed` payload for an exhausted degradation chain. */
export function agentAllFailedEvent(input: {
  sessionId: string
  workspacePath: string
  agents: ReadonlyArray<FailedAgent>
  crossVendorSkipped?: ReadonlyArray<SkippedAgent>
}): EventBusEvents['agent:all_failed'] {
  return {
    sessionId: input.sessionId,
    workspacePath: input.workspacePath,
    agents: input.agents.map((a) => ({
      agentId: a.agentId,
      agentName: a.agentName,
      error: a.error,
    })),
    ...(input.crossVendorSkipped && input.crossVendorSkipped.length > 0
      ? {
          crossVendorSkipped: input.crossVendorSkipped.map((a) => ({
            agentId: a.agentId,
            agentName: a.agentName,
            vendor: a.vendor,
          })),
        }
      : {}),
  }
}
