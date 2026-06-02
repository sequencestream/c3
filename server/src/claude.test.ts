import { describe, expect, it } from 'vitest'
import { isDegradableError } from './claude.js'

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
