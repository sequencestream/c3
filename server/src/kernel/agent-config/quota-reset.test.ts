import { describe, expect, it } from 'vitest'
import { parseQuotaResetAt } from './quota-reset.js'

describe('parseQuotaResetAt', () => {
  it('parses session-limit reset time in the configured timezone', () => {
    const now = Date.UTC(2026, 5, 15, 13, 0) // 21:00 Asia/Shanghai
    const resetAt = parseQuotaResetAt(
      "You've hit your session limit · resets 10:40pm (Asia/Shanghai)",
      'Asia/Shanghai',
      now,
    )
    expect(resetAt).toBe(Date.UTC(2026, 5, 15, 14, 40))
  })

  it('rolls past reset times to the next local day', () => {
    const now = Date.UTC(2026, 5, 15, 15, 0) // 23:00 Asia/Shanghai
    const resetAt = parseQuotaResetAt(
      "You've hit your session limit · resets 10:40pm (Asia/Shanghai)",
      'Asia/Shanghai',
      now,
    )
    expect(resetAt).toBe(Date.UTC(2026, 5, 16, 14, 40))
  })

  it('parses AM/PM against a non-UTC timezone', () => {
    const now = Date.UTC(2026, 5, 15, 13, 0) // 09:00 America/New_York
    const resetAt = parseQuotaResetAt(
      'rate limit exceeded, resets 10:40pm (America/New_York)',
      'America/New_York',
      now,
    )
    expect(resetAt).toBe(Date.UTC(2026, 5, 16, 2, 40))
  })

  it('parses 24-hour reset time', () => {
    const now = Date.UTC(2026, 5, 15, 13, 0) // 21:00 Asia/Shanghai
    const resetAt = parseQuotaResetAt('quota exhausted; resets 22:40', 'Asia/Shanghai', now)
    expect(resetAt).toBe(Date.UTC(2026, 5, 15, 14, 40))
  })

  it('returns null when reset time is absent or error is unrelated', () => {
    expect(parseQuotaResetAt('session limit reached', 'Asia/Shanghai')).toBeNull()
    expect(parseQuotaResetAt('tool failed; resets 10:40pm', 'Asia/Shanghai')).toBeNull()
  })
})
