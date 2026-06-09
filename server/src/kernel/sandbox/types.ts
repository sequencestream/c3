/**
 * Sandbox — Kernel Boundary Types
 *
 * Core type definitions for the sandbox subsystem. These are pure types (zero
 * runtime cost) that define the contract between the sandbox registry, config
 * layer, and driver implementations.
 *
 * Layer: kernel/sandbox (inner domain — ADR-0009)
 * Status: Phase 1 (MVP — Docker only)
 *
 * @module
 */

// ─── Sandbox Runtime Selection ───────────────────────────────────────────────

/**
 * Supported container runtime backends.
 *
 * - `'docker'`: Docker daemon (Phase 1 — MVP)
 * - `'gvisor'`: gVisor (runsc) lightweight VM (Phase 2, planned)
 * - `'kata'`:   Kata Containers (Phase 2, planned)
 * - `'firecracker'`: Firecracker micro-VM (Phase 2, planned)
 */
export type SandboxType = 'docker' | 'gvisor' | 'kata' | 'firecracker'

/**
 * Runtime status of a sandbox instance.
 */
export type SandboxStatus = 'running' | 'stopped' | 'error'

// ─── Configuration Types ─────────────────────────────────────────────────────

/**
 * System-level sandbox definition — the "template" registered at startup
 * from the system config sandbox profiles section.
 *
 * Each profile has a unique {@link name} that the project config references
 * via {@link ProjectSandboxConfig.sandbox}.
 */
export interface SystemSandboxDef {
  /** Unique name for this sandbox definition (e.g. "default", "nodejs", "python"). */
  readonly name: string
  /** Container runtime type. */
  readonly type: SandboxType
  /** Container image (e.g. "node:20-alpine", "python:3.12-slim"). */
  readonly image: string
  /** Seccomp profile name (loaded from the seccomp directory). */
  readonly seccomp?: string
  /** Memory limit in Docker format: "256m", "2g", etc. */
  readonly memoryLimit?: string
  /** CPU limit in fractional cores (e.g. 2 = 2 CPUs, 0.5 = half a core). */
  readonly cpuLimit?: number
  /** Environment variables injected into the container. */
  readonly envVars?: Readonly<Record<string, string>>
  /** When true, the container has no network access. */
  readonly networkDisabled?: boolean
  /** When true, the container root filesystem is read-only. */
  readonly readonlyRootfs?: boolean
  /** Working directory inside the container. */
  readonly workingDir?: string
  /** Entrypoint override (replaces CMD). */
  readonly entrypoint?: readonly string[]
  /** Additional Docker-specific options (passed verbatim to dockerode). */
  readonly dockerOptions?: Readonly<Record<string, unknown>>
}

/**
 * Project-level sandbox config overrides — the subset of config a c3 project
 * can override without defining a full sandbox profile.
 */
export interface ProjectSandboxConfig {
  /** Name of the system sandbox def to use (required to activate sandboxing). */
  readonly sandbox?: string
  /** Override the base image. */
  readonly imageOverride?: string
  /** Override memory limit. */
  readonly memoryLimitOverride?: string
  /** Override CPU limit. */
  readonly cpuLimitOverride?: number
  /** Additional env vars merged on top of the system def's envVars. */
  readonly envVarsOverride?: Readonly<Record<string, string>>
}

/**
 * Fully resolved sandbox configuration — the output of merging a
 * {@link SystemSandboxDef} with an optional {@link ProjectSandboxConfig}.
 *
 * All optional fields that have sensible defaults are filled in during
 * resolution, so driver implementations can assume every field is defined.
 */
export interface ResolvedSandboxConfig {
  readonly type: SandboxType
  readonly image: string
  readonly seccomp?: string
  readonly memoryLimit: string
  readonly cpuLimit: number
  readonly networkDisabled: boolean
  readonly readonlyRootfs: boolean
  readonly envVars: Readonly<Record<string, string>>
  readonly workingDir?: string
  readonly entrypoint?: readonly string[]
  readonly dockerOptions?: Readonly<Record<string, unknown>>
}

// ─── Runtime Types ───────────────────────────────────────────────────────────

/**
 * Handle representing a running sandbox instance.
 *
 * Returned by {@link SandboxDriver.start} and used as input to all other
 * driver methods that operate on an active sandbox.
 */
export interface SandboxHandle {
  /** Globally unique sandbox instance identifier. */
  readonly sandboxId: string
  /** Container runtime type. */
  readonly type: SandboxType
  /** The container runtime's native ID (Docker container ID). */
  readonly containerId: string
  /** Container image used to create this instance. */
  readonly image: string
  /** Unix timestamp (ms) when the sandbox was started. */
  readonly createdAt: number
  /** Current runtime status. */
  readonly status: SandboxStatus
}

/**
 * Result of a non-streaming exec call.
 */
export interface ExecResult {
  /** stdout output as a UTF-8 string. */
  readonly stdout: string
  /** stderr output as a UTF-8 string. */
  readonly stderr: string
  /** Exit code, or null if the process was terminated by a signal. */
  readonly exitCode: number | null
}

/**
 * Result of a health check.
 */
export interface HealthStatus {
  /** Whether the container is currently running. */
  readonly running: boolean
  /** Runtime status enumeration. */
  readonly status: SandboxStatus
  /** Unix timestamp when the container was started, if available. */
  readonly startedAt?: number
  /** Unix timestamp when the container stopped, if available. */
  readonly finishedAt?: number
  /** Exit code from the container's main process, if stopped. */
  readonly exitCode?: number
  /** Error message if the health check itself failed. */
  readonly error?: string
}

/**
 * Options passed to {@link SandboxDriver.start}.
 */
export interface StartOptions {
  /** Host directory bind mounts (Docker -v format: "host:container"). */
  readonly binds?: readonly string[]
  /** Entrypoint override for this specific start call. */
  readonly entrypoint?: readonly string[]
  /** Additional labels to attach to the container. */
  readonly labels?: Readonly<Record<string, string>>
}

/**
 * Options passed to {@link SandboxDriver.stop}.
 */
export interface StopOptions {
  /** Timeout in seconds before force-killing (SIGKILL). Default: 10. */
  readonly timeout?: number
  /** When true, also remove the container after stopping. Default: false. */
  readonly remove?: boolean
}

/**
 * Stream type returned by {@link SandboxDriver.spawnStream}.
 *
 * A Node.js Readable stream emitting command output from inside the sandbox.
 */
export type SandboxStream = import('stream').Readable
