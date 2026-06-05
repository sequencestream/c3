import { describe, expect, it } from 'vitest'
import { isDegradableError, isSocketDisconnect } from './kernel/agent-config/errors.js'
import {
  isSideEffectTool,
  computeSideEffectPending,
  decideSocketResume,
  type ToolFlowItem,
} from './kernel/run/resume.js'

describe('isDegradableError', () => {
  // -- Rate limit --
  it('detects "rate limit" errors', () => {
    expect(isDegradableError('rate limit exceeded')).toBe(true)
  })

  it('detects "rate_limit" snake-case errors', () => {
    expect(isDegradableError('rate_limit: too many requests')).toBe(true)
  })

  it('detects HTTP 429', () => {
    expect(isDegradableError('HTTP 429 Too Many Requests')).toBe(true)
  })

  it('detects "too many requests" errors', () => {
    expect(isDegradableError('Too Many Requests')).toBe(true)
  })

  // -- Session limit --
  it('detects "session limit" errors', () => {
    expect(isDegradableError('Session limit reached')).toBe(true)
  })

  it('detects "session_limit" snake-case', () => {
    expect(isDegradableError('session_limit exceeded')).toBe(true)
  })

  it('detects "concurrent session" errors', () => {
    expect(isDegradableError('Too many concurrent sessions')).toBe(true)
  })

  // -- Auth --
  it('detects HTTP 401', () => {
    expect(isDegradableError('HTTP 401 Unauthorized')).toBe(true)
  })

  it('detects "authentication failed"', () => {
    expect(isDegradableError('Authentication failed')).toBe(true)
  })

  it('detects "unauthorized"', () => {
    expect(isDegradableError('Unauthorized')).toBe(true)
  })

  it('detects "invalid api key" errors', () => {
    expect(isDegradableError('invalid API key')).toBe(true)
  })

  it('detects "invalid token" errors', () => {
    expect(isDegradableError('invalid auth token')).toBe(true)
  })

  // -- Connection / network --
  it('detects ECONNREFUSED', () => {
    expect(isDegradableError('connect ECONNREFUSED')).toBe(true)
  })

  it('detects ECONNRESET', () => {
    expect(isDegradableError('read ECONNRESET')).toBe(true)
  })

  it('detects ETIMEDOUT', () => {
    expect(isDegradableError('connect ETIMEDOUT')).toBe(true)
  })

  it('detects EHOSTUNREACH', () => {
    expect(isDegradableError('EHOSTUNREACH')).toBe(true)
  })

  it('detects "connection refused"', () => {
    expect(isDegradableError('Connection refused')).toBe(true)
  })

  it('detects "connection reset"', () => {
    expect(isDegradableError('Connection reset by peer')).toBe(true)
  })

  // -- Server-side errors --
  it('detects HTTP 500', () => {
    expect(isDegradableError('HTTP 500 Internal Server Error')).toBe(true)
  })

  it('detects HTTP 503', () => {
    expect(isDegradableError('503 Service Unavailable')).toBe(true)
  })

  it('detects "service unavailable"', () => {
    expect(isDegradableError('Service Unavailable')).toBe(true)
  })

  it('detects "internal server error"', () => {
    expect(isDegradableError('Internal Server Error')).toBe(true)
  })

  it('detects "bad gateway"', () => {
    expect(isDegradableError('Bad Gateway')).toBe(true)
  })

  // -- Quota --
  it('detects "quota exceeded"', () => {
    expect(isDegradableError('Quota exceeded')).toBe(true)
  })

  it('detects "exhausted" errors', () => {
    expect(isDegradableError('Resource exhausted')).toBe(true)
  })

  it('detects "insufficient quota"', () => {
    expect(isDegradableError('Insufficient quota')).toBe(true)
  })

  // -- Non-degradable errors (should return false) --
  it('returns false for empty string', () => {
    expect(isDegradableError('')).toBe(false)
  })

  it('returns false for non-error messages', () => {
    expect(isDegradableError('Tool execution failed: file not found')).toBe(false)
  })

  it('returns false for internal model errors', () => {
    expect(isDegradableError('Model returned an invalid response')).toBe(false)
  })

  it('returns false for permission errors', () => {
    expect(isDegradableError('Permission denied')).toBe(false)
  })

  it('returns false for generic tool errors', () => {
    expect(isDegradableError('The tool Bash returned an error: exit code 1')).toBe(false)
  })

  it('returns false for syntax errors', () => {
    expect(isDegradableError('SyntaxError: Unexpected token')).toBe(false)
  })

  it('returns false for string literal "auth" alone (inside larger context)', () => {
    // The pattern should match "auth" as a word boundary, not substring of "authenticate"
    expect(isDegradableError('Something went wrong')).toBe(false)
  })

  it('returns false for "42" (not a 4xx/5xx)', () => {
    expect(isDegradableError('The answer is 42')).toBe(false)
  })
})

describe('isSocketDisconnect (narrow classifier — AS-R18)', () => {
  it('matches the exact socket-disconnect phrase', () => {
    expect(isSocketDisconnect('socket connection was closed unexpectedly')).toBe(true)
  })

  it('matches case-insensitively and inside a larger message', () => {
    expect(isSocketDisconnect('Error: Socket connection was closed unexpectedly\n  at ...')).toBe(
      true,
    )
  })

  it('does NOT match a generic connection error', () => {
    expect(isSocketDisconnect('Connection reset by peer')).toBe(false)
    expect(isSocketDisconnect('connect ECONNRESET')).toBe(false)
    expect(isSocketDisconnect('network error')).toBe(false)
  })

  it('does NOT match a plain tool/model error', () => {
    expect(isSocketDisconnect('Tool execution failed: file not found')).toBe(false)
    expect(isSocketDisconnect('rate limit exceeded')).toBe(false)
  })
})

