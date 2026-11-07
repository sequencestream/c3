import { describe, expect, it } from 'vitest'
import { nodeMeetsDshEngine } from './node-engine.js'

describe('nodeMeetsDshEngine', () => {
  it('accepts >= 24.9', () => {
    expect(nodeMeetsDshEngine('v24.9.0')).toBe(true)
    expect(nodeMeetsDshEngine('v24.10.0')).toBe(true)
  })

  it('rejects below 24.9', () => {
    expect(nodeMeetsDshEngine('v22.10.0')).toBe(false)
    expect(nodeMeetsDshEngine('v24.8.9')).toBe(false)
  })
})
