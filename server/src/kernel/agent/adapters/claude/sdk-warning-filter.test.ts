import { describe, it, expect } from 'vitest'
import { isSuppressedClaudeWarning, SHADOWED_WARNING_CODE } from './sdk-warning-filter.js'

describe('isSuppressedClaudeWarning', () => {
  it('drops exactly the CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning (options-object form)', () => {
    expect(isSuppressedClaudeWarning({ code: SHADOWED_WARNING_CODE })).toBe(true)
  })

  it('drops the warning in the legacy positional form emitWarning(msg, type, code)', () => {
    expect(isSuppressedClaudeWarning('SomeType', SHADOWED_WARNING_CODE)).toBe(true)
  })

  it('passes through any OTHER warning code (e.g. a real misconfig warning)', () => {
    expect(isSuppressedClaudeWarning({ code: 'SOME_OTHER_WARNING' })).toBe(false)
    expect(isSuppressedClaudeWarning({ code: 'DeprecationWarning' })).toBe(false)
    expect(isSuppressedClaudeWarning('DeprecationWarning', 'DEP0001')).toBe(false)
  })

  it('passes through a warning with no code', () => {
    expect(isSuppressedClaudeWarning(undefined)).toBe(false)
    expect(isSuppressedClaudeWarning({})).toBe(false)
    expect(isSuppressedClaudeWarning('OnlyAType')).toBe(false)
  })

  it('is safe against non-object / null payloads', () => {
    expect(isSuppressedClaudeWarning(null)).toBe(false)
    expect(isSuppressedClaudeWarning('a string warning')).toBe(false)
    expect(isSuppressedClaudeWarning(42)).toBe(false)
  })
})
