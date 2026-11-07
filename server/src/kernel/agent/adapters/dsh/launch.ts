import { randomUUID } from 'node:crypto'
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

/** Build harness launch parameters from neutral driver options. */
export function resolveDshLaunch(opts: DriverStartOptions): DshLaunchConfig {
  const workspace = opts.workspacePath ?? opts.cwd
  const dshHome = hostDshHome(workspace)
  const sessionId = opts.resume?.trim() ? opts.resume.trim() : randomUUID()
  const model = opts.model?.trim() || 'deepseek-v4-flash'
  return {
    provider: readDshProvider(opts),
    model,
    ...(readDshApiKey(opts) ? { apiKey: readDshApiKey(opts) } : {}),
    dshHome,
    sessionId,
  }
}
