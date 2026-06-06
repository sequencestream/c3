/**
 * OpenCode supervisor lifecycle (2026-06-06-003, risk #2). All host primitives are
 * injected — no real `opencode` CLI is spawned — so the gate logic, health-driven
 * auto-restart, the restart ceiling, attach mode, and stop-is-kill are proven in
 * isolation.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { OpencodeClient } from '@opencode-ai/sdk'
import { createOpencodeSupervisor, type SpawnedServer, type ServerSpawner } from './supervisor.js'

/** A fake client whose health (path.get) can be toggled. */
function fakeClient(healthy: { ok: boolean }): OpencodeClient {
  return {
    path: {
      get: async () => {
        if (!healthy.ok) throw new Error('server down')
        return { data: {}, response: { status: 200 } }
      },
    },
  } as unknown as OpencodeClient
}

describe('OpencodeSupervisor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('attach mode builds a client without spawning', async () => {
    const spawnServer = vi.fn<ServerSpawner>()
    const createClient = vi.fn(() => fakeClient({ ok: true }))
    const sup = createOpencodeSupervisor({
      externalUrl: 'http://localhost:9999',
      spawnServer,
      createClient,
    })
    await sup.start()

    expect(spawnServer).not.toHaveBeenCalled()
    expect(createClient).toHaveBeenCalledWith('http://localhost:9999')
    expect(sup.isExternal).toBe(true)
    expect(sup.url).toBe('http://localhost:9999')
  })

  it('managed mode picks a port, spawns, and connects', async () => {
    const killed: SpawnedServer[] = []
    const makeServer = (): SpawnedServer => ({
      url: 'http://127.0.0.1:40000',
      pid: 4242,
      kill: vi.fn(function (this: SpawnedServer) {
        killed.push(this)
      }),
      exited: new Promise(() => {}),
    })
    const pickPort = vi.fn(async () => 40000)
    const spawnServer = vi.fn<ServerSpawner>(async () => makeServer())
    const sup = createOpencodeSupervisor({
      binaryPath: '/fake/opencode',
      spawnServer,
      createClient: () => fakeClient({ ok: true }),
      pickPort,
    })
    await sup.start()

    expect(pickPort).toHaveBeenCalledOnce()
    expect(spawnServer).toHaveBeenCalledOnce()
    expect(spawnServer.mock.calls[0][0].port).toBe(40000)
    sup.stop()
  })

  it('auto-restarts on a failed health check, bounded by maxRestarts', async () => {
    const healthy = { ok: true }
    let spawnCount = 0
    const spawnServer = vi.fn<ServerSpawner>(async () => {
      spawnCount++
      return {
        url: `http://127.0.0.1:${40000 + spawnCount}`,
        pid: 1000 + spawnCount,
        kill: vi.fn(),
        exited: new Promise(() => {}),
      }
    })
    const sup = createOpencodeSupervisor({
      binaryPath: '/fake/opencode',
      healthIntervalMs: 1_000,
      maxRestarts: 2,
      spawnServer,
      createClient: () => fakeClient(healthy),
      pickPort: async () => 40000,
      sleep: async () => {}, // skip backoff delay
      backoff: () => 0,
    })
    await sup.start()
    expect(spawnCount).toBe(1)

    // Server dies → next health tick triggers a respawn.
    healthy.ok = false
    await vi.advanceTimersByTimeAsync(1_000)
    expect(spawnCount).toBe(2)
  })

  it('stop() tree-kills the managed server and is idempotent', async () => {
    const kill = vi.fn()
    const sup = createOpencodeSupervisor({
      binaryPath: '/fake/opencode',
      spawnServer: async () => ({
        url: 'http://127.0.0.1:40000',
        pid: 5,
        kill,
        exited: new Promise(() => {}),
      }),
      createClient: () => fakeClient({ ok: true }),
      pickPort: async () => 40000,
    })
    await sup.start()
    sup.stop()
    sup.stop()
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('throws when managed mode is requested but the host CLI is absent', () => {
    expect(() => createOpencodeSupervisor({ resolveBinary: () => null })).toThrow(/host CLI/)
  })
})
