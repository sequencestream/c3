/**
 * The ONE resolution criterion for "who organizes this discussion" — shared by
 * the orchestration loop (`orchestrator.ts`) and the research pass
 * (`research.ts`), so the two stages of the same discussion flow can never
 * maintain divergent default behaviour. Pure (no I/O): each call site feeds its
 * own enabled pool + fallback (the global default agent in production, the
 * injected test deps in the orchestration loop).
 */
import type { AgentConfig } from '@ccc/shared/protocol'

/**
 * Resolve a discussion's organizer: its `organizerAgentId` when that points into
 * the enabled `pool`; otherwise (unset, unknown, or currently disabled) the
 * `fallback` — the global default agent at both production call sites.
 */
export function resolveDiscussionOrganizer(
  organizerAgentId: string | null,
  pool: AgentConfig[],
  fallback: AgentConfig,
): AgentConfig {
  if (!organizerAgentId) return fallback
  return pool.find((a) => a.id === organizerAgentId) ?? fallback
}
