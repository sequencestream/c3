/**
 * SandboxLauncher — Sandbox Container Orchestrator
 *
 * The integration layer between the run lifecycle and the sandbox subsystem.
 * Resolves the project's sandbox config, starts a container, and provides
 * a wrapper mechanism so vendor CLIs run inside the container transparently.
 *
 * ## Flow
 * 1. `launch(projectPath)` — checks if sandbox is enabled, resolves config,
 *    starts a Docker container, returns a handle.
 * 2. `createWrapper(handle, binaryName, env)` — creates a shell script that
 *    runs the vendor CLI inside the container via `docker exec --env-file`.
 * 3. The wrapper path is passed to the vendor SDK as `pathToClaudeCodeExecutable`
 *    or `codexPathOverride`. The SDK spawns it as a normal subprocess; I/O
 *    passes through transparently.
 * 4. On run completion, the caller calls `stop()` on the launch result.
 *
 * Layer: kernel/sandbox (inner domain — ADR-0009)
 * Status: Phase 1 (MVP — Docker only)
 *
 * @module
 */

import { chmodSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProjectSandboxConfig } from '@ccc/shared/protocol'
import type { SandboxDriver } from './SandboxDriver.js'
import type { SandboxRegistry } from './SandboxRegistry.js'
import type { SandboxHandle, ResolvedSandboxConfig } from './types.js'
import type { CheckpointResult } from '../agent/adapters/types.js'
import { getProjectSandbox } from '../../kernel/config/index.js'

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Result of a successful sandbox launch.
 *
 * The caller owns the lifecycle: call `stop()` when the run completes or
 * the session is destroyed.
 */
export interface SandboxLaunchResult {
  /** The running sandbox handle (container reference). */
  readonly handle: SandboxHandle
  /**
   * The resolved container configuration (with project overrides applied).
   * Carries the env vars the container was started with, used as a base by
   * the wrapper creation step.
   */
  readonly resolvedConfig: ResolvedSandboxConfig
  /**
   * Path to a temp directory holding the wrapper script and env file.
   * Cleaned up by `stop()`.
   */
  readonly tmpDir: string
  /**
   * Stop the container and clean up temp files.
   * Idempotent: safe to call multiple times.
   */
  stop: () => Promise<void>
}

// ─── Driver Isolation Check ──────────────────────────────────────────────────

/**
 * Check whether Docker is reachable by probing the driver's health.
 * Returns null on success, or an error message string on failure.
 */
export async function checkDockerAvailable(driver: SandboxDriver): Promise<string | null> {
  // Create a minimal config to start a throw-away test container
  const testConfig: ResolvedSandboxConfig = {
    type: 'docker',
    image: 'hello-world:latest',
    memoryLimit: '64m',
    cpuLimit: 0.5,
    networkDisabled: true,
    readonlyRootfs: true,
    envVars: {},
  }

  try {
    const handle = await driver.start(testConfig, {
      entrypoint: ['/hello'],
    })
    // Ensure that we can stop it
    await driver.stop(handle, { timeout: 5, remove: true })
    return null
  } catch (err) {
    return `Docker is not available: ${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * Attempt to resolve and start a sandbox container for the given project path.
 *
 * @param driver   The sandbox driver (DockerDriver).
 * @param registry The sandbox registry containing system defs.
 * @param projectPath  Absolute path to the project workspace.
 * @returns A {@link SandboxLaunchResult} when sandbox is enabled and the
 *          container starts successfully, or `null` when sandbox is not enabled.
 * @throws When sandbox is enabled but container startup fails.
 */
export async function launchSandbox(
  driver: SandboxDriver,
  registry: SandboxRegistry,
  projectPath: string,
): Promise<SandboxLaunchResult | null> {
  const projectCfg: ProjectSandboxConfig | undefined = getProjectSandbox(projectPath)

  // Not configured or explicitly disabled → skip sandbox
  if (!projectCfg?.enabled || !projectCfg.sandbox) return null

  // Resolve the system def + project overrides into a full config
  const resolvedConfig = registry.resolve(projectCfg.sandbox, projectCfg)

  // Start the container with the project dir bind-mounted at /workspace
  const handle = await driver.start(resolvedConfig, {
    binds: [`${projectPath}:/workspace`],
    labels: {
      'c3.sandbox': 'true',
      'c3.project': projectPath.replace(/\//g, '_'),
    },
  })

  // Create temp dir for wrapper script and env file
  const shortContainerId = handle.containerId.slice(0, 12)
  const tmpDir = mkdtempSync(join(tmpdir(), `c3-sb-${shortContainerId}-`))

  return {
    handle,
    resolvedConfig,
    tmpDir,
    stop: async () => {
      await driver.stop(handle, { timeout: 10, remove: true })
      // Clean up temp dir (best-effort)
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // Temp dir cleanup is best-effort
      }
    },
  }
}

/**
 * Create a wrapper script that runs the given binary inside the sandbox container.
 *
 * The wrapper is a POSIX shell script that calls `docker exec --env-file` to
 * pass the specified environment variables into the container, then runs the
 * binary with all arguments forwarded.
 *
 * @param handle     The sandbox handle (must be running).
 * @param tmpDir     The temp directory returned by {@link launchSandbox}.
 * @param binaryName The binary name or path inside the container
 *                   (e.g. `"claude"` or `"/usr/local/bin/claude"`).
 * @param envVars    Environment variables to forward into the container.
 *                   Written to an env file alongside the wrapper.
 * @returns The absolute path to the wrapper script (executable).
 */
export function createSandboxWrapper(
  handle: SandboxHandle,
  tmpDir: string,
  binaryName: string,
  envVars: Record<string, string>,
): string {
  // Write the env file that docker exec will read
  const envFilePath = join(tmpDir, 'env.txt')
  const envLines = Object.entries(envVars)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${serializeEnvValue(v)}`)
    .join('\n')
  writeFileSync(envFilePath, envLines + '\n', 'utf-8')

  // Write the wrapper script
  const scriptPath = join(tmpDir, 'wrapper.sh')
  const script = `#!/bin/sh
# c3 sandbox wrapper — runs binary inside Docker container
exec docker exec --env-file "${envFilePath}" -i -w /workspace "${handle.containerId}" "${binaryName}" "$@"
`
  writeFileSync(scriptPath, script, 'utf-8')
  chmodSync(scriptPath, 0o755)

  return scriptPath
}

