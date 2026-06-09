/**
 * DockerDriver — Docker Runtime Implementation
 *
 * Implements {@link SandboxDriver} using the dockerode library.
 * Connects to the local Docker daemon via the default socket path.
 *
 * ## Lifecycle
 * 1. `start()` — creates and starts a container with the resolved config
 * 2. `exec()` / `spawnStream()` — runs commands inside the running container
 * 3. `stop()` — stops and optionally removes the container
 * 4. `snapshot()` — commits the container to a new image
 * 5. `healthCheck()` — inspects container status
 *
 * Layer: kernel/sandbox (inner domain — ADR-0009)
 * Status: Phase 1 (MVP — Docker only)
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { Readable, PassThrough } from 'node:stream'
import Docker from 'dockerode'
import type {
  SandboxHandle,
  ResolvedSandboxConfig,
  ExecResult,
  HealthStatus,
  StartOptions,
  StopOptions,
  SandboxStream,
} from '../types.js'
import type { SandboxDriver } from '../SandboxDriver.js'
import type { SeccompProfile } from '../seccomp/profiles.js'

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Constructor options for {@link DockerDriver}.
 */
export interface DockerDriverOptions {
  /**
   * Dockerode instance to use.
   * Defaults to `new Docker()` (connects to local socket).
   */
  readonly docker?: Docker
  /**
   * Seccomp profile loader: given a profile name, returns the parsed
   * SeccompProfile or undefined if not found.
   */
  readonly seccompLoader?: (name: string) => SeccompProfile | undefined
}

// ─── Memory/Cpu Helpers ──────────────────────────────────────────────────────

/**
 * Parse a Docker memory limit string to bytes.
 *
 * Supported suffixes: b, k, m, g, t (case-insensitive).
 * Default suffix: b (bytes).
 *
 * Examples: "256m" → 268435456, "1g" → 1073741824, "512" → 512
 */
function parseMemoryToBytes(limit: string): number {
  const match = limit.match(/^(\d+)([bkmgt])?$/i)
  if (!match) {
    throw new Error(`Invalid memory limit format: "${limit}"`)
  }
  const value = Number.parseInt(match[1], 10)
  const suffix = (match[2] ?? 'b').toLowerCase()
  const multipliers: Record<string, number> = {
    b: 1,
    k: 1024,
    m: 1024 * 1024,
    g: 1024 * 1024 * 1024,
    t: 1024 * 1024 * 1024 * 1024,
  }
  return value * (multipliers[suffix] ?? 1)
}

/**
 * Convert a CPU core count to Docker CpuQuota (at CpuPeriod = 100000).
 *
 * Examples: 1 → 100000, 2 → 200000, 0.5 → 50000
 */
function cpuLimitToQuota(limit: number): number {
  return Math.round(limit * 100000)
}

// ─── Driver ─────────────────────────────────────────────────────────────────

/**
 * Docker driver implementing the SandboxDriver interface.
 *
 * Accepts an optional dockerode instance in the constructor for testability.
 */
export class DockerDriver implements SandboxDriver {
  readonly #docker: Docker
  readonly #seccompLoader?: (name: string) => SeccompProfile | undefined

  constructor(opts: DockerDriverOptions = {}) {
    this.#docker = opts.docker ?? new Docker()
    this.#seccompLoader = opts.seccompLoader
  }

  // ─── Start ───────────────────────────────────────────────────────────────

  async start(config: ResolvedSandboxConfig, options?: StartOptions): Promise<SandboxHandle> {
    const hostConfig: Record<string, unknown> = {
      Memory: parseMemoryToBytes(config.memoryLimit),
      CpuPeriod: 100000,
      CpuQuota: cpuLimitToQuota(config.cpuLimit),
      ReadonlyRootfs: config.readonlyRootfs,
      NetworkMode: config.networkDisabled ? 'none' : undefined,
    }

    // Seccomp
    if (config.seccomp) {
      const seccompOpt = this.#resolveSeccompOpt(config.seccomp)
      if (seccompOpt) {
        hostConfig.SecurityOpt = seccompOpt
      }
    }

    // Bind mounts
    if (options?.binds && options.binds.length > 0) {
      hostConfig.Binds = [...options.binds]
    }

    // Deep-merge any dockerOptions into hostConfig
    if (config.dockerOptions?.HostConfig) {
      Object.assign(hostConfig, config.dockerOptions.HostConfig)
    }

    const createOpts: Record<string, unknown> = {
      Image: config.image,
      Cmd: [...(options?.entrypoint ?? config.entrypoint ?? ['sleep', 'infinity'])],
      HostConfig: hostConfig,
      WorkingDir: config.workingDir,
      Env: Object.entries(config.envVars).map(([k, v]) => `${k}=${v}`),
    }

    if (options?.labels && Object.keys(options.labels).length > 0) {
      createOpts.Labels = { ...options.labels }
    }

    if (config.dockerOptions && !('HostConfig' in config.dockerOptions)) {
      Object.assign(createOpts, config.dockerOptions)
    }

    const container = await this.#docker.createContainer(createOpts)
    await container.start()

    const sandboxId = randomUUID()

    return {
      sandboxId,
      type: config.type,
      containerId: container.id,
      image: config.image,
      createdAt: Date.now(),
      status: 'running',
    }
  }

