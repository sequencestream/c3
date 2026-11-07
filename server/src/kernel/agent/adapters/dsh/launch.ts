import { randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { DriverStartOptions } from '../types.js'
import { hostDshHome } from '../../../config/workspace-path.js'

export interface DshLaunchConfig {
  readonly provider: string
  readonly model: string
  readonly apiKey?: string
  readonly dshHome: string
  readonly sessionId: string
}

function readDshProvider(opts: DriverStartOptions): string {
  const ctx = opts.vendorContext?.['dshProvider']
  return typeof ctx === 'string' && ctx.trim() ? ctx.trim() : 'deepseek-official'
}

function readDshApiKey(opts: DriverStartOptions): string | undefined {
  const ctx = opts.vendorContext?.['dshApiKey']
  if (typeof ctx === 'string' && ctx.trim()) return ctx.trim()
  return undefined
}

/** Subprocess spec passed to the SDK client in place of its default launch. */
export interface DshSdkProcess {
  readonly command: string
  readonly args: string[]
  readonly cwd?: string
  readonly environment: () => NodeJS.ProcessEnv
  readonly description: string
  readonly initializeTimeoutMs: number
}

export interface DshSdkProcessInput {
  readonly binary: string
  readonly cwd?: string
  readonly env: NodeJS.ProcessEnv
  readonly dshHome: string
  readonly profile?: string
  readonly initializeTimeoutMs?: number
}

/**
 * `dsh --profile sdk` against the resolved host executable.
 *
 * The SDK client's own launch is `process.execPath <dshBin> --profile …`.
 * In a compiled c3 binary `process.execPath` is c3, so that child is c3's
 * CLI and it exits with `unknown option '--profile'`. The path c3 resolved
 * is already the host executable — a node shebang or the managed shell
 * wrapper — so it has to be executed directly.
 */
export function dshSdkProcess(input: DshSdkProcessInput): DshSdkProcess {
  const profile = input.profile?.trim() || 'sdk'
  const command = isAbsolute(input.binary) ? input.binary : resolve(input.binary)
  const dshHome = isAbsolute(input.dshHome) ? input.dshHome : resolve(input.dshHome)
  const cwd = input.cwd ? (isAbsolute(input.cwd) ? input.cwd : resolve(input.cwd)) : undefined
  return {
    command,
    args: ['--profile', profile],
    ...(cwd ? { cwd } : {}),
    environment: () => ({
      ...input.env,
      DSH_HOME: dshHome,
    }),
    description: `dsh profile "${profile}"`,
    initializeTimeoutMs: input.initializeTimeoutMs ?? 10_000,
  }
}

/** Build harness launch parameters from neutral driver options. */
export function resolveDshLaunch(opts: DriverStartOptions): DshLaunchConfig {
  const workspace = opts.workspacePath ?? opts.cwd
  const dshHome = hostDshHome(workspace)
  const sessionId = opts.resume?.trim() ? opts.resume.trim() : randomUUID()
  const model = opts.model?.trim() || 'deepseek-flash'
  return {
    provider: readDshProvider(opts),
    model,
    ...(readDshApiKey(opts) ? { apiKey: readDshApiKey(opts) } : {}),
    dshHome,
    sessionId,
  }
}
