import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutomationStatus } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../db.js'
import {
  getRequirement,
  insertRequirements,
  resetStoreForTests,
  setAutomate,
  setLastDevSession,
  updateStatus,
} from './store.js'

// Mock the heavy collaborators so the test exercises only the state machine.
const judgeMock = vi.fn()
const commitMock = vi.fn()
vi.mock('./judge.js', () => ({ judgeCompletion: (...a: unknown[]) => judgeMock(...a) }))
vi.mock('../../git.js', () => ({
  gitDiffStat: async () => 'M file.ts | 1 +',
  gitRecentLog: async () => 'abc123 feat: prior work',
  commitAndPush: (...a: unknown[]) => commitMock(...a),
}))
// The launch prompt's skill prefix comes from system settings; mock it so tests
// don't depend on the developer's on-disk config and can exercise a custom skill.
// Default is empty (no prefix), matching the real default.
const devSkillMock = vi.fn(() => '')
vi.mock('../../kernel/config/index.js', () => ({ getDevSkill: () => devSkillMock() }))

// Imported AFTER the mocks so automation.ts binds to the mocked modules.
const { startAutomation, stopAutomation, getAutomationStatus } = await import('./automation.js')
import type { AutomationHooks, DevTurnResult } from './automation.js'

let dir: string
const proj = '/abs/auto-proj'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-auto-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  judgeMock.mockReset()
  commitMock.mockReset()
  commitMock.mockResolvedValue({ ok: true, committed: true })
  devSkillMock.mockReturnValue('')
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

/** Drive startAutomation and resolve once the orchestrator reaches a terminal state. */
function runToEnd(
  runDevTurn: AutomationHooks['runDevTurn'],
  sessionExists: AutomationHooks['sessionExists'] = async () => false,
  isRunning: AutomationHooks['isRunning'] = () => false,
): Promise<{ final: AutomationStatus; emitted: AutomationStatus[] }> {
  const emitted: AutomationStatus[] = []
  return new Promise((resolve) => {
    const hooks: AutomationHooks = {
      runDevTurn,
      broadcastRequirements: () => {},
      sessionExists,
      isRunning,
      emitStatus: (s) => {
        emitted.push(s)
        if (s.state === 'done' || s.state === 'error' || s.state === 'idle') {
          // Defer so any trailing synchronous work in the loop settles first.
          setTimeout(() => resolve({ final: s, emitted }), 0)
        }
      },
    }
    startAutomation(proj, hooks, 1000)
  })
}

/** A runDevTurn that always reports a clean turn end, recording the prompts seen. */
function completingTurn(prompts: string[]): AutomationHooks['runDevTurn'] {
  let n = 0
  return async (input): Promise<DevTurnResult> => {
    prompts.push(input.prompt)
    return { outcome: 'complete', sessionId: `sess-${n++}`, lastMessage: '已完成并自验证' }
  }
}