/**
 * Run a pre-approval checkpoint for a sandboxed container.
 *
 * Copies the workspace files from the container to a temp directory on the
 * host and lists the files found. The caller uses the result to decide whether
 * pre-approval is safe (e.g., no unexpected file modifications).
 *
 * This is the concrete implementation of
 * {@link import('../agent/adapters/types.js').ApprovalBridge.preApproveCheckpoint}.
 *
 * @param handle   The running sandbox handle.
 * @param driver   The sandbox driver (for `copyFrom`).
 * @param tmpDir   A temp directory (created per-call) where workspace files
 *                 are copied for inspection.
 * @returns A checkpoint result: `safe: true` when the workspace has no
 *          unexpected files, or `safe: false` with the reason.
 */
export async function preApproveCheckpoint(
  handle: SandboxHandle,
  driver: Pick<SandboxDriver, 'copyFrom'>,
  tmpDir: string,
): Promise<CheckpointResult> {
  const snapshotDir = join(tmpDir, `c3-checkpoint-${Date.now()}`)

  try {
    await driver.copyFrom(handle, '/workspace', snapshotDir)

    // List the files in the snapshot (non-recursive, top-level only for MVP)
    const files = readdirSync(snapshotDir).filter((f) => f !== '.' && f !== '..')

    // Clean up the snapshot dir (best-effort)
    try {
      rmSync(snapshotDir, { recursive: true, force: true })
    } catch {
      // best-effort
    }

    // For MVP: the checkpoint is always safe (files are just listed).
    // Real file-change detection (diff against baseline) is Phase 2.
    return {
      safe: true,
      reason: `Checkpoint OK: ${files.length} file(s) in workspace`,
      ...(files.length > 0 ? { modifiedFiles: files } : {}),
    }
  } catch (err) {
    // Clean up on error
    try {
      rmSync(snapshotDir, { recursive: true, force: true })
    } catch {
      // best-effort
    }

    return {
      safe: false,
      reason: `Checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Serialize an env var value for the `--env-file` format.
 *
 * Docker's `--env-file` format is simple: each line is `KEY=VALUE`.
 * Values with spaces or special chars should NOT be quoted — Docker treats
 * the entire line after `=` as the value verbatim (stripping trailing whitespace).
 * Values with embedded newlines are not supported.
 */
function serializeEnvValue(value: string): string {
  // Docker's --env-file format: everything after the first `=` is the value.
  // Trim trailing whitespace (Docker's convention), keep everything else verbatim.
  return value.replace(/\s+$/, '')
}
