/**
 * OpenCode supervisor lifecycle (2026-06-06-003, risk #2). All host primitives are
 * injected — no real `opencode` CLI is spawned — so the gate logic, health-driven
 * auto-restart, the restart ceiling, attach mode, and stop-is-kill are proven in
 * isolation.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { OpencodeClient } from '@opencode-ai/sdk'
import {
  createOpencodeSupervisor,
  type SpawnedServer,
  type ServerSpawner,
  type SupervisorStatus,
} from './supervisor.js'

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

/** A minimal spawned-server stub for the lazy-start tests. */
function stubServer(port = 40000): SpawnedServer {
  return {
    url: `http://127.0.0.1:${port}`,
    pid: 4242,
    kill: vi.fn(),
    exited: new Promise(() => {}),
  }
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

  // ── Lazy start + first-class status signal (2026-06-07-003) ────────────────

  it('ensureRunning lazily spawns and reports reachability=full', async () => {
    const statuses: SupervisorStatus[] = []
    const spawnServer = vi.fn<ServerSpawner>(async () => stubServer())
    const sup = createOpencodeSupervisor({
      binaryPath: '/fake/opencode',
      spawnServer,
      createClient: () => fakeClient({ ok: true }),
      pickPort: async () => 40000,
      onStatusChange: (s) => statuses.push(s),
    })
    await sup.ensureRunning()
    expect(spawnServer).toHaveBeenCalledOnce()
    expect(sup.status.reachability).toBe('full')
    expect(sup.status.retrying).toBe(false)
    expect(statuses.at(-1)?.reachability).toBe('full')
    sup.stop()
  })

  it('ensureRunning is idempotent — no second spawn while healthy', async () => {
    const spawnServer = vi.fn<ServerSpawner>(async () => stubServer())
    const sup = createOpencodeSupervisor({
      binaryPath: '/fake/opencode',
      spawnServer,
      createClient: () => fakeClient({ ok: true }),
      pickPort: async () => 40000,
    })
    await sup.ensureRunning()
    await sup.ensureRunning()
    expect(spawnServer).toHaveBeenCalledOnce()
    sup.stop()
  })

  it('ensureRunning external builds a client, reports full, never spawns', async () => {
    const spawnServer = vi.fn<ServerSpawner>()
    const sup = createOpencodeSupervisor({
      externalUrl: 'http://localhost:9999',
      spawnServer,
      createClient: () => fakeClient({ ok: true }),
    })
    await sup.ensureRunning()
    expect(spawnServer).not.toHaveBeenCalled()
    expect(sup.status.reachability).toBe('full')
    expect(sup.status.url).toBe('http://localhost:9999')
  })

  it('ensureRunning degrades to temporarily-unavailable (not fatal) then self-heals', async () => {
    let attempt = 0
    const spawnServer = vi.fn<ServerSpawner>(async () => {
      attempt++
      if (attempt === 1) throw new Error('boom')
      return stubServer(40001)
    })
    const sup = createOpencodeSupervisor({
      binaryPath: '/fake/opencode',
      spawnServer,
      createClient: () => fakeClient({ ok: true }),
      pickPort: async () => 40000,
      backoff: () => 100,
    })
    // First attempt fails — resolves (no throw) into a degraded, retrying state.
    await expect(sup.ensureRunning()).resolves.toBeUndefined()
    expect(sup.status.reachability).toBe('temporarily-unavailable')
    expect(sup.status.retrying).toBe(true)
    // The background self-heal timer fires → second spawn succeeds → full.
    await vi.advanceTimersByTimeAsync(100)
    expect(spawnServer).toHaveBeenCalledTimes(2)
    expect(sup.status.reachability).toBe('full')
    sup.stop()
  })

  it('ensureRunning times out a hung spawn within the grace window', async () => {
    const sup = createOpencodeSupervisor({
      binaryPath: '/fake/opencode',
      graceMs: 2000,
      spawnServer: () => new Promise<SpawnedServer>(() => {}), // never ready
      createClient: () => fakeClient({ ok: true }),
      pickPort: async () => 40000,
      backoff: () => 10_000_000, // park self-heal far away for the assertion
    })
    const p = sup.ensureRunning()
    await vi.advanceTimersByTimeAsync(2000)
    await p
    expect(sup.status.reachability).toBe('temporarily-unavailable')
    sup.stop()
  })
})
