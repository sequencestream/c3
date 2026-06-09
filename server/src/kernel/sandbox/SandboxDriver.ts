/**
 * SandboxDriver — Abstract Driver Interface
 *
 * Defines the contract every sandbox runtime backend must implement.
 * The interface is designed to be vendor-agnostic, supporting Docker,
 * gVisor, Kata Containers, and Firecracker as backends.
 *
 * Layer: kernel/sandbox (inner domain — ADR-0009)
 * Status: Phase 1 (MVP — Docker only)
 *
 * @module
 */

import type {
  SandboxHandle,
  ResolvedSandboxConfig,
  ExecResult,
  HealthStatus,
  StartOptions,
  StopOptions,
  SandboxStream,
} from './types.js'

/**
 * Abstract interface for container sandbox drivers.
 *
 * Each method maps to a lifecycle operation on the underlying container
 * runtime. Implementations are responsible for bridging the generic
 * contract to the runtime's native API.
 */
export interface SandboxDriver {
  /**
   * Start a new sandbox instance from the resolved config.
   *
   * Creates and starts a container, returning a handle that identifies
   * the running instance for subsequent operations.
   *
   * @param config  Fully resolved sandbox configuration.
   * @param options Optional start-time parameters (binds, labels, etc.).
   * @returns A handle to the running sandbox.
   */
  start(config: ResolvedSandboxConfig, options?: StartOptions): Promise<SandboxHandle>

  /**
   * Stop and optionally remove a running sandbox.
   *
   * @param handle  Handle of the sandbox to stop.
   * @param options Optional stop-time parameters (timeout, remove).
   */
  stop(handle: SandboxHandle, options?: StopOptions): Promise<void>

  /**
   * Execute a command inside a running sandbox and collect its output.
   *
   * Blocks until the command completes. For interactive or long-running
   * commands, use {@link spawnStream} instead.
   *
   * @param handle  Handle of the running sandbox.
   * @param command Command and arguments (e.g. ["ls", "-la"]).
   * @returns The command's stdout, stderr, and exit code.
   */
  exec(handle: SandboxHandle, command: readonly string[]): Promise<ExecResult>

  /**
   * Execute a command inside a running sandbox and stream its output.
   *
   * Returns a Node.js Readable stream that emits the command's combined
   * output (stdout + stderr) as it is produced. The caller is responsible
   * for consuming or destroying the stream.
   *
   * @param handle  Handle of the running sandbox.
   * @param command Command and arguments.
   * @returns A readable stream of the command output.
   */
  spawnStream(handle: SandboxHandle, command: readonly string[]): Promise<SandboxStream>

  /**
   * Snapshot (commit) a running sandbox to a new image.
   *
   * @param handle Handle of the running sandbox.
   * @param tag    Image tag for the snapshot (e.g. "my-snapshot:latest").
   * @returns The created image identifier.
   */
  snapshot(handle: SandboxHandle, tag: string): Promise<string>

  /**
   * Copy files/directories FROM a running container TO the host.
   *
   * Uses `docker cp` under the hood (dockerode's getArchive). The tar
   * stream from the container is extracted at the host path.
   *
   * @param handle        Handle of the running sandbox.
   * @param containerPath Path inside the container (e.g. "/workspace").
   * @param hostPath      Destination directory on the host.
   */
  copyFrom(handle: SandboxHandle, containerPath: string, hostPath: string): Promise<void>

  /**
   * Check the health and status of a running sandbox.
   *
   * @param handle Handle of the sandbox to check.
   * @returns The current health status.
   */
  healthCheck(handle: SandboxHandle): Promise<HealthStatus>
}
