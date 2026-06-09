import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AutomationStatus } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  getIntent,
  insertIntents,
  resetStoreForTests,
  setAutomate,
  updateStatus,
} from './store.js'

// ── Mocks ──────────────────────────────────────────────────────────────────
const judgeMock = vi.fn()
const commitMock = vi.fn()
vi.mock('./judge.js', () => ({ judgeCompletion: (...a: unknown[]) => judgeMock(...a) }))
vi.mock('../../git.js', () => ({
  gitDiffStat: async () => 'M file.ts | 1 +',
  gitRecentLog: async () => 'abc123 feat: prior work',
  commitAndPush: (...a: unknown[]) => commitMock(...a),
}))
const devSkillMock = vi.fn(() => '')
vi.mock('../../kernel/config/index.js', () => ({
  getDevSkill: (_projectPath?: string) => devSkillMock(),
  getDefaultMode: () => 'default' as const,
}))
vi.mock('../../runs.js', () => ({
  ensureRuntime: vi.fn(),
  getRuntime: vi.fn(() => undefined),
}))

// ── SUT (imported after mocks) ──────────────────────────────────────────────
const { startAutomation, getAutomationStatus, notifyTurnSettled } =
  await import('./automation.js')
import type { AutomationHooks } from './automation.js'

// ── Helpers ─────────────────────────────────────────────────────────────────
let dir: string
const proj = '/abs/auto-proj'

/** Settle the current intent-turn and await async processing. */
async function settleCur(sessionId: string): Promise<void> {
  const s = getAutomationStatus(proj)
  const id = s.currentIntentId
  if (!id) throw new Error('no current intent')
  await notifyTurnSettled(proj, sessionId, 'complete', id)
  // Flush chained microtasks (commitAndPush, _startNext, _launchDevelopment…)
  await new Promise((r) => setTimeout(r, 0))
}

/** A runDevTurn that tracks prompts. */
function trackingTurn(prompts: string[]): AutomationHooks['runDevTurn'] {
  let n = 0
  return async (input) => {
    prompts.push(input.prompt)
    return { outcome: 'complete', sessionId: `sess-${n++}`, lastMessage: 'done' }
  }
}

function hooks(runDevTurn: AutomationHooks['runDevTurn']): AutomationHooks {
  return {
    runDevTurn,
    broadcastIntents: () => {},
    sessionExists: async () => false,
    isRunning: () => false,
    emitStatus: () => {},
  }
}

function start(rt: AutomationHooks['runDevTurn']): void {
  startAutomation(proj, hooks(rt), 1000)
}

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

// ── Tests ───────────────────────────────────────────────────────────────────

