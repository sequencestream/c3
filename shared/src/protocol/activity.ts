/**
 * Workspace activity summaries used by the badge snapshot / delta protocol.
 *
 * These numbers are derived from the server activity projection. Clients render
 * them; they do not recompute badges from paginated lists.
 */

import type { SessionKind, SessionOwnerKind } from './session.js'

export interface WorkspaceActivitySummary {
  runningSessions: number
  runningSessionsByKind: Partial<Record<SessionKind, number>>
  activeOwners: {
    intents: number
    discussions: number
    automations: number
  }
  attention: {
    awaitingPermission: number
    pendingUserTasks: number
    actionableDeliveries: number
  }
}

/** Session-page count buckets. consensus / robot stay out of the page tabs. */
export type SessionPageCountKind = Exclude<SessionKind, 'consensus' | 'robot'>

export function emptyWorkspaceActivitySummary(): WorkspaceActivitySummary {
  return {
    runningSessions: 0,
    runningSessionsByKind: {},
    activeOwners: { intents: 0, discussions: 0, automations: 0 },
    attention: { awaitingPermission: 0, pendingUserTasks: 0, actionableDeliveries: 0 },
  }
}

/**
 * Map a workspace activity summary onto the session-page wire counts.
 * `spec` aggregates authoring + review; `spec_review` stays 0 so it cannot
 * become a second visible badge. `tool` follows the display switch. consensus
 * and robot are omitted from page categories but remain in runningSessions.
 */
export function sessionPageCountsFromSummary(
  summary: WorkspaceActivitySummary,
  showToolSessions: boolean,
): {
  counts: Record<SessionPageCountKind, number>
  ownerCounts: Record<SessionOwnerKind, number>
  runningSessionCount: number
} {
  const byKind = summary.runningSessionsByKind
  return {
    counts: {
      work: byKind.work ?? 0,
      intent: byKind.intent ?? 0,
      spec: (byKind.spec ?? 0) + (byKind.spec_review ?? 0),
      spec_review: 0,
      discussion: byKind.discussion ?? 0,
      automation: byKind.automation ?? 0,
      tool: showToolSessions ? (byKind.tool ?? 0) : 0,
    },
    ownerCounts: {
      intent: summary.activeOwners.intents,
      discussion: summary.activeOwners.discussions,
      automation: summary.activeOwners.automations,
    },
    runningSessionCount: summary.runningSessions,
  }
}