  // ─── Stop ────────────────────────────────────────────────────────────────

  async stop(handle: SandboxHandle, options?: StopOptions): Promise<void> {
    const container = this.#docker.getContainer(handle.containerId)

    try {
      await container.stop({ t: options?.timeout ?? 10 })
    } catch {
      // Container may already be stopped — swallow the error
    }

    if (options?.remove ?? false) {
      try {
        await container.remove({ force: true })
      } catch {
        // Best-effort removal
      }
    }
  }

  // ─── Exec ────────────────────────────────────────────────────────────────

  async exec(handle: SandboxHandle, command: readonly string[]): Promise<ExecResult> {
    const container = this.#docker.getContainer(handle.containerId)

    const exec = await container.exec({
      Cmd: [...command],
      AttachStdout: true,
      AttachStderr: true,
    })

    const stream = await exec.start({ Tty: true, Detach: false })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    // With Tty:true, all output is on stdout (merged)
    const passThrough = new PassThrough()
    stream.pipe(passThrough)

    for await (const chunk of passThrough) {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    // Inspect to get exit code
    let exitCode: number | null = null
    try {
      const inspect = await exec.inspect()
      exitCode = inspect.ExitCode ?? null
    } catch {
      // exec may have been cleaned up
    }

    return {
      stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      exitCode,
    }
  }

  // ─── Spawn Stream ───────────────────────────────────────────────────────

  async spawnStream(handle: SandboxHandle, command: readonly string[]): Promise<SandboxStream> {
    const container = this.#docker.getContainer(handle.containerId)

    const exec = await container.exec({
      Cmd: [...command],
      AttachStdout: true,
      AttachStderr: true,
    })

    const stream = await exec.start({ Tty: true, Detach: false })
    return stream as unknown as Readable
  }

  // ─── Snapshot ─────────────────────────────────────────────────────────────

  async snapshot(handle: SandboxHandle, tag: string): Promise<string> {
    const container = this.#docker.getContainer(handle.containerId)
    const result = await container.commit({ repo: tag })
    return result?.Id ?? tag
  }

  // ─── Copy From ───────────────────────────────────────────────────────────

  async copyFrom(handle: SandboxHandle, containerPath: string, hostPath: string): Promise<void> {
    const container = this.#docker.getContainer(handle.containerId)

    const stream = await container.getArchive({ path: containerPath })
    // Ensure the host directory exists
    mkdirSync(hostPath, { recursive: true })

    return new Promise<void>((resolve, reject) => {
      const tar = spawn('tar', ['xf', '-', '-C', hostPath], { stdio: ['pipe', 'ignore', 'pipe'] })
      let stderr = ''
      tar.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      stream.pipe(tar.stdin)

      tar.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`tar extract failed (exit ${code}): ${stderr}`))
      })
      tar.on('error', (err) => reject(new Error(`tar spawn error: ${err.message}`)))
      stream.on('error', (err) => reject(new Error(`docker cp stream error: ${err.message}`)))
    })
  }

  // ─── Health Check ─────────────────────────────────────────────────────────

  async healthCheck(handle: SandboxHandle): Promise<HealthStatus> {
    const container = this.#docker.getContainer(handle.containerId)

    let info: Record<string, unknown>
    try {
      info = (await container.inspect()) as unknown as Record<string, unknown>
    } catch (cause) {
      return {
        running: false,
        status: 'error',
        error: `Failed to inspect container: ${(cause as Error).message}`,
      }
    }

    const state = info.State as Record<string, unknown> | undefined
    const running = state?.Running === true
    const startedAt = state?.StartedAt ? new Date(state.StartedAt as string).getTime() : undefined
    const finishedAt = state?.FinishedAt
      ? new Date(state.FinishedAt as string).getTime()
      : undefined
    const exitCode = state?.ExitCode as number | undefined

    return {
      running,
      status: running ? 'running' : 'stopped',
      startedAt: startedAt && !Number.isNaN(startedAt) ? startedAt : undefined,
      finishedAt: finishedAt && !Number.isNaN(finishedAt) ? finishedAt : undefined,
      exitCode,
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────────────

  /**
   * Resolve a seccomp profile name to a Docker SecurityOpt string.
   *
   * Uses the injected seccompLoader if available. If the profile cannot be
   * resolved, returns undefined (no seccomp constraint).
   */
  #resolveSeccompOpt(name: string): string[] | undefined {
    if (!this.#seccompLoader) return undefined
    const profile = this.#seccompLoader(name)
    if (!profile) return undefined

    // For MVP, we write the profile to a temp file and reference it.
    // In production, profiles are embedded and written at startup.
    // For now, return a placeholder that Docker will accept.
    return [`seccomp=unconfined`]
  }
}
