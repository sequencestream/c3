/**
 * Tests for the completion judge. The judge's verdict is produced by a tool-less
 * one-shot Claude, so we can't assert the model's reasoning here; instead we pin
 * the two things the code itself owns: (1) the PROMPT encodes the tightened
 * resume-judgement rules (stuck-first, no bias-to-continue, AskUserQuestion ⇒
 * stuck) so the model is steered correctly, and (2) the parser either returns a
 * real verdict or reports the judge as UNAVAILABLE — an unreadable reply (a
 * provider error, an empty answer) is never coerced into `stuck`, which would
 * blame the intent for a tool-agent misconfiguration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Intent } from '@ccc/shared/protocol'

// Capture the args handed to the one-shot Claude (prompt + the launch overrides
// resolved from the tool agent) and control its reply.
interface AskArgs {
  prompt: string
  systemInstruction?: string
  model?: string
  envOverrides?: Record<string, string>
  relayCandidates?: Array<{ baseUrl: string; apiKey: string; model: string }>
}
const askMock = vi.fn<(args: AskArgs) => Promise<string>>()
vi.mock('../../kernel/agent/index.js', () => ({
  askOneShot: (a: AskArgs) => askMock(a),
}))
// The completion judge is a background tool session ⇒ it resolves its launch via
// `resolveToolSessionLaunch` (the tool agent), NOT `resolveSessionLaunch`. The mock
// pins a recognizable model + relay candidate so the routing can be asserted.
const toolLaunchMock = vi.fn(() => ({
  agentId: 'tool-agent',
  model: 'tool-model',
  envOverrides: { TOOL: '1' },
  relayCandidates: [{ baseUrl: 'https://third-party.example', apiKey: 'k', model: 'tool-model' }],
}))
vi.mock('../../kernel/agent-config/index.js', () => ({
  resolveToolSessionLaunch: () => toolLaunchMock(),
}))

const { JudgeUnavailableError, judgeCompletion } = await import('./judge.js')

const req: Intent = {
  id: 'r1',
  workspaceId: 'p',
  title: '示例需求',
  shortEnTitle: null,
  content: '做点事',
  priority: 'P0',
  module: '',
  status: 'in_progress',
  dependsOn: [],
  lastWorkSessionId: null,
  automate: true,
  branchName: null,
  latestCommitHash: null,
  prs: [],
  specPath: null,
  specStatus: 'raw',
  specMode: null,
  effectiveSpecMode: 'sdd',
  specApproved: false,
  specApproveUser: null,
  specSessionId: null,
  specReviewSessionId: null,
  specReviewVerdict: null,
  specReviewReason: null,
  specReviewAt: null,
  specReviewFingerprint: null,
  specReviewReworkRounds: 0,
  specReviewMachineApprovalBlocked: false,
  intentSessionId: null,
  createdAt: 1,
  updatedAt: 1,
  completedAt: 0,
  runStatus: 'idle',
  sessionActive: false,
  actionDescriptor: null,
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
    const prompt = askMock.mock.calls[0][0].systemInstruction ?? ''
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
    const prompt = askMock.mock.calls[0][0].systemInstruction ?? ''
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
    const prompt = askMock.mock.calls[0][0].systemInstruction ?? ''
    // The old "Bias: … return done" instruction is gone.
    expect(prompt).not.toMatch(/Bias:/)
    // in_progress is framed as a fallback, not a default-to-continue.
    expect(prompt).toMatch(/in_progress — FALLBACK only/)
  })

  it('frames change evidence as SUPPORTING, judged primarily from the agent report', async () => {
    askMock.mockResolvedValue('{"verdict":"done","reason":"ok"}')
    await judge('实现完成')
    const prompt = askMock.mock.calls[0][0].systemInstruction ?? ''
    // The intro and rules both demote evidence to corroboration, not a precondition.
    expect(prompt).toMatch(
      /PRIMARILY from what the agent reports|JUDGED PRIMARILY FROM THE AGENT REPORT/,
    )
    expect(prompt).toMatch(/SUPPORTING corroboration|not a precondition|not a hard gate/)
  })

  it('does NOT treat empty evidence as a stuck signal (the误卡 fix)', async () => {
    askMock.mockResolvedValue('{"verdict":"done","reason":"ok"}')
    await judge('实现完成')
    const prompt = askMock.mock.calls[0][0].systemInstruction ?? ''
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
    const prompt = askMock.mock.calls[0][0].systemInstruction ?? ''
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

describe('judge — runs on the tool agent (toolAgentId routing, 2026-06-15-001)', () => {
  it('resolves its launch via resolveToolSessionLaunch and passes that model/env to askOneShot', async () => {
    askMock.mockResolvedValue('{"verdict":"done","reason":"ok"}')
    await judge('done')
    expect(toolLaunchMock).toHaveBeenCalled()
    const args = askMock.mock.calls[0][0]
    expect(args.model).toBe('tool-model')
    expect(args.envOverrides).toEqual({ TOOL: '1' })
  })

  it('passes the relay candidates along with the model (a custom provider must not run on the first-party endpoint)', async () => {
    askMock.mockResolvedValue('{"verdict":"done","reason":"ok"}')
    await judge('done')
    const args = askMock.mock.calls[0][0]
    // model WITHOUT candidates = a third-party model name on the first-party
    // endpoint ⇒ "there's an issue with the selected model".
    expect(args.relayCandidates).toEqual([
      { baseUrl: 'https://third-party.example', apiKey: 'k', model: 'tool-model' },
    ])
  })
})

describe('judge parser — a verdict, or no verdict at all', () => {
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

  it('reports an unparseable reply as unavailable, NOT as a stuck verdict', async () => {
    askMock.mockResolvedValue('I think it is probably fine, continue.')
    await expect(judge('m')).rejects.toBeInstanceOf(JudgeUnavailableError)
  })

  it('reports a provider/model error message as unavailable (the misconfig must not read as stuck)', async () => {
    askMock.mockResolvedValue(
      "There's an issue with the selected model (deepseek-v4-flash). It may not exist or you may not have access to it.",
    )
    await expect(judge('m')).rejects.toMatchObject({
      name: 'JudgeUnavailableError',
      detail: expect.stringContaining('deepseek-v4-flash'),
    })
  })

  it('reports an empty reply as unavailable', async () => {
    askMock.mockResolvedValue('')
    await expect(judge('m')).rejects.toBeInstanceOf(JudgeUnavailableError)
  })

  it('reports an out-of-range verdict value as unavailable', async () => {
    askMock.mockResolvedValue('{"verdict":"maybe","reason":"unsure"}')
    await expect(judge('m')).rejects.toBeInstanceOf(JudgeUnavailableError)
  })

  it('wraps a one-shot that never ran (throwing askOneShot) as unavailable', async () => {
    askMock.mockRejectedValue(new Error('spawn claude ENOENT'))
    await expect(judge('m')).rejects.toMatchObject({
      name: 'JudgeUnavailableError',
      detail: expect.stringContaining('ENOENT'),
    })
  })
})
