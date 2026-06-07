/**
 * GOLDEN-STANDARD CONTRACT — C3: a plain session starts even when the store is down.
 *
 * Pins a behavior that MUST survive every slice of the server refactor (ADR-0009):
 * the intent / discussion / schedule SQLite store is a *soft* dependency.
 * When it is unavailable, c3 still boots and an ordinary (`normal`-kind) user
 * session launches and completes a turn — it never gates on the store and never
 * emits a `intent.*` / `*.dbUnavailable` error.
 *
 * The invariant under the handlers (which slices 2/3 will move into `features/`):
 * launchRun for a `normal` runtime NEVER consults `isStoreAvailable`. This test
 * spies on the store-availability probe and asserts it is untouched, while the
 * turn runs to a clean `turn_end`. A later slice may relocate the launcher; this
 * contract does not change.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'

const sdk = vi.hoisted(() => ({
  streams: [] as Array<Array<Record<string, unknown> | { throw: string }>>,
  calls: [] as Array<{ resume?: string }>,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (arg: { options?: { resume?: string } }) => {
    sdk.calls.push({ resume: arg.options?.resume })
    const steps = sdk.streams.shift() ?? []
    return {
      async *[Symbol.asyncIterator]() {
        for (const s of steps) {
          if ('throw' in s) throw new Error(String(s.throw))
          yield s
        }
      },
      interrupt: () => Promise.resolve(),
      setPermissionMode: () => Promise.resolve(),
    }
  },
}))

// Server refactor 3/3 sank the settings lookups into kernel/{agent-config,config};
// the stubbed seam is the same public contract, just at its new home.
vi.mock('../../src/kernel/agent-config/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/kernel/agent-config/index.js')>(
    '../../src/kernel/agent-config/index.js',
  )
  return {
    ...actual,
    getDegradationChain: () => undefined,
    resolveSessionLaunch: () => ({ agentId: 'agent-a' }),
    resolveAgent: (id: string | null) => ({
      id: id ?? 'agent-a',
      name: `Name(${id ?? 'agent-a'})`,
      baseUrl: '',
      apiKey: '',
      model: '',
    }),
    launchForAgent: () => ({}),
  }
})
vi.mock('../../src/kernel/config/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/kernel/config/index.js')>(
    '../../src/kernel/config/index.js',
  )
  return {
    ...actual,
    getSocketAutoResume: () => true,
  }
})

// Force the intent store to report "unavailable" — the failed-DB world.
import * as reqStore from '../../src/features/intents/store.js'
import { launchRun } from '../../src/kernel/run/run-lifecycle.js'
import { ensureRuntime, getRuntime, addViewer, removeRuntime, type Viewer } from '../../src/runs.js'

beforeEach(() => {
  sdk.streams = []
  sdk.calls = []
})

const noopDeps = { broadcastStatuses: () => {}, broadcastIntents: () => {} }

describe('C3 — a plain session starts when the store is unavailable', () => {
  it('launches and completes a normal turn without consulting the store or erroring', async () => {
    const storeProbe = vi.spyOn(reqStore, 'isStoreAvailable').mockReturnValue(false)
    sdk.streams.push([{ type: 'result', session_id: 'real-c3' }])

    const id = 'c3-plain'
    const rt = ensureRuntime(id, '/ws', 'default', [], 'normal')
    const events: ServerToClient[] = []
    const viewer: Viewer = (e) => events.push(e)
    addViewer(id, viewer)

    await launchRun(rt, 'hello', noopDeps)

    // The normal-session launch never gated on the store.
    expect(storeProbe).not.toHaveBeenCalled()
    // No intent / db-unavailable error surfaced.
    expect(
      events.some(
        (e) =>
          e.type === 'error' &&
          (e.error.code.startsWith('intent.') || e.error.code.endsWith('dbUnavailable')),
      ),
    ).toBe(false)
    // The turn ran to a clean completion regardless of the store being down.
    expect(events.find((e) => e.type === 'turn_end')).toMatchObject({ reason: 'complete' })
    expect(getRuntime(id)!.status).toBe('idle')

    storeProbe.mockRestore()
    removeRuntime(id)
  })

  it('isStoreAvailable() being false does not throw for a plain launch', async () => {
    const storeProbe = vi.spyOn(reqStore, 'isStoreAvailable').mockReturnValue(false)
    sdk.streams.push([{ type: 'result', session_id: 'real-c3b' }])

    const id = 'c3-plain-2'
    const rt = ensureRuntime(id, '/ws', 'plan', [], 'normal')
    addViewer(id, () => {})

    await expect(launchRun(rt, 'hi', noopDeps)).resolves.toBeUndefined()

    storeProbe.mockRestore()
    removeRuntime(id)
  })
})
