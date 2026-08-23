/**
 * Work-turn guards — the two pure facts every path that starts or continues a
 * work turn must read before it does so.
 *
 * They used to live inside the queue orchestrator, where only the queue could
 * see them. The session launcher now needs the SAME facts (a resume must not
 * answer over an open question, and must not outrun the continuation budget),
 * and so does the advisor proposal validator — so they moved here, into a
 * dependency-free module both can import without pulling in the orchestrator.
 */
import type { ServerToClient } from '@ccc/shared/protocol'
import { ASK_TOOL_NAME } from '../../kernel/agent/adapters/cursor/ask.js'

/**
 * Continuation budget per intent — a hard gate. A continuation is a turn the
 * system started on the agent's behalf; exceeding the budget is a failure of
 * that intent, never a reason to stop the queue.
 */
export const MAX_CONTINUATIONS = 10

/**
 * The ask tools whose unanswered call is a human decision point: Claude's
 * `AskUserQuestion` and Cursor's headless `AskQuestion` (both canonicalized to
 * the same answer channel). A pending question is never continued over and never
 * auto-answered.
 */
export function hasPendingQuestion(buffer: readonly ServerToClient[]): boolean {
  const answered = new Set<string>()
  for (const e of buffer) {
    if (e.type === 'tool_result') answered.add(e.toolUseId)
  }
  for (const e of buffer) {
    if (
      e.type === 'tool_use' &&
      (e.toolName === 'AskUserQuestion' || e.toolName === ASK_TOOL_NAME) &&
      !answered.has(e.toolUseId)
    ) {
      return true
    }
  }
  return false
}
