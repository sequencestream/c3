/**
 * OpenCode server lifecycle supervisor (2026-06-06-003, risk #2). Unlike Claude
 * (one CLI subprocess per run) OpenCode is a **long-lived local server** every run
 * talks to over REST/SSE. The SDK's own `createOpencode` spawns that server but
 * then walks away — its `close()` is a bare `SIGTERM` on POSIX (no process-group
 * tree-kill), it never health-checks, and it never restarts (009 conclusion). So
 * the server's whole lifecycle is c3's responsibility, and this is where c3 owns it:
 *
 *  - **Port** — c3 picks a free port (`bind 0` probe → close → pass the explicit
 *    number to `opencode serve --port`), avoiding the SDK `:0` quirk where the
 *    first instance grabs the default 4096 (009).
 *  - **Orphan protection** — c3 spawns the server itself in its own process group
 *    (POSIX `detached`) so cleanup can `kill(-pgid)` the whole tree, not just the
 *    parent (the SDK's `proc.kill()` leaks grandchildren). `process.on(exit|SIGINT|
 *    SIGTERM)` guarantees the kill runs on c3 shutdown.
 *  - **Health + auto-restart** — a poll of `client.path.get()`; a throw means the
 *    server died, so c3 respawns it with bounded backoff and swaps in a fresh
 *    client. Past the restart ceiling the vendor is marked unavailable (loud, not
 *    a silent hang).
 *  - **Escape hatch** — `--opencode-url` (`externalUrl`) attaches to an operator-run
 *    instance: client only, NO spawn / health / restart / kill (someone else owns it).
 *
 * ADR-0009: this file may import `@opencode-ai/sdk` (it lives under
 * `adapters/opencode/`); no SDK type escapes upward — the supervisor hands out an
 * `OpencodeClient` only to the sibling opencode adapter pieces, never to the kernel.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'
import type { CapabilityState } from '@ccc/shared/protocol'
import { resolve as resolveHostBinary } from '../../process/launcher.js'

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * The supervisor's live reachability snapshot (2026-06-07-003). `reachability`
 * reuses the wire {@link CapabilityState} so the degraded state is expressed by the
 * SAME enum as the session-lifecycle ledger: `'full'` (up) / `'temporarily-unavailable'`
 * (down / starting / retrying). The supervisor never reports `'none'` — that grade
 * means "opencode not registered at all", a composition-root concern.
 */
export interface SupervisorStatus {
  reachability: CapabilityState
  retrying: boolean
  url?: string
}

/** A spawned OpenCode server process c3 owns end-to-end. */
export interface SpawnedServer {
  /** The base URL the server is listening on (scraped from its stdout banner). */
  readonly url: string
  readonly pid: number | undefined
  /** Tree-kill the whole process group (POSIX) / process tree (win32). Idempotent. */
  kill(signal?: NodeJS.Signals): void
  /** Resolves with the exit code once the process exits. */
  readonly exited: Promise<number | null>
}

/** Spawns one OpenCode server. Injectable so the supervisor is testable without a CLI. */
export type ServerSpawner = (opts: {
  binaryPath: string
  hostname: string
  port: number
  env?: Record<string, string>
  readyTimeoutMs: number
}) => Promise<SpawnedServer>

