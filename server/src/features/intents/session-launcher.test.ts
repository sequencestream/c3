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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import type { GitActionFailureGuidance, Intent, ServerToClient } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { ensureRuntime, getRuntime, removeRuntimesForWorkspace } from '../../runs.js'
import type { SessionRuntime } from '../../runs.js'
import {
  addWorkspace,
  pathToName,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import {
  getIntent,
  insertIntents,
  resetStoreForTests,
  revokeSpecApproval,
  setBranchName,
  setLastWorkSession,
  setSpecApproved,
  setSpecPath,
  setSpecReviewSessionId,
  setSpecSessionId,
  updateIntentDeps,
  updateStatus,
} from './store.js'
import { createWorktree, pullCurrentBranch } from './worktree.js'

// Both keep their REAL behaviour by default (a bare temp dir has no remote, and
// `git worktree add` genuinely fails there); the spies exist so single tests can
// make one fail with a chosen message — the pull one to prove the spec gate
// treats that as a warning rather than a refusal, the worktree one to pin how a
// real Git error text is classified.
vi.mock('./worktree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worktree.js')>()
  return {
    ...actual,
    pullCurrentBranch: vi.fn(actual.pullCurrentBranch),
    createWorktree: vi.fn(actual.createWorktree),
  }
})
import { resetSettingsCacheForTests, saveWorkspaceSetting } from '../../kernel/config/index.js'
import { resetStoreForTests as resetSessionMetadata } from '../sessions/session-metadata-store.js'
import {
  launchSpecReviewSession,
  launchSpecSession,
  launchWorkSession,
  type SessionLaunchMode,
  type SessionLaunchResult,
  type SessionLaunchDeps,
} from './session-launcher.js'
import { initTestGitRepo } from '../../../test/git-repo.js'

let dir: string
let workspaceName: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-session-launcher-'))
  initTestGitRepo(dir)
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetStoreForTests()
  resetSessionMetadata()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  workspaceName = pathToName(dir)!
  proj = resolveWorkspaceRoot(workspaceName)!
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

