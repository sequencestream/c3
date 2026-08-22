/**
 * Format database-recovered IM-visible turns into a prompt seed for a new
 * native vendor session. Pairs are never split. Used only when the optional
 * native session cache is absent or unverified.
 */
import type { CommittedContextTurn } from './robot-store.js'

export function formatContextSeed(turns: CommittedContextTurn[], currentQuestion: string): string {
  if (turns.length === 0) return currentQuestion
  const lines: string[] = [
    '以下是此前已在本对话中成功投递的往来(由 c3 从数据库恢复)。请在此基础上继续回答当前问题。',
    '',
  ]
  for (const t of turns) {
    lines.push(`用户: ${t.userText}`)
    lines.push(`助手: ${t.assistantText}`)
    lines.push('')
  }
  lines.push(`当前问题: ${currentQuestion}`)
  return lines.join('\n')
}
