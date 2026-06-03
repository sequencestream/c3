/**
 * Read path for a single schedule execution's agent session transcript.
 *
 * Only `llm`-type executions record a `sessionId` (set by the dispatcher from the
 * first SDK event). Given an execution log id, this resolves the owning schedule's
 * workspace and replays the SDK transcript via the shared {@link loadHistory},
 * yielding the same `TranscriptItem[]` the live chat view renders.
 *
 * Read-only: it loads what is already persisted on disk; it does not stream.
 */
import type { TranscriptItem } from '@ccc/shared/protocol'
import { getExecutionLog, getSchedule } from './store.js'
import { loadHistory } from '../sessions.js'

export interface ExecutionTranscript {
  sessionId: string | null
  items: TranscriptItem[]
}

/**
 * Load one execution's transcript by execution log id.
 *
 * - Returns `null` when the execution log does not exist.
 * - Returns `{ sessionId: null, items: [] }` for `command`-type or sessionless
 *   executions (nothing to replay).
 * - Returns `{ sessionId, items }` otherwise; `items` is empty if the owning
 *   schedule was deleted (no workspace to resolve) or the transcript is gone.
 */
export async function readExecutionTranscript(
  executionId: string,
): Promise<ExecutionTranscript | null> {
  const log = getExecutionLog(executionId)
  if (!log) return null

  const sessionId = log.sessionId
  if (!sessionId) return { sessionId: null, items: [] }

  const schedule = getSchedule(log.scheduleId)
  if (!schedule) return { sessionId, items: [] }

  try {
    const items = await loadHistory(schedule.workspacePath, sessionId)
    return { sessionId, items }
  } catch {
    // Transcript missing / unreadable on disk — degrade to an empty replay
    // rather than surfacing an error for a since-deleted session.
    return { sessionId, items: [] }
  }
}
