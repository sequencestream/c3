/*
 * agent-group-failover.ts — resume-time half of group failover (ADR-0029).
 *
 * A group binding re-expands on every run, but ONE run can only serve the group's
 * leading segment: whether the provider endpoint is c3's relay or the vendor CLI's
 * own login is baked into the subprocess env at spawn, so a `system` member and a
 * `custom` member can never be tried inside the same run. The relay covers failover
 * WITHIN a segment (before the first response byte); this covers the boundary —
 * when a run dies on a degradable error, the session's cursor moves past the
 * segment that just failed so the resume launches on the next candidate.
 *
 * Deliberately narrow: only a degradable failure advances (a rejected credential or
 * a bad request is not something a sibling can fix), and only a session actually
 * bound to a group is touched. It never disables anything — quota exhaustion is
 * handled by its own recovery path, which removes the member from the group until
 * the reset lands.
 */
import { advanceGroupCursor } from '../kernel/agent-config/index.js'
import type { EventBus, EventBusEvents } from '../kernel/events/event-bus.js'

export interface AgentGroupFailoverResult {
  /** Whether the session's cursor moved (false ⇒ not a group, or nothing to move to). */
  advanced: boolean
  /** The member the next launch will lead with, when it moved. */
  nextAgentId: string | null
}

export function handleAgentGroupFailure(input: {
  sessionId: string
  degradable: boolean
}): AgentGroupFailoverResult {
  if (!input.degradable) return { advanced: false, nextAgentId: null }
  const nextAgentId = advanceGroupCursor(input.sessionId)
  if (nextAgentId === null) return { advanced: false, nextAgentId: null }
  console.warn(
    '[agent-group-failover] session %s advanced to group member %s after a degradable failure',
    input.sessionId,
    nextAgentId,
  )
  return { advanced: true, nextAgentId }
}

export function registerAgentGroupFailover(deps: { eventBus: EventBus<EventBusEvents> }): void {
  deps.eventBus.subscribe('agent:error', (event) => {
    handleAgentGroupFailure({ sessionId: event.sessionId, degradable: event.degradable })
  })
}
