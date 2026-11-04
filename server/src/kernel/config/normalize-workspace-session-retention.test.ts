import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWorkspaceSetting, normalizeWorkspaceSetting, saveWorkspaceSetting } from './index.js'
import { releaseConfigDb, useConfigDb } from './config-fixture.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-session-retention-'))
  useConfigDb(dir)
})
afterEach(() => {
  releaseConfigDb()
  rmSync(dir, { recursive: true, force: true })
})

describe('workspace session retention', () => {
  it.each([undefined, null, '30', true, NaN, Infinity])(
    'defaults invalid value %s to 15',
    (value) => {
      expect(normalizeWorkspaceSetting({ sessionRetentionDays: value }).sessionRetentionDays).toBe(
        15,
      )
    },
  )

  it.each([
    [7.9, 7],
    [0, 1],
    [-5, 1],
    [0.5, 1],
    [365, 365],
  ])('normalizes %s to %s days', (value, expected) => {
    expect(normalizeWorkspaceSetting({ sessionRetentionDays: value }).sessionRetentionDays).toBe(
      expected,
    )
  })

  it('persists independently for each workspace and survives unrelated edits', () => {
    saveWorkspaceSetting('/test/one', { sessionRetentionDays: 7 })
    saveWorkspaceSetting('/test/two', { sessionRetentionDays: 30 })
    saveWorkspaceSetting('/test/one', { ...loadWorkspaceSetting('/test/one'), devSkill: '/review' })
    expect(loadWorkspaceSetting('/test/one').sessionRetentionDays).toBe(7)
    expect(loadWorkspaceSetting('/test/two').sessionRetentionDays).toBe(30)
    expect(loadWorkspaceSetting('/test/three').sessionRetentionDays).toBe(15)
  })
})
