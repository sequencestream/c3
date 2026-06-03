import { describe, it, expect } from 'vitest'
import { nlToCron, CRON_PRESETS } from './nl-cron.js'
import { isValidCron } from './cron.js'

describe('nlToCron — acceptance phrasings', () => {
  it('every 30 minutes', () => {
    expect(nlToCron('every 30 minutes')).toBe('*/30 * * * *')
    expect(nlToCron('Every 30 min')).toBe('*/30 * * * *')
  })

  it('weekdays at 8am', () => {
    expect(nlToCron('weekdays at 8am')).toBe('0 8 * * 1-5')
    expect(nlToCron('every weekday at 8 am')).toBe('0 8 * * 1-5')
  })

  it('every Monday at 3am', () => {
    expect(nlToCron('every Monday at 3am')).toBe('0 3 * * 1')
    expect(nlToCron('on monday at 3 am')).toBe('0 3 * * 1')
  })
})

describe('nlToCron — additional phrasings', () => {
  it('hourly variants', () => {
    expect(nlToCron('hourly')).toBe('0 * * * *')
    expect(nlToCron('every hour')).toBe('0 * * * *')
    expect(nlToCron('every 2 hours')).toBe('0 */2 * * *')
  })

  it('daily with and without a time', () => {
    expect(nlToCron('daily')).toBe('0 0 * * *')
    expect(nlToCron('every day at 9:30pm')).toBe('30 21 * * *')
    expect(nlToCron('every day at noon')).toBe('0 12 * * *')
    expect(nlToCron('at midnight')).toBe('0 0 * * *')
  })

  it('multiple days', () => {
    expect(nlToCron('every monday and friday at 6pm')).toBe('0 18 * * 1,5')
    expect(nlToCron('weekends at 10am')).toBe('0 10 * * 0,6')
  })

  it('returns null for unrecognised input', () => {
    expect(nlToCron('')).toBeNull()
    expect(nlToCron('whenever I feel like it')).toBeNull()
    expect(nlToCron('the third tuesday after a full moon')).toBeNull()
  })
})

describe('CRON_PRESETS', () => {
  it('every preset is a valid cron expression', () => {
    for (const p of CRON_PRESETS) {
      expect(isValidCron(p.cron), `${p.label} -> ${p.cron}`).toBe(true)
    }
  })
})