function mockDeps(launchRun?: SessionLaunchDeps['launchRun']): SessionLaunchDeps {
  return {
    launchRun:
      launchRun ??
      (vi.fn().mockResolvedValue(undefined) as unknown as SessionLaunchDeps['launchRun']),
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
  guidance?: GitActionFailureGuidance
} {
  expect(r.success).toBe(false)
  return r as {
    success: false
    code: string
    params?: Record<string, string>
    guidance?: GitActionFailureGuidance
  }
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

  it('allows a fast-mode intent to start a manual turn without an approved spec', async () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch', sddEnabled: true })
    const [intent] = insertIntents(proj, [
      {
        title: 'Fast dev',
        shortEnTitle: 'fast-dev',
        content: '',
        priority: 'P1',
        specMode: 'fast',
      },
    ])
    const deps = mockDeps()
    const r = asSuccess(await launchWorkSession(proj, intent.id, deps))
    expect(r.sessionId).toContain(PENDING_SESSION_PREFIX)
    expect(deps.launchRun).toHaveBeenCalledTimes(1)
  })

  it('a fast-mode launch carries an EMPTY systemInstruction (no SDD work contract)', async () => {
    // The SDD work-session instruct is a spec-driven contract; a `fast` intent skips
    // the spec gate by design, so the system channel must stay empty end to end.
    saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch', sddEnabled: true })
    const [intent] = insertIntents(proj, [
      {
        title: 'Fast no instruct',
        shortEnTitle: 'fast-no-instruct',
        content: 'Body text.',
        priority: 'P1',
        specMode: 'fast',
      },
    ])
    const launchRun = vi
      .fn()
      .mockResolvedValue(undefined) as unknown as SessionLaunchDeps['launchRun']
    const deps = mockDeps(launchRun)
    asSuccess(await launchWorkSession(proj, intent.id, deps))
    const call = vi.mocked(launchRun).mock.calls[0]
    const [, visiblePrompt, , inject] = call
    expect(inject?.systemInstruction).toBe('')
    expect(visiblePrompt).toContain('Fast no instruct\n\nBody text.')
    expect(visiblePrompt).not.toContain('Hard constraints')
  })

  it('still rejects a fast-mode intent whose worktree dependency is not merged', async () => {
    // `fast` relaxes ONLY the spec-approval gate — every other gate stays closed.
    saveWorkspaceSetting(proj, {
      gitBranchMode: 'worktree',
      defaultMainBranch: 'main',
      sddEnabled: true,
    })
    const [dep, target] = insertIntents(proj, [
      { title: 'Dep', shortEnTitle: 'dep', content: '', priority: 'P1' },
      {
        title: 'Fast target',
        shortEnTitle: 'fast-target',
        content: '',
        priority: 'P1',
        specMode: 'fast',
      },
    ])
    updateIntentDeps(target.id, [{ dependsOnId: dep.id, depType: 'blocks' }])
    updateStatus(dep.id, 'done', 'test')
    setBranchName(dep.id, 'feature/dep')
    const r = asError(await launchWorkSession(proj, target.id, mockDeps()))
    expect(r.code).toBe('intent.dependencyNotMerged')
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

// ── launchWorkSession: RM-A12 follows the git branch mode ──
//
// The gate keeps two work sessions off the same files. Under `current-branch`
// every intent edits the one shared checkout (cases above); under `worktree`
// each intent has its own directory, so another intent's live session is not a
// file conflict and must not block a launch. Every OTHER gate is unchanged.

describe('launchWorkSession — RM-A12 under worktree isolation', () => {
  beforeEach(() => {
    saveWorkspaceSetting(proj, {
      gitBranchMode: 'worktree',
      defaultMainBranch: '',
      sddEnabled: false,
    })
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

  it('a FRESH launch is no longer rejected while another intent runs', async () => {
    inProgressWithSession('Blocker', 'sess-blocker')
    markRunning('sess-blocker')
    const [target] = insertIntents(proj, [
      { title: 'Target', shortEnTitle: 'target', content: '', priority: 'P1' },
    ])
    // The gate is passed and the launch goes all the way through: under
    // `worktree` the other intent's live session shares no file with this one.
    const r = asSuccess(await launchWorkSession(proj, target.id, mockDeps()))
    expect(r.mode).toBe('fresh')
  })

  it('a RESUME is no longer rejected while another intent runs', async () => {
    inProgressWithSession('Blocker', 'sess-blocker')
    markRunning('sess-blocker')
    const id = inProgressWithSession('Idle target', 'sess-idle-target')
    const deps = mockDeps()
    const r = asSuccess(await launchWorkSession(proj, id, deps))
    expect(r.sessionId).toBe('sess-idle-target')
    expect(r.mode).toBe('resume')
    expect(deps.launchRun).toHaveBeenCalledTimes(1)
  })

  it('the intent OWN running session is still only attached to — never a 2nd turn', async () => {
    inProgressWithSession('Blocker', 'sess-blocker')
    markRunning('sess-blocker')
    const id = inProgressWithSession('Self', 'sess-self')
    markRunning('sess-self')
    const deps = mockDeps()
    const r = asSuccess(await launchWorkSession(proj, id, deps))
    expect(r.mode).toBe('attach')
    expect(deps.launchRun).not.toHaveBeenCalled()
  })

  it('a DANGLING session of another intent blocks nothing here either', async () => {
    inProgressWithSession('Dangling blocker', 'sess-dead')
    const id = inProgressWithSession('Idle target', 'sess-idle-target')
    const r = asSuccess(await launchWorkSession(proj, id, mockDeps()))
    expect(r.mode).toBe('resume')
  })

  it('the OTHER hard gates are untouched: an unanswered question still stops a resume', async () => {
    inProgressWithSession('Blocker', 'sess-blocker')
    markRunning('sess-blocker')
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

  it('the OTHER hard gates are untouched: SDD still requires an approved spec', async () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'worktree', sddEnabled: true })
    inProgressWithSession('Blocker', 'sess-blocker')
    markRunning('sess-blocker')
    const [target] = insertIntents(proj, [
      { title: 'Target', shortEnTitle: 'target', content: '', priority: 'P1' },
    ])
    const r = asError(await launchWorkSession(proj, target.id, mockDeps()))
    expect(r.code).toBe('intent.specNotApproved')
  })

  it('the manual entry and the MCP entry stay in step under worktree too', async () => {
    inProgressWithSession('Blocker', 'sess-blocker')
    markRunning('sess-blocker')
    // One target per entry: two calls against the SAME intent would not compare
    // two fresh launches (the second would attach to the first), and the point
    // here is that both entries run the same gate chain to the same verdict.
    const [viaManualTarget, viaMcpTarget] = insertIntents(proj, [
      { title: 'Target manual', shortEnTitle: 'target-manual', content: '', priority: 'P1' },
      { title: 'Target mcp', shortEnTitle: 'target-mcp', content: '', priority: 'P1' },
    ])
    const viaManual = await launchWorkSession(
      proj,
      viaManualTarget.id,
      mockDeps(),
      () => {},
      'human',
    )
    const viaMcp = await launchWorkSession(proj, viaMcpTarget.id, mockDeps())
    expect(asSuccess(viaManual).mode).toBe('fresh')
    expect(asSuccess(viaMcp).mode).toBe('fresh')
  })
})

// ── launchWorkSession: a RESUME is a new admission, not a continuation ──
//
// A resume fires a real turn, so it must pass the SAME admission chain as a
// fresh launch. Without that, `revoke_spec_approval` — whose contract is "it
// governs admission from here on" — would be theatre for any intent that still
// owns an idle session: the next `start_development` (or the unattended MCP
// `start_session_for_intent`) would keep developing on the revoked spec.

describe('launchWorkSession — resume runs the same admission gates as fresh', () => {
  /** An `in_progress` intent bound to an idle live runtime for `sessionId`. */
  function idleInProgress(title: string, sessionId: string): string {
    const [intent] = insertIntents(proj, [
      {
        title,
        shortEnTitle: title.toLowerCase().replace(/\s+/g, '-'),
        content: '',
        priority: 'P1',
      },
    ])
    updateStatus(intent.id, 'in_progress', 'test')
    setLastWorkSession(intent.id, sessionId)
    ensureRuntime(sessionId, proj, 'default', [], 'work')
    return intent.id
  }

  it('refuses to resume after revoke_spec_approval, and fires no turn', async () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch', sddEnabled: true })
    const id = idleInProgress('Revoked', 'sess-revoked')
    setSpecApproved(id, true, 'human')
    expect(revokeSpecApproval(id)).toBe(true)
    expect(getIntent(id)?.specApproved).toBe(false)

    const deps = mockDeps()
    const r = asError(await launchWorkSession(proj, id, deps))
    expect(r.code).toBe('intent.specNotApproved')
    expect(deps.launchRun).not.toHaveBeenCalled()
  })

  it('refuses to resume an intent that was started before SDD was switched on', async () => {
    // Development began with SDD off — the intent has no approval at all.
    saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch', sddEnabled: false })
    const id = idleInProgress('Pre SDD', 'sess-pre-sdd')
    saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch', sddEnabled: true })

    const deps = mockDeps()
    const r = asError(await launchWorkSession(proj, id, deps))
    expect(r.code).toBe('intent.specNotApproved')
    expect(deps.launchRun).not.toHaveBeenCalled()
  })

  it('refuses to resume while a worktree dependency has not reached the mainline', async () => {
    saveWorkspaceSetting(proj, {
      gitBranchMode: 'worktree',
      defaultMainBranch: 'main',
      sddEnabled: false,
    })
    const [dep] = insertIntents(proj, [
      { title: 'Dep', shortEnTitle: 'dep', content: '', priority: 'P1' },
    ])
    updateStatus(dep.id, 'done', 'test')
    setBranchName(dep.id, 'feature/dep')
    const id = idleInProgress('Depender', 'sess-depender')
    updateIntentDeps(id, [{ dependsOnId: dep.id, depType: 'blocks' }])

    const deps = mockDeps()
    const r = asError(await launchWorkSession(proj, id, deps))
    expect(r.code).toBe('intent.dependencyNotMerged')
    expect(r.params?.title).toBe('Dep')
    expect(r.params?.id).toBe(dep.id)
    expect(deps.launchRun).not.toHaveBeenCalled()
  })

  it('still resumes an approved intent on the SAME id with exactly one turn', async () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch', sddEnabled: true })
    const id = idleInProgress('Approved', 'sess-approved')
    setSpecApproved(id, true, 'human')

    const deps = mockDeps()
    const r = asSuccess(await launchWorkSession(proj, id, deps))
    expect(r.sessionId).toBe('sess-approved')
    expect(r.mode).toBe('resume')
    expect(deps.launchRun).toHaveBeenCalledTimes(1)
  })

  it('attach is untouched: a running turn still attaches after a revoke', async () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch', sddEnabled: true })
    const id = idleInProgress('Running revoked', 'sess-running-revoked')
    setSpecApproved(id, true, 'human')
    revokeSpecApproval(id)
    markRunning('sess-running-revoked')

    const deps = mockDeps()
    const r = asSuccess(await launchWorkSession(proj, id, deps))
    expect(r.mode).toBe('attach')
    expect(r.sessionId).toBe('sess-running-revoked')
    expect(deps.launchRun).not.toHaveBeenCalled()
  })

  it('the manual entry and the MCP entry are refused alike on a revoked spec', async () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'current-branch', sddEnabled: true })
    const id = idleInProgress('Shared gate', 'sess-shared-gate')
    setSpecApproved(id, true, 'human')
    revokeSpecApproval(id)

    const viaManual = await launchWorkSession(proj, id, mockDeps(), () => {}, 'human')
    const viaMcp = await launchWorkSession(proj, id, mockDeps())
    expect(viaManual).toEqual(viaMcp)
    expect(asError(viaManual).code).toBe('intent.specNotApproved')
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

  it('reports the two spec launch stages in order on the way to a fresh session', async () => {
    const [intent] = insertIntents(proj, [
      { title: 'Staged spec', shortEnTitle: 'staged-spec', content: '', priority: 'P1' },
    ])
    const stages: string[] = []
    asSuccess(await launchSpecSession(proj, intent.id, mockDeps(), (s) => stages.push(s)))
    expect(stages).toEqual(['pulling-code', 'launching'])
  })

  it('still launches after a failed pull — the pull is best-effort, not a gate', async () => {
    const [intent] = insertIntents(proj, [
      { title: 'Pull fails', shortEnTitle: 'pull-fails', content: '', priority: 'P1' },
    ])
    vi.mocked(pullCurrentBranch).mockReturnValueOnce({
      ok: false,
      skipped: false,
      message: 'diverged',
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deps = mockDeps()
    const stages: string[] = []

    asSuccess(await launchSpecSession(proj, intent.id, deps, (s) => stages.push(s)))

    expect(stages).toEqual(['pulling-code', 'launching'])
    expect(deps.launchRun).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('never throws for expected validation failures', async () => {
    const r = await launchSpecSession(proj, 'nope', mockDeps())
    expect(r.success).toBe(false)
  })
})

// ── Spec occupancy — the bind-gap fix ───────────────────────────────────────
// The spec-phase slot is occupied from the moment a launch begins (the pending
// id is written into spec_session_id / spec_review_session_id before any
// scaffolding), so a concurrent launch — a second tick, a double-click, a
// manual + queue race — attaches to the in-flight session instead of starting
// a second one; and a launch that dies releases the slot so the queue can
// re-launch.
describe('launchSpecSession — bind-gap occupancy', () => {
  it('attaches to an authoring launch already in flight instead of starting a second', async () => {
    const [intent] = insertIntents(proj, [
      { title: 'In flight', shortEnTitle: 'inflight', content: '', priority: 'P1' },
    ])
    // Simulate a launch that claimed the slot but has not bound yet: a live
    // pending runtime in spec_session_id.
    const inFlight = `${PENDING_SESSION_PREFIX}inflight`
    setSpecSessionId(intent.id, inFlight)
    ensureRuntime(inFlight, proj, 'default', [], 'spec')
    markRunning(inFlight)

    const deps = mockDeps()
    const r = asSuccess(await launchSpecSession(proj, intent.id, deps))

    expect(r).toEqual({ success: true, sessionId: inFlight, mode: 'attach' })
    expect(deps.launchRun).not.toHaveBeenCalled()
    expect(getIntent(intent.id)?.specPath).toBeNull()
  })

  it('concurrent first-time launches scaffold and launch exactly once', async () => {
    const [intent] = insertIntents(proj, [
      { title: 'Concurrent spec', shortEnTitle: 'concurrent-spec', content: '', priority: 'P2' },
    ])
    const deps = mockDeps()

    const [a, b] = await Promise.all([
      launchSpecSession(proj, intent.id, deps),
      launchSpecSession(proj, intent.id, deps),
    ])

    // Only ONE launch may own the slot; the other attaches and scaffolds nothing.
    expect(deps.launchRun).toHaveBeenCalledTimes(1)
    const modes = [a, b].map((r) => (r.success ? r.mode : 'error')).sort()
    expect(modes).toEqual(['attach', 'fresh'])
    // One spec_path backfill, one spec directory.
    expect(getIntent(intent.id)?.specPath).toBeTruthy()
  })

  it('a rejected launchRun releases the occupancy so the same intent can re-launch', async () => {
    const [intent] = insertIntents(proj, [
      { title: 'Fails', shortEnTitle: 'fails', content: '', priority: 'P2' },
    ])
    const deps = mockDeps(
      vi
        .fn()
        .mockRejectedValue(new Error('vendor boom')) as unknown as SessionLaunchDeps['launchRun'],
    )

    const r = asSuccess(await launchSpecSession(proj, intent.id, deps))
    expect(r.mode).toBe('fresh')

    // The fire-and-forget .catch releases the occupancy (the mock rejects
    // immediately, so the release lands by the time the await resolves).
    await vi.waitFor(() => {
      expect(getIntent(intent.id)?.specSessionId).toBeNull()
    })

    // The same intent launches fresh again — nothing is permanently stuck.
    const again = mockDeps()
    const r2 = asSuccess(await launchSpecSession(proj, intent.id, again))
    expect(r2.mode).toBe('fresh')
    expect(again.launchRun).toHaveBeenCalledTimes(1)
  })

  it('a rejected review launch releases the review slot', async () => {
    const [intent] = insertIntents(proj, [
      { title: 'Review fails', shortEnTitle: 'rev-fails', content: '', priority: 'P1' },
    ])
    const specPath = join(dir, 'spec.md')
    setSpecPath(intent.id, specPath)
    writeFileSync(specPath, '# Spec to review', 'utf8')
    const deps = mockDeps(
      vi
        .fn()
        .mockRejectedValue(new Error('vendor boom')) as unknown as SessionLaunchDeps['launchRun'],
    )

    const r = asSuccess(await launchSpecReviewSession(proj, intent.id, deps))
    expect(r.mode).toBe('fresh')

    await vi.waitFor(() => {
      expect(getIntent(intent.id)?.specReviewSessionId).toBeNull()
    })
  })
})

describe('launchSpecReviewSession — bind-gap occupancy', () => {
  it('attaches to a review already in flight (live pending) instead of starting a second', async () => {
    const [intent] = insertIntents(proj, [
      { title: 'Reviewed', shortEnTitle: 'rev', content: '', priority: 'P1' },
    ])
    setSpecPath(intent.id, join(dir, 'spec.md'))
    const inFlight = `${PENDING_SESSION_PREFIX}inflight-review`
    setSpecReviewSessionId(intent.id, inFlight)
    ensureRuntime(inFlight, proj, 'default', [], 'spec_review')
    markRunning(inFlight)

    const deps = mockDeps()
    const r = await launchSpecReviewSession(proj, intent.id, deps)

    expect(r).toEqual({ success: true, sessionId: inFlight, mode: 'attach' })
    expect(deps.launchRun).not.toHaveBeenCalled()
  })
})

/**
 * The dependency gate must land IDENTICALLY on all three spec-launch branches —
 * first-time creation, re-authoring on an existing spec path, and resuming an
 * existing authoring session. They used to share a copied helper; they now share
 * the one gate, and this is what proves it. The blocking fact is the same in
 * every case: a DONE dependency whose feature branch has no merged PR.
 */
describe('launchSpecSession dependency gate (all three branches)', () => {
  function seedBlockedTarget(): { dep: Intent; target: Intent } {
    saveWorkspaceSetting(proj, { gitBranchMode: 'worktree', defaultMainBranch: 'main' })
    const [dep, target] = insertIntents(proj, [
      { title: 'SpecDep', shortEnTitle: 'spec-dep', content: '', priority: 'P1' },
      { title: 'SpecTarget', shortEnTitle: 'spec-target', content: '', priority: 'P1' },
    ])
    updateIntentDeps(target.id, [{ dependsOnId: dep.id, depType: 'blocks' }])
    updateStatus(dep.id, 'done', 'test')
    setBranchName(dep.id, 'feature/spec-dep')
    return { dep, target }
  }

  /** Every branch must refuse with the same code AND the same params. */
  function expectBlocked(r: SessionLaunchResult, dep: Intent): void {
    const err = asError(r)
    expect(err.code).toBe('intent.dependencyNotMerged')
    expect(err.params).toEqual({ title: dep.title, id: dep.id })
  }

  it('blocks the first-time branch before scaffolding a spec', async () => {
    const { dep, target } = seedBlockedTarget()
    const deps = mockDeps()
    const stages: string[] = []

    expectBlocked(await launchSpecSession(proj, target.id, deps, (s) => stages.push(s)), dep)

    // Refused before any side effect: no spec scaffolded, no run, no progress.
    expect(getIntent(target.id)?.specPath).toBeNull()
    expect(deps.launchRun).not.toHaveBeenCalled()
    expect(stages).toEqual([])
  })

  it('blocks the rework-on-existing-path branch without touching the reviewed spec', async () => {
    const { dep, target } = seedBlockedTarget()
    const specPath = join(dir, 'existing-spec.md')
    setSpecPath(target.id, specPath)
    const deps = mockDeps()

    expectBlocked(
      await launchSpecSession(proj, target.id, deps, undefined, null, {
        reworkReason: 'please clarify the boundaries',
        reworkRound: 1,
      }),
      dep,
    )

    // The document under review keeps its path and gains no new session.
    expect(getIntent(target.id)?.specPath).toBe(specPath)
    expect(getIntent(target.id)?.specSessionId).toBeNull()
    expect(deps.launchRun).not.toHaveBeenCalled()
  })

  it('blocks the resume branch without re-launching the existing session', async () => {
    const { dep, target } = seedBlockedTarget()
    setSpecPath(target.id, join(dir, 'existing-spec.md'))
    setSpecSessionId(target.id, 'spec-session-1')
    const deps = mockDeps()

    expectBlocked(await launchSpecSession(proj, target.id, deps), dep)

    expect(deps.launchRun).not.toHaveBeenCalled()
  })
})

/**
 * Targeted failure guidance on the worktree-create boundary. The classification
 * reads the thrown Git message and nothing else, so the assertions here are about
 * what travels with the failure — and about the failure itself staying exactly as
 * final as it was: no session, no branch, no launched run.
 */
describe('launchWorkSession — worktree failure guidance', () => {
  beforeEach(() => {
    saveWorkspaceSetting(proj, {
      gitBranchMode: 'worktree',
      defaultMainBranch: '',
      sddEnabled: false,
    })
  })

  function seedTodo(title: string): Intent {
    const [intent] = insertIntents(proj, [
      { title, shortEnTitle: title.toLowerCase(), content: '', priority: 'P1' },
    ])
    return intent
  }

  it('classifies an occupied branch and offers the start-development retry', async () => {
    const intent = seedTodo('Taken')
    const message =
      "git worktree add 失败: fatal: 'intent-x' is already used by worktree at '/tmp/wt'"
    vi.mocked(createWorktree).mockImplementationOnce(() => {
      throw new Error(message)
    })
    const deps = mockDeps()

    const r = asError(await launchWorkSession(proj, intent.id, deps))

    expect(r.code).toBe('intent.worktreeCreateFailed')
    // The raw text still travels as the historic param — the guidance is additive.
    expect(r.params).toEqual({ message })
    expect(r.guidance).toEqual({
      reason: 'worktree_branch_or_path_taken',
      detail: message,
      retry: { type: 'intent-action', intentId: intent.id, action: 'start-development' },
    })
    // Nothing advanced: no work session, no branch, no run.
    const after = getIntent(intent.id)!
    expect(after.status).toBe('todo')
    expect(after.lastWorkSessionId).toBeNull()
    expect(after.branchName).toBeNull()
    expect(deps.launchRun).not.toHaveBeenCalled()
  })

  it('classifies a filesystem refusal', async () => {
    const intent = seedTodo('Denied')
    const message = 'git worktree add 失败: fatal: could not create directory: Permission denied'
    vi.mocked(createWorktree).mockImplementationOnce(() => {
      throw new Error(message)
    })

    const r = asError(await launchWorkSession(proj, intent.id, mockDeps()))

    expect(r.guidance?.reason).toBe('filesystem_denied')
    expect(r.guidance?.detail).toBe(message)
  })

  it('keeps an unclassifiable error raw, multi-line included', async () => {
    const intent = seedTodo('Weird')
    const message = 'git worktree add 失败: fatal: brand new failure\nsecond line of detail'
    vi.mocked(createWorktree).mockImplementationOnce(() => {
      throw new Error(message)
    })

    const r = asError(await launchWorkSession(proj, intent.id, mockDeps()))

    expect(r.guidance).toEqual({
      reason: 'unknown',
      detail: message,
      retry: { type: 'intent-action', intentId: intent.id, action: 'start-development' },
    })
  })

  it('classifies without running any further Git command', async () => {
    const intent = seedTodo('NoExtra')
    vi.mocked(pullCurrentBranch).mockClear()
    vi.mocked(createWorktree).mockClear()
    vi.mocked(createWorktree).mockImplementationOnce(() => {
      throw new Error('git worktree add 失败: fatal: no space left on device')
    })

    asError(await launchWorkSession(proj, intent.id, mockDeps()))

    // The worktree attempt itself is the only Git work; classification adds none.
    expect(createWorktree).toHaveBeenCalledTimes(1)
    expect(pullCurrentBranch).not.toHaveBeenCalled()
  })

  it('sends no guidance for the admission gates ahead of the Git stage', async () => {
    saveWorkspaceSetting(proj, { gitBranchMode: 'worktree', sddEnabled: true })
    const intent = seedTodo('Unapproved')
    setSpecPath(intent.id, join(dir, 'spec.md'))

    const r = asError(await launchWorkSession(proj, intent.id, mockDeps()))

    expect(r.code).toBe('intent.specNotApproved')
    expect(r.guidance).toBeUndefined()
  })
})
