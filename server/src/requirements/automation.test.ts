import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutomationStatus } from '@ccc/shared/protocol'
import { resetDbForTests } from './db.js'
import { getRequirement, insertRequirements, resetStoreForTests, setAutomate } from './store.js'

// Mock the heavy collaborators so the test exercises only the state machine.
const judgeMock = vi.fn()
const commitMock = vi.fn()
vi.mock('./judge.js', () => ({ judgeCompletion: (...a: unknown[]) => judgeMock(...a) }))
vi.mock('../git.js', () => ({
  gitDiffStat: async () => 'M file.ts | 1 +',
  gitRecentLog: async () => 'abc123 feat: prior work',
  commitAndPush: (...a: unknown[]) => commitMock(...a),
}))

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
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

/** Drive startAutomation and resolve once the orchestrator reaches a terminal state. */
function runToEnd(
  runDevTurn: AutomationHooks['runDevTurn'],
): Promise<{ final: AutomationStatus; emitted: AutomationStatus[] }> {
  const emitted: AutomationStatus[] = []
  return new Promise((resolve) => {
    const hooks: AutomationHooks = {
      runDevTurn,
      broadcastRequirements: () => {},
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
    // First prompt of each requirement is the /sdd-lite launch.
    expect(prompts[0]).toContain('/sdd-lite high')
    expect(prompts[1]).toContain('/sdd-lite low')
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

  it('continues with "继续" when the judge says in_progress, then completes', async () => {
    const [r] = insertRequirements(proj, [{ title: 'multi', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock
      .mockResolvedValueOnce({ verdict: 'in_progress', reason: '检查点' })
      .mockResolvedValueOnce({ verdict: 'done', reason: 'ok' })

    const prompts: string[] = []
    const { final } = await runToEnd(completingTurn(prompts))

    expect(final.state).toBe('done')
    expect(prompts[0]).toContain('/sdd-lite multi')
    expect(prompts[1]).toBe('继续') // resumed after the checkpoint
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

  it('stops with an error when a dev turn blocks on a permission', async () => {
    const [r] = insertRequirements(proj, [{ title: 'perm', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)

    const { final } = await runToEnd(async () => ({
      outcome: 'blocked',
      sessionId: 'sess-x',
      lastMessage: '',
      detail: 'Bash',
    }))

    expect(final.state).toBe('error')
    expect(final.error).toContain('授权')
    expect(getAutomationStatus(proj).state).toBe('error')
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
