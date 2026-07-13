/**
 * Tests for the framing-free session launch service — the shared core behind
 * both the WS handlers (`start_development`, `write_spec`) and the automation
 * MCP tool (`start_session_for_intent`).
 *
 * Covers:
 *  - `launchWorkSession`: validation gates (status, SDD, dependency)
 *  - `launchSpecSession`: first-time creation, dependency gate checks
 *  - Handler promise never rejects for expected validation failures
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import {
  getIntent,
  insertIntents,
  resetStoreForTests,
  setBranchName,
  updateIntentDeps,
  updateStatus,
} from './store.js'
import { resetSettingsCacheForTests, saveWorkspaceSetting } from '../../kernel/config/index.js'
import { resetStoreForTests as resetSessionMetadata } from '../sessions/session-metadata-store.js'
import {
  launchSpecSession,
  launchWorkSession,
  type SessionLaunchResult,
  type SessionLaunchDeps,
} from './session-launcher.js'

let dir: string
let workspaceId: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-session-launcher-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetStoreForTests()
  resetSessionMetadata()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  workspaceId = pathToId(dir)!
  proj = resolveWorkspaceRoot(workspaceId)!
})

afterEach(() => {
  resetDbForTests()
  resetSessionMetadata()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  rmSync(dir, { recursive: true, force: true })
})

function mockDeps(): SessionLaunchDeps {
  return {
    launchRun: vi.fn().mockResolvedValue(undefined) as unknown as SessionLaunchDeps['launchRun'],
    broadcastIntents: vi.fn(),
  }
}

/** Narrow a SessionLaunchResult that is expected to be a failure. */
function asError(r: SessionLaunchResult): {
  success: false
  code: string
  params?: Record<string, string>
} {
  expect(r.success).toBe(false)
  return r as { success: false; code: string; params?: Record<string, string> }
}

/** Narrow a SessionLaunchResult that is expected to be a success. */
function asSuccess(r: SessionLaunchResult): { success: true; sessionId: string } {
  expect(r.success).toBe(true)
  return r as { success: true; sessionId: string }
}

// ── launchWorkSession ──

describe('launchWorkSession', () => {
  it('returns not found for a non-existent intent', async () => {
    const r = asError(await launchWorkSession(proj, 'non-existent', mockDeps()))
    expect(r.code).toBe('intent.notFound')
  })

  it('rejects an intent in draft status (not todo)', async () => {
    const [intent] = insertIntents(
      proj,
      [{ title: 'Draft intent', shortEnTitle: 'draft', content: '', priority: 'P1' }],
      'draft',
    )
    const r = asError(await launchWorkSession(proj, intent.id, mockDeps()))
    expect(r.code).toBe('intent.cannotStartDev')
  })

  it('rejects when SDD is enabled and spec is not approved', async () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch', sddEnabled: true })
    const [intent] = insertIntents(proj, [
      { title: 'No approval', shortEnTitle: 'no-approve', content: '', priority: 'P1' },
    ])
    const r = asError(await launchWorkSession(proj, intent.id, mockDeps()))
    expect(r.code).toBe('intent.specNotApproved')
  })

  it('rejects a worktree dependency that is not merged', async () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'worktree', defaultMainBranch: 'main' })
    const [dep, target] = insertIntents(proj, [
      { title: 'Dep', shortEnTitle: 'dep', content: '', priority: 'P1' },
      { title: 'Target', shortEnTitle: 'target', content: '', priority: 'P1' },
    ])
    updateIntentDeps(target.id, [{ dependsOnId: dep.id, depType: 'blocks' }])
    updateStatus(dep.id, 'done', 'test')
    setBranchName(dep.id, 'feature/dep')
    const r = asError(await launchWorkSession(proj, target.id, mockDeps()))
    expect(r.code).toBe('intent.dependencyNotMerged')
  })

  it('accepts a todo intent and fires launchRun', async () => {
    const [intent] = insertIntents(proj, [
      { title: 'Valid dev', shortEnTitle: 'valid-dev', content: 'do it', priority: 'P2' },
    ])
    const deps = mockDeps()
    const r = asSuccess(await launchWorkSession(proj, intent.id, deps))
    expect(r.sessionId).toContain(PENDING_SESSION_PREFIX)
    expect(deps.launchRun).toHaveBeenCalledTimes(1)
  })

  it('never throws for expected validation failures', async () => {
    const r = await launchWorkSession(proj, 'nope', mockDeps())
    expect(r.success).toBe(false)
    // No exception thrown — handler promise is not rejected
  })
})

// ── launchSpecSession ──

describe('launchSpecSession', () => {
  it('creates a first spec session for an intent without specSessionId', async () => {
    const deps = mockDeps()
    const [intent] = insertIntents(proj, [
      { title: 'First spec', shortEnTitle: 'first-spec', content: 'write spec', priority: 'P2' },
    ])
    const r = asSuccess(await launchSpecSession(proj, intent.id, deps))
    expect(r.sessionId).toContain(PENDING_SESSION_PREFIX)
    const stored = getIntent(intent.id)
    expect(stored?.specPath).toBeTruthy()
    expect(deps.launchRun).toHaveBeenCalledTimes(1)
  })

  it('rejects a worktree dependency that is not merged', async () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'worktree', defaultMainBranch: 'main' })
    const [dep, target] = insertIntents(proj, [
      { title: 'SpecDep', shortEnTitle: 'spec-dep', content: '', priority: 'P1' },
      { title: 'SpecTarget', shortEnTitle: 'spec-target', content: '', priority: 'P1' },
    ])
    updateIntentDeps(target.id, [{ dependsOnId: dep.id, depType: 'blocks' }])
    updateStatus(dep.id, 'done', 'test')
    setBranchName(dep.id, 'feature/spec-dep')
    const r = asError(await launchSpecSession(proj, target.id, mockDeps()))
    expect(r.code).toBe('intent.dependencyNotMerged')
  })

  it('never throws for expected validation failures', async () => {
    const r = await launchSpecSession(proj, 'nope', mockDeps())
    expect(r.success).toBe(false)
  })
})
