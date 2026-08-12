/**
 * Persistence round-trip for the SDD machine spec-approval opt-in
 * (`WorkspaceSetting.specMachineApprovalEnabled`).
 *
 * The flag is a strict per-workspace opt-in: only an explicit boolean `true`
 * opens machine approval, and it must survive the full save → store → reload
 * round trip. A prior defect dropped the key inside `normalizeWorkspaceSetting`
 * (the field was absent from the reconstructed object), so a Save never reached
 * storage and the next load read it back as OFF — the toggle appeared to revert
 * after saving. These tests pin the write path end to end.
 *
 * Runs against a throwaway database, so the stored-row assertions are deterministic
 * and independent of `$HOME` resolution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { WorkspaceSetting } from '@ccc/shared/protocol'
import { loadWorkspaceSetting, saveWorkspaceSetting, resetSettingsCacheForTests } from './index.js'
import { readStoredWorkspaceSetting, releaseConfigDb, useConfigDb } from './config-fixture.js'

const TEST_PROJ = '/test/project'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'c3-machine-approval-'))
  useConfigDb(tmpDir)
})

afterEach(() => {
  releaseConfigDb()
  rmSync(tmpDir, { recursive: true, force: true })
})

/** The stored rows for the test workspace, as they would be read back. */
function storedEntry(): Record<string, unknown> | undefined {
  return readStoredWorkspaceSetting(TEST_PROJ)
}

describe('machine spec-approval persistence (saveWorkspaceSetting → loadWorkspaceSetting)', () => {
  it('reads as disabled when never set (opt-in default OFF)', () => {
    saveWorkspaceSetting(TEST_PROJ, {} as WorkspaceSetting)
    expect(loadWorkspaceSetting(TEST_PROJ).specMachineApprovalEnabled === true).toBe(false)
    // The key is not stored at all when the opt-in is off.
    expect('specMachineApprovalEnabled' in (storedEntry() ?? {})).toBe(false)
  })

  it('round-trips an explicit true through save → disk → reload', () => {
    saveWorkspaceSetting(TEST_PROJ, {
      sddEnabled: true,
      specMachineApprovalEnabled: true,
    } as WorkspaceSetting)
    // In-memory reload keeps the opt-in.
    expect(loadWorkspaceSetting(TEST_PROJ).specMachineApprovalEnabled).toBe(true)
    // The stored row actually carries the key as `true` — not just the normalized
    // in-memory view. This is the regression the defect caused.
    expect(storedEntry()?.specMachineApprovalEnabled).toBe(true)
  })

  it('a cold reload from the store (cache cleared) still reads true', () => {
    saveWorkspaceSetting(TEST_PROJ, { specMachineApprovalEnabled: true } as WorkspaceSetting)
    // Drop the in-memory cache so the next load re-reads the stored rows — the value
    // must have been persisted, not merely cached.
    resetSettingsCacheForTests()
    expect(loadWorkspaceSetting(TEST_PROJ).specMachineApprovalEnabled).toBe(true)
  })

  it('survives a later save of other fields (no clobber of the opt-in)', () => {
    saveWorkspaceSetting(TEST_PROJ, {
      sddEnabled: true,
      specMachineApprovalEnabled: true,
    } as WorkspaceSetting)
    // A subsequent collab save carries the flag alongside other edited fields; the
    // persisted true must not be dropped by the re-normalize on the write path.
    saveWorkspaceSetting(TEST_PROJ, {
      sddEnabled: true,
      maxRoundsPerStage: 20,
      specMachineApprovalEnabled: true,
    } as WorkspaceSetting)
    expect(loadWorkspaceSetting(TEST_PROJ).specMachineApprovalEnabled).toBe(true)
    expect(loadWorkspaceSetting(TEST_PROJ).maxRoundsPerStage).toBe(20)
    expect(storedEntry()?.specMachineApprovalEnabled).toBe(true)
  })

  it('turning the opt-in back off removes the stored key', () => {
    saveWorkspaceSetting(TEST_PROJ, { specMachineApprovalEnabled: true } as WorkspaceSetting)
    expect(loadWorkspaceSetting(TEST_PROJ).specMachineApprovalEnabled).toBe(true)
    saveWorkspaceSetting(TEST_PROJ, { specMachineApprovalEnabled: false } as WorkspaceSetting)
    expect(loadWorkspaceSetting(TEST_PROJ).specMachineApprovalEnabled === true).toBe(false)
    expect('specMachineApprovalEnabled' in (storedEntry() ?? {})).toBe(false)
  })
})
