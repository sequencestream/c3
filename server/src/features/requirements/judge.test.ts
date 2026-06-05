/**
 * Tests for the completion judge. The judge's verdict is produced by a tool-less
 * one-shot Claude, so we can't assert the model's reasoning here; instead we pin
 * the two things the code itself owns: (1) the PROMPT encodes the tightened
 * resume-judgement rules (stuck-first, no bias-to-continue, AskUserQuestion ⇒
 * stuck) so the model is steered correctly, and (2) the parser coerces the reply
 * into a safe verdict, defaulting to `stuck` (never silently `in_progress`) when
 * it can't be read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Requirement } from '@ccc/shared/protocol'

// Capture the prompt handed to the one-shot Claude and control its reply.
const askMock = vi.fn<(args: { prompt: string }) => Promise<string>>()
vi.mock('../../kernel/agent/index.js', () => ({
  askOneShot: (a: { prompt: string }) => askMock(a),
}))
vi.mock('../../settings.js', () => ({
  resolveSessionLaunch: () => ({ model: 'test-model', envOverrides: {} }),
}))

const { judgeCompletion } = await import('./judge.js')

const req: Requirement = {
  id: 'r1',
  projectPath: '/p',
  title: '示例需求',
  content: '做点事',
  priority: 'P0',
  module: '',
  status: 'in_progress',
  dependsOn: [],
  lastDevSessionId: null,
  automate: true,
  createdAt: 1,
  updatedAt: 1,
  completedAt: 0,
  runStatus: 'idle',
}

function judge(lastMessage: string) {
  return judgeCompletion({
    req,
    lastMessages: [lastMessage],
    evidence: { diffStat: '', recentLog: '' },
    cwd: '/p',
    signal: new AbortController().signal,
  })
}

beforeEach(() => askMock.mockReset())
afterEach(() => vi.restoreAllMocks())

describe('judge prompt — tightened resume-judgement rules', () => {
  it('orders the verdicts stuck → done → in_progress (stuck decided first)', async () => {
    askMock.mockResolvedValue('{"verdict":"done","reason":"ok"}')
    await judge('done')
    const prompt = askMock.mock.calls[0][0].prompt
    expect(prompt).toMatch(/stuck\s*→\s*done\s*→\s*in_progress/)
    // stuck is introduced before done, which is introduced before in_progress.
    const iStuck = prompt.indexOf('- **stuck')
    const iDone = prompt.indexOf('- **done')
    const iProg = prompt.indexOf('- **in_progress')
    expect(iStuck).toBeGreaterThan(-1)
    expect(iStuck).toBeLessThan(iDone)
    expect(iDone).toBeLessThan(iProg)
  })

  it('routes AskUserQuestion / human-decision points to stuck, not in_progress', async () => {
    askMock.mockResolvedValue('{"verdict":"stuck","reason":"asked"}')
    await judge('用方案A还是B?')
    const prompt = askMock.mock.calls[0][0].prompt
    expect(prompt).toContain('AskUserQuestion')
    // The stuck rule, not the in_progress rule, owns the human-decision wording.
    const stuckBlock = prompt.slice(prompt.indexOf('- **stuck'), prompt.indexOf('- **done'))
    expect(stuckBlock).toContain('AskUserQuestion')
    expect(stuckBlock).toMatch(/permission|authorization/)
    expect(stuckBlock).toMatch(/context|information/)
  })

  it('no longer biases toward done/continue', async () => {
    askMock.mockResolvedValue('{"verdict":"in_progress","reason":"x"}')
    await judge('still going')
    const prompt = askMock.mock.calls[0][0].prompt
    // The old "Bias: … return done" instruction is gone.
    expect(prompt).not.toMatch(/Bias:/)
    // in_progress is framed as a fallback, not a default-to-continue.
    expect(prompt).toMatch(/in_progress — FALLBACK only/)
  })

  it('frames change evidence as SUPPORTING, judged primarily from the agent report', async () => {
    askMock.mockResolvedValue('{"verdict":"done","reason":"ok"}')
    await judge('实现完成')
    const prompt = askMock.mock.calls[0][0].prompt
    // The intro and rules both demote evidence to corroboration, not a precondition.
    expect(prompt).toMatch(
      /PRIMARILY from what the agent reports|JUDGED PRIMARILY FROM THE AGENT REPORT/,
    )
    expect(prompt).toMatch(/SUPPORTING corroboration|not a precondition|not a hard gate/)
  })

  it('does NOT treat empty evidence as a stuck signal (the误卡 fix)', async () => {
    askMock.mockResolvedValue('{"verdict":"done","reason":"ok"}')
    await judge('实现完成')
    const prompt = askMock.mock.calls[0][0].prompt
    // The old "claims completion but there is no consistent code-change evidence ⇒ stuck" is gone.
    expect(prompt).not.toMatch(/no consistent code-change evidence at all/)
    // Empty evidence is explicitly NOT a stuck signal; a concrete report with no diff is done.
    expect(prompt).toMatch(
      /Empty evidence alone is NOT a stuck signal|NEVER judge incomplete merely because the evidence is empty/,
    )
    // The done rule says a concrete report is enough even with empty evidence.
    const doneBlock = prompt.slice(prompt.indexOf('- **done'), prompt.indexOf('- **in_progress'))
    expect(doneBlock).toMatch(/even when the change evidence is empty|enough for `done`/)
  })

  it('still routes a claimed-done-but-spinning/untrustworthy report (no evidence) to stuck', async () => {
    askMock.mockResolvedValue('{"verdict":"stuck","reason":"spinning"}')
    await judge('搞定了(无具体说明)')
    const prompt = askMock.mock.calls[0][0].prompt
    const stuckBlock = prompt.slice(prompt.indexOf('- **stuck'), prompt.indexOf('- **done'))
    // The narrow残留 stuck case: untrustworthy/self-contradictory/spinning report AND no evidence.
    expect(stuckBlock).toMatch(/untrustworthy|self-contradictory|spinning/)
  })
})

describe('judge — evidence is not a hard gate on the verdict', () => {
  it('returns done on a credible report even when both evidence sources are empty', async () => {
    // Evidence: { diffStat: '', recentLog: '' } (see judge()). The code must NOT
    // override a model `done` to stuck just because evidence is empty.
    askMock.mockResolvedValue('{"verdict":"done","reason":"需求已实现并自测"}')
    expect((await judge('已实现并自测,需求达成')).verdict).toBe('done')
  })

  it('still surfaces a human-intervention stuck verdict with empty evidence', async () => {
    askMock.mockResolvedValue('{"verdict":"stuck","reason":"asked the user"}')
    expect((await judge('用方案A还是B?')).verdict).toBe('stuck')
  })
})

describe('judge parser — safe coercion', () => {
  it('parses a clean verdict object', async () => {
    askMock.mockResolvedValue('{"verdict":"done","reason":"实现完成"}')
    expect(await judge('m')).toEqual({ verdict: 'done', reason: '实现完成' })
  })

  it('extracts the verdict from surrounding prose', async () => {
    askMock.mockResolvedValue(
      'Here is my call: {"verdict":"in_progress","reason":"checkpoint"} done.',
    )
    expect(await judge('m')).toEqual({ verdict: 'in_progress', reason: 'checkpoint' })
  })

  it('defaults to stuck (never in_progress) on an unparseable reply', async () => {
    askMock.mockResolvedValue('I think it is probably fine, continue.')
    const v = await judge('m')
    expect(v.verdict).toBe('stuck')
    expect(v.reason).toContain('无法解析')
  })

  it('defaults to stuck on an empty reply', async () => {
    askMock.mockResolvedValue('')
    expect((await judge('m')).verdict).toBe('stuck')
  })

  it('defaults to stuck when the verdict value is not one of the three', async () => {
    askMock.mockResolvedValue('{"verdict":"maybe","reason":"unsure"}')
    expect((await judge('m')).verdict).toBe('stuck')
  })
})