/** Tree-kill a child: POSIX kills the whole process group (negative pid); win32 uses taskkill /T. */
function treeKill(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (proc.pid == null) return
  if (process.platform === 'win32') {
    // /T = whole tree, /F = force. Best-effort; swallow spawn errors.
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']).on('error', () => {})
    } catch {
      /* noop */
    }
    return
  }
  // Negative pid targets the process GROUP (requires `detached: true` at spawn),
  // so grandchildren the server forked die too — the gap the SDK's bare kill leaves.
  try {
    process.kill(-proc.pid, signal)
  } catch {
    try {
      proc.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

/**
 * The real spawner: mirrors the SDK's `opencode serve --hostname=… --port=…`
 * invocation (009: `OPENCODE_CONFIG_CONTENT` carries config), scrapes the
 * `opencode server listening on <url>` banner for readiness, but spawns in its own
 * process group so c3 can tree-kill it.
 */
export const defaultSpawnServer: ServerSpawner = async (opts) => {
  const isPosix = process.platform !== 'win32'
  const proc = spawn(
    opts.binaryPath,
    ['serve', `--hostname=${opts.hostname}`, `--port=${opts.port}`],
    {
      detached: isPosix, // own process group ⇒ tree-kill on cleanup
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let exitResolve: (code: number | null) => void = () => {}
  const exited = new Promise<number | null>((r) => {
    exitResolve = r
  })
  proc.on('exit', (code) => exitResolve(code))

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      treeKill(proc, 'SIGKILL')
      reject(new Error(`opencode serve not ready within ${opts.readyTimeoutMs}ms`))
    }, opts.readyTimeoutMs)
    let out = ''
    const scan = (chunk: Buffer): void => {
      out += chunk.toString()
      for (const line of out.split('\n')) {
        if (line.startsWith('opencode server listening')) {
          const m = line.match(/on\s+(https?:\/\/[^\s]+)/)
          if (m) {
            clearTimeout(timer)
            resolve(m[1])
            return
          }
        }
      }
    }
    proc.stdout?.on('data', scan)
    proc.stderr?.on('data', (c: Buffer) => {
      out += c.toString()
    })
    proc.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`opencode exited before ready (code ${code}): ${out.trim()}`))
    })
  })

  return { url, pid: proc.pid, kill: (s = 'SIGTERM') => treeKill(proc, s), exited }
}

/** Pick a free TCP port by binding `:0` and reading back the OS-assigned number. */
export function pickFreePort(hostname = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, hostname, () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('failed to pick a free port'))))
    })
  })
}

/** Reject `p` if it does not settle within `ms` — the outer grace bound for a lazy start. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`opencode not ready within ${ms}ms`)), ms)
    timer.unref?.()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

/** Fully-resolved supervisor knobs (all defaults applied by {@link createOpencodeSupervisor}). */
interface ResolvedOpts {
  externalUrl?: string
  hostname: string
  healthIntervalMs: number
  maxRestarts: number
  readyTimeoutMs: number
  /** Outer grace window for a lazy {@link OpencodeSupervisor.ensureRunning} (re)start (clamped 2–10s). */
  graceMs: number
  env?: Record<string, string>
  binaryPath: string | null
  spawnServer: ServerSpawner
  createClient: (baseUrl: string) => OpencodeClient
  pickPort: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  backoff: (attempt: number) => number
  onUnavailable?: (reason: string) => void
  /** Pushed on every reachability transition (and from `ensureRunning`), so the wire can broadcast it. */
  onStatusChange?: (status: SupervisorStatus) => void
}

/**
 * The managed (or attached) OpenCode server. Construct via
 * {@link createOpencodeSupervisor}, `await start()`, then hand `client()` to the
 * adapter pieces. `stop()` (also run on process exit) tree-kills a managed server.
 */
export class OpencodeSupervisor {
  private currentServer: SpawnedServer | null = null
  private currentClient: OpencodeClient | null = null
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private restarts = 0
  private stopped = false
  private cleanupRegistered = false
  private unavailableReason: string | null = null
  /** Live reachability — starts `temporarily-unavailable` until the first successful connect. */
  private reachability: CapabilityState = 'temporarily-unavailable'
  private retrying = false
  /** In-flight lazy (re)start, shared so concurrent `ensureRunning` callers dedupe onto one attempt. */
  private starting: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0

  constructor(private readonly opts: ResolvedOpts) {}

  /** Attach mode? (no spawn/health/restart/kill — an operator owns the server.) */
  get isExternal(): boolean {
    return !!this.opts.externalUrl
  }

  /** The base URL in use (external url, or the spawned server's). */
  get url(): string | undefined {
    return this.opts.externalUrl ?? this.currentServer?.url
  }

  /** The live reachability snapshot the wire signal mirrors. */
  get status(): SupervisorStatus {
    return {
      reachability: this.reachability,
      retrying: this.retrying,
      url: this.reachability === 'full' ? this.url : undefined,
    }
  }

  /** Update reachability + retrying; emit the status callback only on an actual change. */
  private setStatus(reachability: CapabilityState, retrying: boolean): void {
    if (this.reachability === reachability && this.retrying === retrying) return
    this.reachability = reachability
    this.retrying = retrying
    this.opts.onStatusChange?.(this.status)
  }

  /** Bring the server up. Attach mode just builds a client; managed mode spawns + monitors. */
  async start(): Promise<void> {
    if (this.opts.externalUrl) {
      this.currentClient = this.opts.createClient(this.opts.externalUrl)
      this.setStatus('full', false)
      return
    }
    await this.spawnAndConnect()
    this.startHealthLoop()
    this.registerCleanup()
    this.setStatus('full', false)
  }

