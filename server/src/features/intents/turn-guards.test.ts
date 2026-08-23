/**
 * Work-turn guards — `hasPendingQuestion` recognises BOTH ask tools (Claude's
 * AskUserQuestion and Cursor's canonicalized AskQuestion) as a human decision
 * point that a continuation must never answer over.
 */
import { describe, expect, it } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'
import { hasPendingQuestion } from './turn-guards.js'

function askCall(id: string, toolName: string): ServerToClient {
  return { type: 'tool_use', toolUseId: id, toolName, input: {} }
}

function askResult(id: string): ServerToClient {
  return { type: 'tool_result', toolUseId: id, content: 'answered', isError: false }
}

describe('hasPendingQuestion', () => {
  it('recognizes an unanswered AskUserQuestion', () => {
    expect(hasPendingQuestion([askCall('a1', 'AskUserQuestion')])).toBe(true)
  })

  it('recognizes an unanswered Cursor AskQuestion', () => {
    expect(hasPendingQuestion([askCall('a2', 'AskQuestion')])).toBe(true)
  })

  it('treats an answered ask as no longer pending', () => {
    expect(hasPendingQuestion([askCall('a3', 'AskQuestion'), askResult('a3')])).toBe(false)
  })

  it('ignores ordinary tools and empty buffers', () => {
    expect(hasPendingQuestion([askCall('t1', 'Edit')])).toBe(false)
    expect(hasPendingQuestion([])).toBe(false)
  })
})
