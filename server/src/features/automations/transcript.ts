/**
 * Read path for a single automation execution's agent session transcript.
 *
 * Only `llm`-type executions record a `sessionId` (set by the dispatcher from the
 * first SDK event). Given an execution log id, this resolves the owning automation's
 * workspace and vendor, then replays the transcript via the shared
 * {@link loadHistoryForVendor} — the same vendor-aware reader the interactive
 * session view uses — yielding the `TranscriptItem[]` the live chat view renders.
 *
 * Read-only: it loads what is already persisted on disk; it does not stream.
 */
import type { TranscriptItem } from '@ccc/shared/protocol'
import { resolveWorkspaceRoot } from '../../state.js'
import { getExecutionLog, getAutomation } from './store.js'
import { loadHistoryForVendor } from '../sessions/history.js'

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
 *   automation was deleted (no workspace to resolve) or the transcript is gone.
 *
 * The transcript is read from the automation's own vendor store: a codex
 * automation is read back from the codex session store (frozen store scope root
 * first, the other as fallback), never through the claude-only reader.
 */
export async function readExecutionTranscript(
  executionId: string,
): Promise<ExecutionTranscript | null> {
  const log = getExecutionLog(executionId)
  if (!log) return null

  const sessionId = log.sessionId
  if (!sessionId) return { sessionId: null, items: [] }

  const automation = getAutomation(log.automationId)
  if (!automation) return { sessionId, items: [] }

  const workspacePath = resolveWorkspaceRoot(automation.workspaceId)
  if (!workspacePath) return { sessionId, items: [] }

  try {
    const items = await loadHistoryForVendor(automation.vendor, workspacePath, sessionId)
    return { sessionId, items }
  } catch {
    // Transcript missing / unreadable on disk — degrade to an empty replay
    // rather than surfacing an error for a since-deleted session.
    return { sessionId, items: [] }
  }
}
