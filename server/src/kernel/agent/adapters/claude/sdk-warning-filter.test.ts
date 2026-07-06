import { describe, it, expect } from 'vitest'
import { isSuppressedClaudeWarning, SHADOWED_WARNING_CODE } from './sdk-warning-filter.js'

/** A Node process warning as `process.emitWarning(msg, { code })` produces it. */
function warningWithCode(code: string): Error & { code: string } {
  const w = new Error('canUseTool will not be invoked: …') as Error & { code: string }
  w.name = 'Warning'
  w.code = code
  return w
}

describe('isSuppressedClaudeWarning', () => {
  it('drops exactly the CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning', () => {
    expect(isSuppressedClaudeWarning('warning', warningWithCode(SHADOWED_WARNING_CODE))).toBe(true)
  })

  it('passes through any OTHER warning code (e.g. a real misconfig warning)', () => {
    expect(isSuppressedClaudeWarning('warning', warningWithCode('SOME_OTHER_WARNING'))).toBe(false)
    expect(isSuppressedClaudeWarning('warning', warningWithCode('DeprecationWarning'))).toBe(false)
  })

  it('passes through a warning with no code', () => {
    const w = new Error('bare warning')
    expect(isSuppressedClaudeWarning('warning', w)).toBe(false)
  })

  it('never touches non-warning process events, even with a matching code', () => {
    // Guards against the process.emit wrapper swallowing unrelated events.
    expect(isSuppressedClaudeWarning('exit', warningWithCode(SHADOWED_WARNING_CODE))).toBe(false)
    expect(isSuppressedClaudeWarning('SIGINT', warningWithCode(SHADOWED_WARNING_CODE))).toBe(false)
  })

  it('is safe against non-object / null payloads', () => {
    expect(isSuppressedClaudeWarning('warning', null)).toBe(false)
    expect(isSuppressedClaudeWarning('warning', undefined)).toBe(false)
    expect(isSuppressedClaudeWarning('warning', 'a string warning')).toBe(false)
  })
})
