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
import type { ServerToClient } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { ensureRuntime, getRuntime, removeRuntimesForWorkspace } from '../../runs.js'
import type { SessionRuntime } from '../../runs.js'
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
  setLastWorkSession,
  updateIntentDeps,
  updateStatus,
} from './store.js'
import { resetSettingsCacheForTests, saveWorkspaceSetting } from '../../kernel/config/index.js'
import { resetStoreForTests as resetSessionMetadata } from '../sessions/session-metadata-store.js'
import {
  launchSpecSession,
  launchWorkSession,
  type SessionLaunchMode,
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
  removeRuntimesForWorkspace(proj)
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

/**
 * Make an existing runtime report `isRunning` — a turn is executing. `run` is
 * the only field the liveness probe reads, so a bare abort controller suffices.
 */
function markRunning(sessionId: string): void {
  const rt = getRuntime(sessionId)!
  rt.run = { abort: new AbortController(), handle: null } as SessionRuntime['run']
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
function asSuccess(r: SessionLaunchResult): {
  success: true
  sessionId: string
  mode: SessionLaunchMode
} {
  expect(r.success).toBe(true)
  return r as { success: true; sessionId: string; mode: SessionLaunchMode }
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
    saveWorkspaceSetting(proj, {
      gitBranchMode: 'worktree',
      defaultMainBranch: 'main',
      sddEnabled: false,
    })
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
    saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch', sddEnabled: false })
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

// ── launchWorkSession: attach / resume / fresh ──
//
// The three-way resolution the spec session launcher already had. An
// `in_progress` intent whose session is healthy is no longer rejected with
// `intent.cannotStartDev`; and RM-A12 now lives inside the launcher itself, so
// the manual and the MCP entry share ONE gate.

describe('launchWorkSession — attach / resume / fresh', () => {
  beforeEach(() => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch', sddEnabled: false })
  })

  /** An `in_progress` intent bound to a live runtime for `sessionId`. */
  function inProgressWithSession(title: string, sessionId: string): string {
    const [intent] = insertIntents(proj, [
      { title, shortEnTitle: title.toLowerCase(), content: '', priority: 'P1' },
    ])
    updateStatus(intent.id, 'in_progress', 'test')
    setLastWorkSession(intent.id, sessionId)
    ensureRuntime(sessionId, proj, 'default', [], 'work')
    return intent.id
  }

  it('attaches to a running session: returns the SAME id and sends no new turn', async () => {
    const id = inProgressWithSession('Running', 'sess-running')
    markRunning('sess-running')
    const deps = mockDeps()
    const r = asSuccess(await launchWorkSession(proj, id, deps))
    expect(r.sessionId).toBe('sess-running')
    expect(r.mode).toBe('attach')
    expect(deps.launchRun).not.toHaveBeenCalled()
  })

  it('resumes an idle session on the SAME id instead of creating a new one', async () => {
    const id = inProgressWithSession('Idle', 'sess-idle')
    const deps = mockDeps()
    const r = asSuccess(await launchWorkSession(proj, id, deps))
    expect(r.sessionId).toBe('sess-idle')
    expect(r.mode).toBe('resume')
    expect(deps.launchRun).toHaveBeenCalledTimes(1)
    expect(getIntent(id)?.lastWorkSessionId).toBe('sess-idle')
  })

  it('keeps the fresh path for a todo intent (no session yet)', async () => {
    const [intent] = insertIntents(proj, [
      { title: 'Fresh', shortEnTitle: 'fresh', content: '', priority: 'P1' },
    ])
    const r = asSuccess(await launchWorkSession(proj, intent.id, mockDeps()))
    expect(r.mode).toBe('fresh')
    expect(r.sessionId).toContain(PENDING_SESSION_PREFIX)
  })

  it('keeps the dangling-restart semantics for in_progress without a session', async () => {
    const [intent] = insertIntents(proj, [
      { title: 'Dangling', shortEnTitle: 'dangling', content: '', priority: 'P1' },
    ])
    updateStatus(intent.id, 'in_progress', 'test')
    const r = asSuccess(await launchWorkSession(proj, intent.id, mockDeps()))
    expect(r.mode).toBe('fresh')
    expect(r.sessionId).toContain(PENDING_SESSION_PREFIX)
  })

  it('refuses to resume over an unanswered AskUserQuestion', async () => {
    const id = inProgressWithSession('Asking', 'sess-asking')
    getRuntime('sess-asking')!.buffer.push({
      type: 'tool_use',
      sessionId: 'sess-asking',
      toolUseId: 'tu-1',
      toolName: 'AskUserQuestion',
      input: {},
    } as ServerToClient)
    const deps = mockDeps()
    const r = asError(await launchWorkSession(proj, id, deps))
    expect(r.code).toBe('intent.pendingQuestionUnanswered')
    expect(deps.launchRun).not.toHaveBeenCalled()
  })

  // ── RM-A12, now enforced inside the launcher ──

  it('rejects a FRESH launch while another intent owns a running work session', async () => {
    inProgressWithSession('Blocker', 'sess-blocker')
    markRunning('sess-blocker')
    const [target] = insertIntents(proj, [
      { title: 'Target', shortEnTitle: 'target', content: '', priority: 'P1' },
    ])
    const deps = mockDeps()
    const r = asError(await launchWorkSession(proj, target.id, deps))
    expect(r.code).toBe('intent.concurrencyGate')
    expect(r.params?.title).toBe('Blocker')
    expect(deps.launchRun).not.toHaveBeenCalled()
  })

  it('rejects a RESUME while another intent owns a running work session', async () => {
    inProgressWithSession('Blocker', 'sess-blocker')
    markRunning('sess-blocker')
    const id = inProgressWithSession('Idle target', 'sess-idle-target')
    const deps = mockDeps()
    const r = asError(await launchWorkSession(proj, id, deps))
    expect(r.code).toBe('intent.concurrencyGate')
    expect(deps.launchRun).not.toHaveBeenCalled()
  })

  it('a DANGLING session of another intent never holds the gate shut', async () => {
    inProgressWithSession('Dangling blocker', 'sess-dead')
    const [target] = insertIntents(proj, [
      { title: 'Target', shortEnTitle: 'target', content: '', priority: 'P1' },
    ])
    const r = asSuccess(await launchWorkSession(proj, target.id, mockDeps()))
    expect(r.mode).toBe('fresh')
  })

  it('attaching to the intent OWN running session is not blocked by the gate', async () => {
    const id = inProgressWithSession('Self', 'sess-self')
    markRunning('sess-self')
    const r = asSuccess(await launchWorkSession(proj, id, mockDeps()))
    expect(r.mode).toBe('attach')
  })

  it('the manual entry and the MCP entry produce the same result for the same facts', async () => {
    inProgressWithSession('Blocker', 'sess-blocker')
    markRunning('sess-blocker')
    const [target] = insertIntents(proj, [
      { title: 'Target', shortEnTitle: 'target', content: '', priority: 'P1' },
    ])
    // `start_development` (WS) and `start_session_for_intent` (MCP) both call
    // this one core with the same arguments — one gate, not two.
    const viaManual = await launchWorkSession(proj, target.id, mockDeps(), () => {}, 'human')
    const viaMcp = await launchWorkSession(proj, target.id, mockDeps())
    expect(viaManual).toEqual(viaMcp)
    expect(asError(viaManual).code).toBe('intent.concurrencyGate')
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
