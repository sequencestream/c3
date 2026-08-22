/**
 * A robot turn must ALWAYS answer, and must never wait on a human.
 *
 * These are the two properties the IM path depends on (ADR-0046): the person in
 * the chat sees exactly what this Promise resolves to, so every path — a
 * permission prompt, a wall-clock overrun, a failed launch — has to settle with
 * an outcome rather than hang.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'
import { launchRun } from '../kernel/run/run-lifecycle.js'
import { addViewer, ensureRuntime, stopRun, removeViewer } from '../runs.js'
import { makeRunRobotTurn, type RunRobotTurnInput } from './robot-turn.js'

vi.mock('../kernel/run/run-lifecycle.js', () => ({
  launchRun: vi.fn(() => Promise.resolve()),
}))
vi.mock('../kernel/config/index.js', () => ({
  getDefaultMode: vi.fn(() => 'default'),
}))
vi.mock('../runs.js', () => ({
  addViewer: vi.fn(),
  removeViewer: vi.fn(),
  stopRun: vi.fn(),
  ensureRuntime: vi.fn((sessionId: string) => ({ sessionId, buffer: [] })),
}))

/** The viewer the turn registered, so a test can drive wire events into it. */
function registeredViewer(): (e: ServerToClient) => void {
  const call = vi.mocked(addViewer).mock.calls.at(-1)
  if (!call) throw new Error('no viewer registered')
  return call[1] as (e: ServerToClient) => void
}

function input(overrides: Partial<RunRobotTurnInput> = {}): RunRobotTurnInput {
  return {
    robotId: 'rb-1',
    workspacePath: '/home/u/.c3/robots/helper',
    imAuth: {
      senderId: 'ou_1',
      chatType: 'p2p',
      chatId: 'oc_1',
      providerAccountKey: 'cli_app',
      platform: 'feishu',
      expectedBindingId: 'bind-1',
      turnStartScopeHash: 'hash-1',
    },
    prompt: 'what is the build status?',
    maxTurnMs: 300_000,
    signal: new AbortController().signal,
    ...overrides,
  }
}

const run = makeRunRobotTurn({ launchDeps: {} as never })

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.useRealTimers())

describe('runRobotTurn — settling', () => {
  it('resolves with the LAST assistant text, not a concatenation', async () => {
    const p = run(input())
    const viewer = registeredViewer()
    viewer({ type: 'assistant_text', text: 'thinking out loud' } as ServerToClient)
    viewer({ type: 'assistant_text', text: 'the final answer' } as ServerToClient)
    viewer({ type: 'turn_end', reason: 'complete' } as ServerToClient)

    await expect(p).resolves.toMatchObject({
      outcome: 'complete',
      lastMessage: 'the final answer',
    })
  })

  it('maps an errored turn_end to `error` and keeps its detail', async () => {
    const p = run(input())
    const viewer = registeredViewer()
    viewer({ type: 'turn_end', reason: 'error', error: 'vendor exploded' } as ServerToClient)

    await expect(p).resolves.toMatchObject({ outcome: 'error', detail: 'vendor exploded' })
  })

  it('runs as a background `robot` runtime', () => {
    void run(input())
    expect(ensureRuntime).toHaveBeenCalledWith(
      expect.any(String),
      '/home/u/.c3/robots/helper',
      expect.anything(),
      [],
      'robot',
      undefined,
      'background',
    )
  })

  it('resumes the thread session when one is already bound', () => {
    void run(input({ sessionId: 'sess-42' }))
    expect(ensureRuntime).toHaveBeenCalledWith(
      'sess-42',
      expect.any(String),
      expect.anything(),
      [],
      'robot',
      undefined,
      'background',
    )
  })
})

describe('runRobotTurn — never waits on a human', () => {
  it('settles `blocked` immediately on a permission_request instead of waiting', async () => {
    const p = run(input())
    const viewer = registeredViewer()
    viewer({
      type: 'permission_request',
      toolName: 'Bash',
      requestId: 'r1',
    } as unknown as ServerToClient)

    // No turn_end is ever delivered — the point is that we do not need one.
    await expect(p).resolves.toMatchObject({ outcome: 'blocked' })
    expect(stopRun).toHaveBeenCalled()
  })

  it('settles `timeout` when the wall clock expires', async () => {
    vi.useFakeTimers()
    const p = run(input({ maxTurnMs: 1000 }))
    vi.advanceTimersByTime(1001)

    await expect(p).resolves.toMatchObject({ outcome: 'timeout' })
    expect(stopRun).toHaveBeenCalled()
  })

  it('settles `blocked` when the caller aborts', async () => {
    const ac = new AbortController()
    const p = run(input({ signal: ac.signal }))
    ac.abort()

    await expect(p).resolves.toMatchObject({ outcome: 'blocked', detail: 'aborted' })
  })
})

describe('runRobotTurn — a failed launch still answers', () => {
  it('resolves `error` (never rejects) when the launch rejects', async () => {
    vi.mocked(launchRun).mockReturnValueOnce(Promise.reject(new Error('no vendor')))
    await expect(run(input())).resolves.toMatchObject({ outcome: 'error', detail: 'no vendor' })
  })

  it('resolves `error` when the launcher throws synchronously', async () => {
    vi.mocked(launchRun).mockImplementationOnce(() => {
      throw new Error('wiring missing')
    })
    await expect(run(input())).resolves.toMatchObject({
      outcome: 'error',
      detail: 'wiring missing',
    })
  })
})

describe('runRobotTurn — settles exactly once', () => {
  it('ignores events after the turn already settled', async () => {
    const p = run(input())
    const viewer = registeredViewer()
    viewer({ type: 'assistant_text', text: 'answer' } as ServerToClient)
    viewer({ type: 'turn_end', reason: 'complete' } as ServerToClient)
    // A late permission_request must not flip the resolved outcome or re-stop.
    viewer({ type: 'permission_request', toolName: 'Bash' } as unknown as ServerToClient)

    await expect(p).resolves.toMatchObject({ outcome: 'complete', lastMessage: 'answer' })
    expect(stopRun).not.toHaveBeenCalled()
    expect(removeViewer).toHaveBeenCalledTimes(1)
  })
})
