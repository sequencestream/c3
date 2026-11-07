import { describe, expect, it } from 'vitest'
import { nodeMeetsDshEngine, nodeVersionFromProbe, pathNodeVersion } from './node-engine.js'

describe('nodeMeetsDshEngine', () => {
  it('accepts >= 24.9', () => {
    expect(nodeMeetsDshEngine('v24.9.0')).toBe(true)
    expect(nodeMeetsDshEngine('v24.10.0')).toBe(true)
    expect(nodeMeetsDshEngine('v26.13.0')).toBe(true)
  })

  it('rejects below 24.9', () => {
    expect(nodeMeetsDshEngine('v22.10.0')).toBe(false)
    expect(nodeMeetsDshEngine('v24.3.0')).toBe(false)
    expect(nodeMeetsDshEngine('v24.8.9')).toBe(false)
  })
})

describe('nodeVersionFromProbe', () => {
  it('keeps a version printed by node -v', () => {
    expect(nodeVersionFromProbe(0, 'v26.13.0\n')).toBe('v26.13.0')
  })

  it('rejects a failed or unreadable probe', () => {
    expect(nodeVersionFromProbe(1, 'v26.13.0')).toBeNull()
    expect(nodeVersionFromProbe(null, '')).toBeNull()
    expect(nodeVersionFromProbe(0, 'not-a-version')).toBeNull()
  })
})

describe('pathNodeVersion', () => {
  it('reads node -v from PATH once', () => {
    const version = pathNodeVersion()
    expect(version).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(pathNodeVersion()).toBe(version)
  })
})