describe('socket vs degradable classifiers do not pollute each other', () => {
  it('the socket phrase is NOT degradable (must not enter the degradation chain)', () => {
    expect(isDegradableError('socket connection was closed unexpectedly')).toBe(false)
  })

  it('degradable messages are NOT socket disconnects', () => {
    for (const msg of [
      'rate limit exceeded',
      'HTTP 429 Too Many Requests',
      'Session limit reached',
      'Unauthorized',
      'connect ECONNREFUSED',
      'Connection reset by peer',
      '503 Service Unavailable',
      'Quota exceeded',
    ]) {
      expect(isSocketDisconnect(msg)).toBe(false)
    }
  })
})

describe('isSideEffectTool (auto-resume gate allowlist — AS-R19)', () => {
  it('treats the read-only allowlist as side-effect-free', () => {
    for (const t of [
      'Read',
      'Grep',
      'Glob',
      'LS',
      'NotebookRead',
      'WebFetch',
      'WebSearch',
      'TaskCreate',
      'TaskList',
      'TaskUpdate',
      'TaskGet',
      'AskUserQuestion',
    ]) {
      expect(isSideEffectTool(t)).toBe(false)
    }
  })

  it('treats write-class tools as side-effect tools', () => {
    for (const t of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) {
      expect(isSideEffectTool(t)).toBe(true)
    }
  })

  it('conservatively treats unknown / MCP tools as side-effect tools', () => {
    expect(isSideEffectTool('mcp__c3__save_requirements')).toBe(true)
    expect(isSideEffectTool('SomeFutureTool')).toBe(true)
  })
})

describe('computeSideEffectPending (tool_use↔tool_result pairing — AS-R19)', () => {
  it('is true when a write-class tool_use has no tool_result yet', () => {
    const flow: ToolFlowItem[] = [{ type: 'text' }, { type: 'tool_use', id: 't1', name: 'Edit' }]
    expect(computeSideEffectPending(flow)).toBe(true)
  })

  it('is false when the trailing message is plain text', () => {
    const flow: ToolFlowItem[] = [{ type: 'text' }]
    expect(computeSideEffectPending(flow)).toBe(false)
  })

  it('is false when every side-effect tool_use already returned its tool_result', () => {
    const flow: ToolFlowItem[] = [
      { type: 'tool_use', id: 't1', name: 'Edit' },
      { type: 'tool_result', toolUseId: 't1' },
      { type: 'text' },
    ]
    expect(computeSideEffectPending(flow)).toBe(false)
  })

  it('is false when an unclosed tool_use is a read-only (side-effect-free) tool', () => {
    const flow: ToolFlowItem[] = [{ type: 'tool_use', id: 'r1', name: 'Read' }]
    expect(computeSideEffectPending(flow)).toBe(false)
  })

  it('tracks multiple writes and clears only the returned one', () => {
    const flow: ToolFlowItem[] = [
      { type: 'tool_use', id: 'a', name: 'Write' },
      { type: 'tool_use', id: 'b', name: 'Bash' },
      { type: 'tool_result', toolUseId: 'a' },
    ]
    // `b` (Bash) is still open ⇒ pending.
    expect(computeSideEffectPending(flow)).toBe(true)
  })
})

describe('decideSocketResume (AS-R18/R19 gated single resume)', () => {
  const base = {
    autoResumeEnabled: true,
    sideEffectPending: false,
    retryAlreadyUsed: false,
    isPendingSession: false,
    isTeam: false,
    aborted: false,
  }

  it('auto-resumes when every condition is clear', () => {
    expect(decideSocketResume('socket', base).action).toBe('auto-resume')
  })

  it('refuses (manual-error) when the side-effect gate is pending', () => {
    const d = decideSocketResume('socket', { ...base, sideEffectPending: true })
    expect(d.action).toBe('manual-error')
    if (d.action === 'manual-error') {
      expect(d.turnEnd).toMatchObject({
        reason: 'error',
        side_effect_pending: true,
        reconnect_attempted: false,
        retry_count: 0,
        original_error: 'socket',
      })
    }
  })

  it('refuses when the switch is off', () => {
    expect(decideSocketResume('socket', { ...base, autoResumeEnabled: false }).action).toBe(
      'manual-error',
    )
  })

  it('refuses (bounded) when the single retry is already spent and records the attempt', () => {
    const d = decideSocketResume('socket', { ...base, retryAlreadyUsed: true })
    expect(d.action).toBe('manual-error')
    if (d.action === 'manual-error') {
      expect(d.turnEnd.reconnect_attempted).toBe(true)
      expect(d.turnEnd.retry_count).toBe(1)
    }
  })

  it('refuses for a pending (unbound) session, a team lead, or an aborted run', () => {
    expect(decideSocketResume('s', { ...base, isPendingSession: true }).action).toBe('manual-error')
    expect(decideSocketResume('s', { ...base, isTeam: true }).action).toBe('manual-error')
    expect(decideSocketResume('s', { ...base, aborted: true }).action).toBe('manual-error')
  })
})