  /**
   * Lazy, honest (re)start (2026-06-07-003). Idempotent and **never throws**: if a
   * healthy client already exists it resolves fast; otherwise it (re)spawns within
   * the grace window. On failure it flips reachability to `temporarily-unavailable`
   * and schedules a background self-heal — the caller (`select_session`) degrades
   * softly instead of treating a down server as fatal. Concurrent callers share the
   * one in-flight attempt.
   */
  async ensureRunning(graceMs = this.opts.graceMs): Promise<void> {
    // External: an operator owns liveness — just make sure a client exists.
    if (this.opts.externalUrl) {
      if (!this.currentClient) this.currentClient = this.opts.createClient(this.opts.externalUrl)
      this.setStatus('full', false)
      return
    }
    // Already healthy and running ⇒ nothing to do.
    if (this.currentClient && !this.unavailableReason && !this.stopped) {
      this.setStatus('full', false)
      return
    }
    if (this.starting) return this.starting
    this.starting = this.attemptStart(graceMs).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  /** One bounded (re)start attempt; resolves whether it succeeded or degraded (no throw). */
  private async attemptStart(graceMs: number): Promise<void> {
    this.setStatus('temporarily-unavailable', true)
    this.stopped = false
    this.unavailableReason = null
    this.restarts = 0
    try {
      await withTimeout(this.spawnAndConnect(), graceMs)
      this.startHealthLoop()
      this.registerCleanup()
      this.clearRetryTimer()
      this.retryAttempt = 0
      this.setStatus('full', false)
    } catch (e) {
      // Honest degrade — the dead/half-spawned server must not leak, but we do NOT
      // mark permanently stopped: stay reachable-able and self-heal in background.
      this.opts.onUnavailable?.(`lazy start failed: ${msg(e)}`)
      try {
        this.currentServer?.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      this.currentServer = null
      this.currentClient = null
      this.setStatus('temporarily-unavailable', true)
      this.scheduleSelfHeal()
    }
  }

  /** Background backoff loop that re-attempts a start until the server is up. */
  private scheduleSelfHeal(): void {
    if (this.stopped || this.retryTimer || this.reachability === 'full') return
    this.retryAttempt++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.ensureRunning()
    }, this.opts.backoff(this.retryAttempt))
    this.retryTimer.unref?.()
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  /** The live REST/SSE client. Throws if not started or the vendor went unavailable. */
  client(): OpencodeClient {
    if (this.unavailableReason) throw new Error(`opencode unavailable: ${this.unavailableReason}`)
    if (!this.currentClient) throw new Error('opencode supervisor not started')
    return this.currentClient
  }

  private async spawnAndConnect(): Promise<void> {
    const port = await this.opts.pickPort()
    const server = await this.opts.spawnServer({
      binaryPath: this.opts.binaryPath as string,
      hostname: this.opts.hostname,
      port,
      env: this.opts.env,
      readyTimeoutMs: this.opts.readyTimeoutMs,
    })
    this.currentServer = server
    this.currentClient = this.opts.createClient(server.url)
  }

  private startHealthLoop(): void {
    this.healthTimer = setInterval(() => void this.healthCheck(), this.opts.healthIntervalMs)
    // Don't keep the event loop alive just for the heartbeat.
    this.healthTimer.unref?.()
  }

  private async healthCheck(): Promise<void> {
    if (this.stopped || !this.currentServer || !this.currentClient) return
    try {
      await this.currentClient.path.get()
      this.restarts = 0 // a healthy beat clears the restart budget
    } catch {
      await this.restart('health check failed')
    }
  }

  /** Bounded-backoff respawn. Past the ceiling the vendor is marked unavailable. */
  private async restart(reason: string): Promise<void> {
    if (this.stopped) return
    if (this.restarts >= this.opts.maxRestarts) {
      this.markUnavailable(`exceeded ${this.opts.maxRestarts} restarts (${reason})`)
      return
    }
    this.restarts++
    try {
      this.currentServer?.kill('SIGKILL')
    } catch {
      /* already dead — that's why we're restarting */
    }
    await this.opts.sleep(this.opts.backoff(this.restarts))
    if (this.stopped) return
    try {
      await this.spawnAndConnect()
    } catch (e) {
      await this.restart(`respawn failed: ${msg(e)}`)
    }
  }

  /**
   * Health-loop restart ceiling hit (2026-06-07-003 change): instead of marking the
   * vendor permanently dead, degrade to `temporarily-unavailable` and self-heal in
   * the background. The dead health loop is torn down and the (probably dead) server
   * killed so nothing leaks, but `stopped` stays false so a later `ensureRunning` (or
   * the self-heal timer) can resurrect it. `client()` keeps throwing during the down
   * window via `unavailableReason`.
   */
  private markUnavailable(reason: string): void {
    this.unavailableReason = reason
    this.opts.onUnavailable?.(reason)
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
    try {
      this.currentServer?.kill('SIGKILL')
    } catch {
      /* already dead */
    }
    this.currentServer = null
    this.currentClient = null
    this.setStatus('temporarily-unavailable', true)
    this.scheduleSelfHeal()
  }

  /** Stop monitoring and tree-kill a managed server. Idempotent; safe on process exit. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.clearRetryTimer()
    if (this.healthTimer) {
      clearInterval(this.healthTimer)
      this.healthTimer = null
    }
    if (!this.opts.externalUrl) {
      try {
        this.currentServer?.kill('SIGTERM')
      } catch {
        /* noop */
      }
    }
  }

  private registerCleanup(): void {
    if (this.cleanupRegistered) return
    this.cleanupRegistered = true
    const onExit = (): void => this.stop()
    process.once('exit', onExit)
    process.once('SIGINT', onExit)
    process.once('SIGTERM', onExit)
  }
}