describe('automation orchestrator', () => {
  it('develops eligible requirements P0→P1, commits each, ends done', async () => {
    const [p1, p0] = insertRequirements(proj, [
      { title: 'low', content: 'c', priority: 'P1' },
      { title: 'high', content: 'c', priority: 'P0' },
    ])
    setAutomate(p1.id, true)
    setAutomate(p0.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })

    const prompts: string[] = []
    const { final } = await runToEnd(completingTurn(prompts))

    expect(final.state).toBe('done')
    expect(final.completedIds).toEqual([p0.id, p1.id]) // P0 first
    expect(getRequirement(p0.id)?.status).toBe('done')
    expect(getRequirement(p1.id)?.status).toBe('done')
    expect(commitMock).toHaveBeenCalledTimes(2)
    // With no dev skill configured (default), the launch prompt is just the title/content.
    expect(prompts[0]).toMatch(/^high\n/)
    expect(prompts[1]).toMatch(/^low\n/)
  })

  it('prefixes the launch prompt with the configured dev skill', async () => {
    devSkillMock.mockReturnValue('/my-skill')
    const [r] = insertRequirements(proj, [{ title: 'custom', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })

    const prompts: string[] = []
    const { final } = await runToEnd(completingTurn(prompts))

    expect(final.state).toBe('done')
    expect(prompts[0]).toMatch(/^\/my-skill custom\n/)
  })

  it('omits the skill prefix when no dev skill is configured', async () => {
    devSkillMock.mockReturnValue('')
    const [r] = insertRequirements(proj, [{ title: 'plain', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })

    const prompts: string[] = []
    const { final } = await runToEnd(completingTurn(prompts))

    expect(final.state).toBe('done')
    // No leading space, no slash command — the prompt starts straight with the title.
    expect(prompts[0]).toMatch(/^plain\n/)
  })

  it('orders by intra-batch dependency, not submission/createdAt — the depended-on item starts first', async () => {
    // A is submitted first (so its createdAt is earlier) but declares an intra-batch
    // dependency on B (index 1). B must therefore develop before A despite A's earlier
    // createdAt: the index ref was resolved to B's real id at insert time, so pickNext's
    // dependency gate holds A back until B is done.
    const [a, b] = insertRequirements(proj, [
      { title: 'depends', content: 'c', priority: 'P0', dependsOnIndexes: [1] },
      { title: 'prereq', content: 'c', priority: 'P0' },
    ])
    expect(a.dependsOn).toEqual([b.id]) // index resolved to the sibling's real id
    setAutomate(a.id, true)
    setAutomate(b.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })

    const prompts: string[] = []
    const { final } = await runToEnd(completingTurn(prompts))

    expect(final.state).toBe('done')
    expect(final.completedIds).toEqual([b.id, a.id]) // prereq (B) before dependent (A)
    expect(prompts[0]).toMatch(/^prereq\n/)
    expect(prompts[1]).toMatch(/^depends\n/)
  })

  it('flips the requirement to in_progress as soon as the dev session binds (before the turn ends)', async () => {
    const [r] = insertRequirements(proj, [{ title: 'early', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })

    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    let statusAtBind: string | undefined
    let sessionAtBind: string | null | undefined

    await new Promise<void>((resolve) => {
      const hooks: AutomationHooks = {
        runDevTurn: async (input) => {
          // Bind the session early, then block until the test inspects the state.
          input.onSessionId?.('sess-early')
          await gate
          return { outcome: 'complete', sessionId: 'sess-early', lastMessage: '完成' }
        },
        broadcastRequirements: () => {},
        sessionExists: async () => false,
        isRunning: () => false,
        emitStatus: (s) => {
          // The moment the bind marks currentSessionId, snapshot the persisted status.
          if (s.currentSessionId === 'sess-early' && statusAtBind === undefined) {
            statusAtBind = getRequirement(r.id)?.status
            sessionAtBind = getRequirement(r.id)?.lastDevSessionId
            release() // let the (still-pending) turn finish
          }
          if (s.state === 'done') setTimeout(resolve, 0)
        },
      }
      startAutomation(proj, hooks, 1000)
    })

    // in_progress + lastDevSessionId were set at bind time — not at turn end.
    expect(statusAtBind).toBe('in_progress')
    expect(sessionAtBind).toBe('sess-early')
  })

  it('resumes an in_progress requirement whose lastDevSessionId still exists on disk', async () => {
    const [r] = insertRequirements(proj, [{ title: 'resume-me', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    // Simulate a half-built dev session linked to the requirement.
    updateStatus(r.id, 'in_progress')
    setLastDevSession(r.id, 'sess-existing')
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })

    const seen: (string | null)[] = []
    const runDevTurn: AutomationHooks['runDevTurn'] = async (input) => {
      seen.push(input.sessionId)
      return {
        outcome: 'complete',
        sessionId: input.sessionId ?? 'sess-bound',
        lastMessage: '完成',
      }
    }
    // The linked session exists on disk → it must be resumed.
    const { final } = await runToEnd(runDevTurn, async (_p, id) => id === 'sess-existing')

    expect(final.state).toBe('done')
    expect(seen[0]).toBe('sess-existing') // resumed with the real id, not null
  })

  it('falls back to a fresh session when the lastDevSessionId is dangling', async () => {
    const [missing] = insertRequirements(proj, [{ title: 'gone', content: 'c', priority: 'P0' }])
    const [blank] = insertRequirements(proj, [{ title: 'blank', content: 'c', priority: 'P1' }])
    setAutomate(missing.id, true)
    setAutomate(blank.id, true)
    // `missing`: has an id but the session was deleted; `blank`: in_progress with no id.
    updateStatus(missing.id, 'in_progress')
    setLastDevSession(missing.id, 'sess-deleted')
    updateStatus(blank.id, 'in_progress')
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })

    const seen: (string | null)[] = []
    const runDevTurn: AutomationHooks['runDevTurn'] = async (input) => {
      seen.push(input.sessionId)
      return { outcome: 'complete', sessionId: input.sessionId ?? 'sess-new', lastMessage: '完成' }
    }
    // No session exists on disk → both dangling requirements start fresh (null).
    const { final } = await runToEnd(runDevTurn, async () => false)

    expect(final.state).toBe('done')
    expect(seen).toEqual([null, null]) // P0 (deleted id) then P1 (blank id), both fresh
  })

  it('attaches to (does not relaunch) a requirement whose dev session is already running', async () => {
    const [r] = insertRequirements(proj, [{ title: 'attach-me', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    // A turn is already in flight on the linked dev session (run outlives the turn).
    updateStatus(r.id, 'in_progress')
    setLastDevSession(r.id, 'sess-live')
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })

    const seen: { sessionId: string | null; attach: boolean | undefined }[] = []
    let sessionWhileTracking: string | null = null
    const runDevTurn: AutomationHooks['runDevTurn'] = async (input) => {
      seen.push({ sessionId: input.sessionId, attach: input.attach })
      // The status must already point at the tracked session before the turn ends.
      sessionWhileTracking = getAutomationStatus(proj).currentSessionId
      return { outcome: 'complete', sessionId: input.sessionId ?? 'bound', lastMessage: '完成' }
    }
    // isRunning → true only for the linked session; sessionExists is irrelevant here.
    const { final } = await runToEnd(
      runDevTurn,
      async () => true,
      (id) => id === 'sess-live',
    )

    expect(final.state).toBe('done')
    // First turn attaches the in-flight run with the real id — no fresh/resume launch.
    expect(seen[0]).toEqual({ sessionId: 'sess-live', attach: true })
    // currentSessionId pointed at the tracked session DURING the turn, not only after.
    expect(sessionWhileTracking).toBe('sess-live')
  })

  it('does NOT attach when the dev session is not running (falls back to resume/fresh)', async () => {
    const [r] = insertRequirements(proj, [{ title: 'not-live', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    updateStatus(r.id, 'in_progress')
    setLastDevSession(r.id, 'sess-idle')
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })

    const seen: { sessionId: string | null; attach: boolean | undefined }[] = []
    const runDevTurn: AutomationHooks['runDevTurn'] = async (input) => {
      seen.push({ sessionId: input.sessionId, attach: input.attach })
      return { outcome: 'complete', sessionId: input.sessionId ?? 'bound', lastMessage: '完成' }
    }
    // Not running → no attach; on disk → resume (req-004 logic), so the real id is used.
    const { final } = await runToEnd(
      runDevTurn,
      async (_p, id) => id === 'sess-idle',
      () => false,
    )

    expect(final.state).toBe('done')
    expect(seen[0].attach).toBeFalsy() // not attached
    expect(seen[0].sessionId).toBe('sess-idle') // resumed, per req-004
  })

  it('global gate blocks when a non-automate manual run is in progress, waits for it, then proceeds', async () => {
    // A non-automate requirement already in_progress with a running dev session.
    const [manual] = insertRequirements(proj, [
      { title: 'manual-work', content: 'c', priority: 'P0' },
    ])
    updateStatus(manual.id, 'in_progress')
    setLastDevSession(manual.id, 'sess-manual')

    // An automate requirement eligible for the orchestrator.
    const [auto] = insertRequirements(proj, [{ title: 'auto-work', content: 'c', priority: 'P1' }])
    setAutomate(auto.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })

    const seen: { sessionId: string | null; attach?: boolean }[] = []
    let manualRunning = true
    const runDevTurn: AutomationHooks['runDevTurn'] = async (input) => {
      seen.push({ sessionId: input.sessionId, attach: input.attach })
      if (input.attach && input.sessionId === 'sess-manual') {
        manualRunning = false // turn settled → gate clears on re-check
        return { outcome: 'complete', sessionId: 'sess-manual', lastMessage: 'done' }
      }
      return {
        outcome: 'complete',
        sessionId: input.sessionId ?? 'sess-auto',
        lastMessage: '完成',
      }
    }

    const { final } = await runToEnd(
      runDevTurn,
      async () => false,
      (id) => id === 'sess-manual' && manualRunning,
    )

    expect(final.state).toBe('done')
    expect(final.completedIds).toEqual([auto.id])
    // First call: gate attaches to the manual session.
    expect(seen[0]).toEqual({ sessionId: 'sess-manual', attach: true })
    // Second call: develop picks the automate requirement (fresh launch).
    expect(seen[1].sessionId).toBeNull()
    expect(seen[1].attach).toBeFalsy()
    expect(commitMock).toHaveBeenCalledTimes(1)
  })

  it('dangling (exists but not running) does not block the global gate', async () => {
    // A non-automate requirement in_progress but NOT running (dangling on disk).
    const [manual] = insertRequirements(proj, [{ title: 'dangling', content: 'c', priority: 'P0' }])
    updateStatus(manual.id, 'in_progress')
    setLastDevSession(manual.id, 'sess-dead')

    // An automate requirement eligible for the orchestrator.
    const [auto] = insertRequirements(proj, [{ title: 'auto', content: 'c', priority: 'P0' }])
    setAutomate(auto.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })

    const seen: string[] = []
    const { final } = await runToEnd(
      async (input) => {
        seen.push(`dev:${input.sessionId ?? 'null'},attach:${!!input.attach}`)
        return {
          outcome: 'complete',
          sessionId: input.sessionId ?? 'sess-auto',
          lastMessage: '完成',
        }
      },
      async () => true, // all sessions "exist on disk"
      () => false, // none are running
    )

    expect(final.state).toBe('done')
    expect(final.completedIds).toEqual([auto.id])
    // The gate should not have attached to anything — went straight to develop.
    expect(seen[0]).toBe('dev:null,attach:false') // fresh launch for the automate req
    expect(commitMock).toHaveBeenCalledTimes(1)
  })

  it('skips requirements without the automate flag', async () => {
    const [on, off] = insertRequirements(proj, [
      { title: 'on', content: 'c', priority: 'P0' },
      { title: 'off', content: 'c', priority: 'P0' },
    ])
    setAutomate(on.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })

    const { final } = await runToEnd(completingTurn([]))

    expect(final.completedIds).toEqual([on.id])
    expect(getRequirement(off.id)?.status).toBe('todo') // untouched
  })

  it('does not pick a requirement whose dependency is unfinished', async () => {
    // dep stays todo (not automated); main depends on it → main is blocked.
    const [dep] = insertRequirements(proj, [{ title: 'dep', content: 'c', priority: 'P1' }])
    const [main] = insertRequirements(proj, [
      { title: 'main', content: 'c', priority: 'P0', dependsOn: [dep.id] },
    ])
    setAutomate(main.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })

    const { final } = await runToEnd(completingTurn([]))

    expect(final.state).toBe('done')
    expect(final.completedIds).toEqual([]) // nothing eligible
  })

  it('continues with continue when the judge says in_progress, then completes', async () => {
    const [r] = insertRequirements(proj, [{ title: 'multi', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock
      .mockResolvedValueOnce({ verdict: 'in_progress', reason: '检查点' })
      .mockResolvedValueOnce({ verdict: 'done', reason: 'ok' })

    const prompts: string[] = []
    const { final } = await runToEnd(completingTurn(prompts))

    expect(final.state).toBe('done')
    expect(prompts[0]).toMatch(/^multi\n/)
    expect(prompts[1]).toBe('continue') // resumed after the checkpoint
  })

  it('stops (does NOT continue) when the turn ends on an unanswered question, even if the judge says in_progress', async () => {
    const [r] = insertRequirements(proj, [{ title: 'asks', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    // The judge mis-reads the human-decision point as a checkpoint…
    judgeMock.mockResolvedValue({ verdict: 'in_progress', reason: '检查点' })

    // …but the turn carries the pendingQuestion guard, so the loop must stop.
    const prompts: string[] = []
    const runDevTurn: AutomationHooks['runDevTurn'] = async (input) => {
      prompts.push(input.prompt)
      return {
        outcome: 'complete',
        sessionId: 'sess-ask',
        lastMessage: '用方案A还是方案B?',
        pendingQuestion: true,
      }
    }
    const { final } = await runToEnd(runDevTurn)

    expect(final.state).toBe('error')
    expect(final.error).toContain('人工决策')
    expect(commitMock).not.toHaveBeenCalled()
    expect(prompts).toEqual([expect.stringMatching(/^asks\n/)]) // no second continue
  })

  it('stops with an error when the judge says stuck', async () => {
    const [r] = insertRequirements(proj, [{ title: 'bad', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'stuck', reason: '反复失败' })

    const { final } = await runToEnd(completingTurn([]))

    expect(final.state).toBe('error')
    expect(final.error).toContain('反复失败')
    expect(commitMock).not.toHaveBeenCalled()
  })

  it('does NOT stop on a permission prompt — surfaces "awaiting", then continues when answered', async () => {
    const [r] = insertRequirements(proj, [{ title: 'perm', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })

    // The turn pauses on a permission prompt (signals awaiting), then the watching
    // human answers in the browser and the turn settles complete — exactly like manual.
    const { final, emitted } = await runToEnd(async (input) => {
      input.onAwaitingPermission?.(true)
      return { outcome: 'complete', sessionId: 'sess-x', lastMessage: '已完成并自验证' }
    })

    // The "awaiting authorization" hint was surfaced while paused…
    expect(emitted.some((s) => s.awaitingPermission)).toBe(true)
    // …and cleared once the turn settled; the loop ran to completion (no stop).
    expect(final.state).toBe('done')
    expect(final.awaitingPermission).toBe(false)
    expect(getRequirement(r.id)?.status).toBe('done')
  })

  it('stops with an error when commit/push fails', async () => {
    const [r] = insertRequirements(proj, [{ title: 'push', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })
    commitMock.mockResolvedValue({ ok: false, committed: true, error: 'git push 失败: rejected' })

    const { final } = await runToEnd(completingTurn([]))

    expect(final.state).toBe('error')
    expect(final.error).toContain('git push 失败')
    expect(getRequirement(r.id)?.status).not.toBe('done')
  })

  // ---- Lint self-heal on a pre-commit-hook failure (RM-A13) ----

  it('self-heals a pre-commit lint failure by handing it to the dev agent once, then commits', async () => {
    const [r] = insertRequirements(proj, [{ title: 'lint-heal', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })
    // First commit blocked by the lint hook; after the agent fixes it, the retry succeeds.
    commitMock
      .mockResolvedValueOnce({
        ok: false,
        committed: false,
        error: 'eslint: no-unused-vars',
        failure: 'commit-hook',
      })
      .mockResolvedValueOnce({ ok: true, committed: true })

    const prompts: string[] = []
    const { final } = await runToEnd(completingTurn(prompts))

    expect(final.state).toBe('done')
    expect(getRequirement(r.id)?.status).toBe('done')
    expect(commitMock).toHaveBeenCalledTimes(2) // initial + single agent retry
    // Two dev turns: the original work turn, then the lint-fix agent turn carrying
    // the lint error summary in a targeted prompt.
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toMatch(/^lint-heal\n/)
    expect(prompts[1]).toContain('pre-commit')
    expect(prompts[1]).toContain('no-unused-vars')
  })

  it('stops (single agent attempt only) when the lint failure survives the agent fix; not marked done', async () => {
    const [r] = insertRequirements(proj, [{ title: 'stubborn', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })
    // Both commits are blocked by the lint hook — the agent could not clear it.
    commitMock.mockResolvedValue({
      ok: false,
      committed: false,
      error: 'eslint: 无法自动修复的报错',
      failure: 'commit-hook',
    })

    const prompts: string[] = []
    const { final } = await runToEnd(completingTurn(prompts))

    expect(final.state).toBe('error')
    expect(final.error).toContain('lint 自动修复失败')
    expect(getRequirement(r.id)?.status).not.toBe('done')
    expect(commitMock).toHaveBeenCalledTimes(2) // initial + ONE agent retry (no further tries)
    expect(prompts).toHaveLength(2) // work turn + exactly one agent fix turn
  })

  it('does NOT self-heal a non-lint commit failure (other) — surfaces it directly, no agent turn', async () => {
    const [r] = insertRequirements(proj, [{ title: 'other-fail', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })
    commitMock.mockResolvedValue({
      ok: false,
      committed: true,
      error: 'git push 失败: rejected',
      failure: 'other',
    })

    const prompts: string[] = []
    const { final } = await runToEnd(completingTurn(prompts))

    expect(final.state).toBe('error')
    expect(final.error).toContain('git push 失败')
    expect(commitMock).toHaveBeenCalledTimes(1) // no retry
    expect(prompts).toHaveLength(1) // only the work turn — no agent fix turn
  })

  it('stop() aborts and returns to idle', async () => {
    const [r] = insertRequirements(proj, [{ title: 'long', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })

    const emitted: AutomationStatus[] = []
    const final = await new Promise<AutomationStatus>((resolve) => {
      const hooks: AutomationHooks = {
        // Never settles on its own; resolves blocked only on abort.
        runDevTurn: (input) =>
          new Promise((res) => {
            input.signal.addEventListener('abort', () =>
              res({ outcome: 'blocked', sessionId: 's', lastMessage: '', detail: 'aborted' }),
            )
          }),
        broadcastRequirements: () => {},
        sessionExists: async () => false,
        isRunning: () => false,
        emitStatus: (s) => {
          emitted.push(s)
          if (s.state === 'running' && emitted.length === 2) stopAutomation(proj)
          if (s.state === 'idle') setTimeout(() => resolve(s), 0)
        },
      }
      startAutomation(proj, hooks, 1000)
    })

    expect(final.state).toBe('idle')
    expect(final.error).toBeNull()
  })
})
