import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LaunchRunDeps } from '../kernel/run/run-lifecycle.js'
import { launchRun } from '../kernel/run/run-lifecycle.js'
import { makeRunDevTurn } from './dev-turn.js'
import { ensureRuntime } from '../runs.js'

vi.mock('../kernel/run/run-lifecycle.js', () => ({
  launchRun: vi.fn(),
}))

vi.mock('../kernel/config/index.js', () => ({
  getDefaultMode: vi.fn(() => ({ vendor: 'codex', policy: 'never' })),
}))

vi.mock('../runs.js', () => ({
  addViewer: vi.fn(),
  emit: vi.fn(),
  ensureRuntime: vi.fn((sessionId: string) => ({
    sessionId,
    buffer: [],
  })),
  isRunning: vi.fn(() => true),
  removeViewer: vi.fn(),
  setStatus: vi.fn(),
  stopRun: vi.fn(),
}))

describe('makeRunDevTurn prompt channels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('forwards systemInstruction and userTurnPrefix to launchRun without changing visible prompt', () => {
    const runDevTurn = makeRunDevTurn({ launchDeps: {} as LaunchRunDeps })
    const signal = new AbortController().signal

    void runDevTurn({
      workspacePath: '/workspace',
      sessionId: 'pending:dev',
      prompt: 'Visible prompt',
      systemInstruction: 'Internal SDD contract',
      userTurnPrefix: '/dev ',
      intentId: 'intent-1',
      signal,
    })

    expect(launchRun).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pending:dev' }),
      'Visible prompt',
      {},
      undefined,
      {
        systemInstruction: 'Internal SDD contract',
        userTurnPrefix: '/dev ',
      },
    )
  })

  it('pushes the visible user turn alone into a live team lead — never the system instruction or slash command', () => {
    // The team lead's process already has the system instruction set once (at launch),
    // so a push must carry the user turn alone — re-prepending it would inflate the
    // user-turn prefix and break the stable cache.
    const pushInput = vi.fn()
    vi.mocked(ensureRuntime).mockReturnValueOnce({
      sessionId: 'team-lead',
      buffer: [],
      team: true,
      run: { handle: { pushInput } },
    } as unknown as ReturnType<typeof ensureRuntime>)

    const runDevTurn = makeRunDevTurn({ launchDeps: {} as LaunchRunDeps })
    void runDevTurn({
      workspacePath: '/workspace',
      sessionId: 'team-lead',
      prompt: 'Visible prompt',
      systemInstruction: 'Internal SDD contract',
      userTurnPrefix: '/dev ',
      intentId: 'intent-1',
      signal: new AbortController().signal,
    })

    expect(pushInput).toHaveBeenCalledTimes(1)
    expect(pushInput).toHaveBeenCalledWith('Visible prompt')
    expect(launchRun).not.toHaveBeenCalled()
  })
})