describe('automation orchestrator', () => {
  it('develops P0→P1, commits each', async () => {
    const [p1, p0] = insertIntents(proj, [
      { title: 'low', content: 'c', priority: 'P1' },
      { title: 'high', content: 'c', priority: 'P0' },
    ])
    setAutomate(p1.id, true)
    setAutomate(p0.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })
    const prompts: string[] = []
    start(trackingTurn(prompts))
    await settleCur('s-0')
    await settleCur('s-1')
    const final = getAutomationStatus(proj)
    expect(final.state).toBe('done')
    expect(final.completedIds).toEqual([p0.id, p1.id])
    expect(getIntent(p0.id)?.status).toBe('done')
    expect(getIntent(p1.id)?.status).toBe('done')
    expect(commitMock).toHaveBeenCalledTimes(2)
    expect(prompts[0]).toMatch(/^high/)
    expect(prompts[1]).toMatch(/^low/)
  })

  it('uses dev skill prefix', async () => {
    devSkillMock.mockReturnValue('/my-skill')
    const [r] = insertIntents(proj, [{ title: 'custom', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })
    const prompts: string[] = []
    start(trackingTurn(prompts))
    await settleCur('s-0')
    expect(prompts[0]).toMatch(/^\/my-skill custom/)
  })

  it('omits skill prefix when none configured', async () => {
    const [r] = insertIntents(proj, [{ title: 'plain', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })
    const prompts: string[] = []
    start(trackingTurn(prompts))
    await settleCur('s-0')
    expect(prompts[0]).toMatch(/^plain/)
  })

  it('respects intra-batch dependency order', async () => {
    const [a, b] = insertIntents(proj, [
      { title: 'depends', content: 'c', priority: 'P0', dependsOnIndexes: [1] },
      { title: 'prereq', content: 'c', priority: 'P0' },
    ])
    expect(a.dependsOn).toEqual([b.id])
    setAutomate(a.id, true)
    setAutomate(b.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })
    const prompts: string[] = []
    start(trackingTurn(prompts))
    await settleCur('s-0')
    await settleCur('s-1')
    const final = getAutomationStatus(proj)
    expect(final.completedIds).toEqual([b.id, a.id])
    expect(prompts[0]).toMatch(/^prereq/)
    expect(prompts[1]).toMatch(/^depends/)
  })

  it('continues when judge says in_progress, then completes', async () => {
    const [r] = insertIntents(proj, [{ title: 'multi', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock
      .mockResolvedValueOnce({ verdict: 'in_progress', reason: '检查点' })
      .mockResolvedValueOnce({ verdict: 'done', reason: 'ok' })
    const prompts: string[] = []
    start(trackingTurn(prompts))
    await settleCur('s-0')
    expect(prompts[0]).toMatch(/^multi/)
    await settleCur('s-1')
    expect(prompts[1]).toBe('continue')
    const final = getAutomationStatus(proj)
    expect(final.state).toBe('done')
  })

  it('stops when judge says stuck', async () => {
    const [r] = insertIntents(proj, [{ title: 'bad', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'stuck', reason: '反复失败' })
    start(trackingTurn([]))
    await settleCur('s-0')
    const final = getAutomationStatus(proj)
    expect(final.state).toBe('error')
    expect(final.error).toContain('反复失败')
    expect(commitMock).not.toHaveBeenCalled()
  })

  it('stops when commit fails', async () => {
    const [r] = insertIntents(proj, [{ title: 'push', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })
    commitMock.mockResolvedValue({ ok: false, committed: true, error: 'git push 失败: rejected' })
    start(trackingTurn([]))
    await settleCur('s-0')
    const final = getAutomationStatus(proj)
    expect(final.state).toBe('error')
    expect(final.error).toContain('git push 失败')
    expect(getIntent(r.id)?.status).not.toBe('done')
  })

  it('surfaces awaitingPermission then clears on settle', async () => {
    const [r] = insertIntents(proj, [{ title: 'perm', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })
    const emitted: AutomationStatus[] = []
    const rt: AutomationHooks['runDevTurn'] = async (input) => {
      input.onAwaitingPermission?.(true)
      return { outcome: 'complete', sessionId: 's-x', lastMessage: 'done' }
    }
    const h = hooks(rt)
    h.emitStatus = (s) => {
      emitted.push(s)
    }
    startAutomation(proj, h, 1000)
    await settleCur('s-x')
    expect(emitted.some((s) => s.awaitingPermission)).toBe(true)
    const final = getAutomationStatus(proj)
    expect(final.state).toBe('done')
    expect(final.awaitingPermission).toBe(false)
    expect(getIntent(r.id)?.status).toBe('done')
  })

  it('skips non-automated intents', async () => {
    const [on] = insertIntents(proj, [{ title: 'on', content: 'c', priority: 'P0' }])
    insertIntents(proj, [{ title: 'off', content: 'c', priority: 'P0' }])
    setAutomate(on.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })
    start(trackingTurn([]))
    await settleCur('s-0')
    const final = getAutomationStatus(proj)
    expect(final.completedIds).toEqual([on.id])
  })

  it('skips when dep is unfinished', async () => {
    const [dep] = insertIntents(proj, [{ title: 'dep', content: 'c', priority: 'P1' }])
    const [main] = insertIntents(proj, [
      { title: 'main', content: 'c', priority: 'P0', dependsOn: [dep.id] },
    ])
    setAutomate(main.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })
    start(trackingTurn([]))
    await new Promise((r) => setTimeout(r, 0))
    const final = getAutomationStatus(proj)
    expect(final.state).toBe('done')
    expect(final.completedIds).toEqual([])
  })

  it('skips in_progress with no lastDevSessionId', async () => {
    // An in_progress intent with no linked dev session (dangling) is skipped
    // if it's not automated. Automated in_progress + no lastDevSessionId
    // is a fresh start.
    insertIntents(proj, [{ title: 'dangling', content: 'c', priority: 'P0' }])
    const [auto] = insertIntents(proj, [{ title: 'auto', content: 'c', priority: 'P0' }])
    setAutomate(auto.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })
    start(trackingTurn([]))
    await settleCur('s-0')
    const final = getAutomationStatus(proj)
    expect(final.completedIds).toEqual([auto.id])
  })

  it('includes dependency note in prompt', async () => {
    const [dep] = insertIntents(proj, [{ title: 'dep', content: 'dep-c', priority: 'P0' }])
    const [r] = insertIntents(proj, [
      { title: 'with-dep', content: 'c', priority: 'P0', dependsOn: [dep.id] },
    ])
    setAutomate(r.id, true)
    updateStatus(dep.id, 'done')
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })
    const prompts: string[] = []
    start(trackingTurn(prompts))
    await settleCur('s-0')
    expect(prompts[0]).toContain('依赖需求:' + dep.id)
  })

  // ── Self-heal (lint hook) ────────────────────────────────────────────
  it('self-heals lint failure with one fix agent turn', async () => {
    const [r] = insertIntents(proj, [{ title: 'lint-heal', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })
    commitMock
      .mockResolvedValueOnce({
        ok: false,
        committed: false,
        error: 'eslint: no-unused-vars',
        failure: 'commit-hook',
      })
      .mockResolvedValueOnce({ ok: true, committed: true })
    const prompts: string[] = []
    start(trackingTurn(prompts))
    // First settle → commit fails with lint hook → controller enters 'fixing'
    await settleCur('s-0')
    expect(getAutomationStatus(proj).state).toBe('fixing')
    expect(commitMock).toHaveBeenCalledTimes(1)
    // Fix turn settles → retry commit → succeeds
    await settleCur('s-0')
    const final = getAutomationStatus(proj)
    expect(final.state).toBe('done')
    expect(commitMock).toHaveBeenCalledTimes(2)
    expect(prompts[1]).toContain('pre-commit')
    expect(prompts[1]).toContain('no-unused-vars')
  })

  it('stops when lint heal retry still fails', async () => {
    const [r] = insertIntents(proj, [{ title: 'lint-fail', content: 'c', priority: 'P0' }])
    setAutomate(r.id, true)
    judgeMock.mockResolvedValue({ verdict: 'done', reason: 'ok' })
    commitMock
      .mockResolvedValueOnce({
        ok: false,
        committed: false,
        error: 'eslint: semi',
        failure: 'commit-hook',
      })
      .mockResolvedValueOnce({ ok: false, committed: false, error: 'eslint: semi (retry)' })
    start(trackingTurn([]))
    await settleCur('s-0')
    expect(getAutomationStatus(proj).state).toBe('fixing')
    await settleCur('s-0')
    const final = getAutomationStatus(proj)
    expect(final.state).toBe('error')
    expect(final.error).toContain('lint')
  })
})
