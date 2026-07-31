/**
 * Prompts that RESET a session — the escape hatch when a conversation's context
 * has rotted and continuing it is worse than starting over.
 *
 * Kept in their own module so every surface that can reset a session (the human
 * WebSocket handler and the advisor MCP tool) builds the SAME first turn. Pure:
 * no I/O, no store.
 */
import type { Intent } from '@ccc/shared/protocol'

/**
 * Build the first prompt for a RESET intent (refine/comm) session — a fresh
 * session seeded with the user's new steering input concatenated with the
 * intent's current content. Pure (no I/O) so the concatenation is unit-testable.
 * Chinese skeleton, mirroring {@link refineIntent}'s seed.
 */
export function buildResetIntentPrompt(intent: Intent, userInput: string): string {
  const steer = userInput.trim()
  const steerBlock = steer ? `我的新输入:\n${steer}\n\n` : ''
  return `继续完善已存在意图 ${intent.id}(当前状态:${intent.status})。\n\n${steerBlock}意图标题:${intent.title}\n当前意图内容:\n${intent.content}\n\n请结合上面的新输入与意图内容,与我确认拆解/补充,定稿后调用 save_intents 并在该条目上回填 id="${intent.id}" 以原地更新原意图(切勿新建重复项)。若该意图已处于 in_progress 或 done 则无法修改,请告知我。`
}