/** Caller-facing supervisor config; all knobs optional with sane defaults + test injection. */
export interface OpencodeSupervisorConfig {
  /** Attach to an external instance (`--opencode-url`) instead of spawning. */
  externalUrl?: string
  hostname?: string
  healthIntervalMs?: number
  maxRestarts?: number
  readyTimeoutMs?: number
  /** Outer grace window for a lazy `ensureRunning` (re)start; clamped to [2000, 10000]ms. */
  graceMs?: number
  /** Extra env merged into the spawned server (e.g. provider base url/key). */
  env?: Record<string, string>
  /** Host CLI path override; defaults to the launcher probe. */
  binaryPath?: string | null
  resolveBinary?: () => string | null
  spawnServer?: ServerSpawner
  createClient?: (baseUrl: string) => OpencodeClient
  pickPort?: () => Promise<number>
  sleep?: (ms: number) => Promise<void>
  backoff?: (attempt: number) => number
  onUnavailable?: (reason: string) => void
  /** Pushed on every reachability transition (and from `ensureRunning`) — wire it to the broadcaster. */
  onStatusChange?: (status: SupervisorStatus) => void
}

/**
 * Build a supervisor with defaults applied. Throws when managed mode is requested
 * but the host CLI is absent (the registry's host-binary gate normally prevents
 * this; the throw is the belt-and-braces). External mode needs no binary.
 */
export function createOpencodeSupervisor(cfg: OpencodeSupervisorConfig = {}): OpencodeSupervisor {
  const binaryPath = cfg.externalUrl
    ? null
    : (cfg.binaryPath ?? (cfg.resolveBinary ?? (() => resolveHostBinary('opencode')))())
  if (!cfg.externalUrl && !binaryPath) {
    throw new Error('opencode host CLI not found (install it or pass --opencode-url)')
  }
  return new OpencodeSupervisor({
    externalUrl: cfg.externalUrl,
    hostname: cfg.hostname ?? '127.0.0.1',
    healthIntervalMs: cfg.healthIntervalMs ?? 10_000,
    maxRestarts: cfg.maxRestarts ?? 5,
    readyTimeoutMs: cfg.readyTimeoutMs ?? 15_000,
    graceMs: Math.min(10_000, Math.max(2_000, cfg.graceMs ?? 8_000)),
    env: cfg.env,
    binaryPath,
    spawnServer: cfg.spawnServer ?? defaultSpawnServer,
    createClient: cfg.createClient ?? ((url) => createOpencodeClient({ baseUrl: url })),
    pickPort: cfg.pickPort ?? (() => pickFreePort(cfg.hostname ?? '127.0.0.1')),
    sleep: cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    backoff: cfg.backoff ?? ((attempt) => Math.min(30_000, 500 * 2 ** attempt)),
    onUnavailable: cfg.onUnavailable,
    onStatusChange: cfg.onStatusChange,
  })
}
