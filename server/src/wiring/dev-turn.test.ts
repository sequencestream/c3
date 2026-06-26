import { describe, expect, it, vi } from 'vitest'
import type { LaunchRunDeps } from '../kernel/run/run-lifecycle.js'
import { launchRun } from '../kernel/run/run-lifecycle.js'
import { makeRunDevTurn } from './dev-turn.js'

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
})
