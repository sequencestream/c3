/**
 * Vendor adapter registry — turns the ProcessLauncher's vendor executable
 * resolution into the available agent types. The launcher may resolve an env
 * override, a c3-managed CLI, or a degraded host PATH fallback; only a runnable
 * executable constructs an adapter.
 */
import type { VendorId, VendorAdapter } from './types.js'
import { createClaudeAdapter } from './claude/index.js'
import { createCodexAdapter } from './codex/index.js'
import { HOST_BINARIES, resolveExecutable, type VendorProbe } from '../process/launcher.js'

/** Builds a fresh {@link VendorAdapter}. */
type VendorFactory = () => VendorAdapter

/** The vendors c3 drives via a no-arg factory. */
export const VENDOR_FACTORIES: Partial<Record<VendorId, VendorFactory>> = {
  claude: createClaudeAdapter,
  codex: () => createCodexAdapter(),
}

/** A vendor whose adapter exists but whose host CLI was not found on this host. */
export interface MissingVendor {
  readonly vendor: VendorId
  readonly binary: string
  readonly installHint: string
  readonly source: VendorProbe['source']
  readonly error?: string
  readonly managedError?: string
}

/** The split of registrable vendors into available (probed) vs missing (host CLI absent). */
export interface AdapterRegistry {
  readonly available: VendorAdapter[]
  readonly missing: MissingVendor[]
}

/**
 * Resolve the available vendor adapters, gated by host-binary probing. `resolve`
 * is injectable so the gate is unit-testable without a real host CLI. For each
 * implemented vendor: probe first; construct its adapter only on a hit; otherwise
 * record it as missing with its install hint. The probe is the front-most gate —
 * an unresolved binary short-circuits before the factory runs.
 */
export function resolveAvailableAdapters(
  resolve: (vendor: VendorId) => VendorProbe = resolveExecutable,
): AdapterRegistry {
  const available: VendorAdapter[] = []
  const missing: MissingVendor[] = []

  for (const vendor of Object.keys(VENDOR_FACTORIES) as VendorId[]) {
    const factory = VENDOR_FACTORIES[vendor]
    if (!factory) continue
    const result = resolve(vendor)
    if (result.path) {
      available.push(factory())
    } else {
      const spec = HOST_BINARIES[vendor]
      missing.push({
        vendor,
        binary: spec.binary,
        installHint: spec.installHint,
        source: result.source,
        ...(result.error ? { error: result.error } : {}),
        ...(result.managedError ? { managedError: result.managedError } : {}),
      })
    }
  }

  return { available, missing }
}

/**
 * First-launch host-CLI health check (ADR-0012), mirroring `checkDbDriver`'s
 * loud-but-non-fatal boot probe. Logs which agent types are available and which
 * are unavailable because their host CLI is missing — the latter is a **product
 * convention, not an error**, so it prints actionable install guidance rather than
 * failing. c3 still starts; only the affected vendor's agent type is unavailable.
 */
export function logVendorCliHealth(): void {
  const { available, missing } = resolveAvailableAdapters()
  for (const adapter of available) {
    const p = resolveExecutable(adapter.vendor)
    const detail = p.version ? ` ${p.version}` : ''
    console.log(`[c3] vendor CLI ok: ${adapter.vendor} source=${p.source}${detail} path=${p.path}`)
  }
  for (const m of missing) {
    const reason = [m.error, m.managedError].filter(Boolean).join('; ')
    console.warn(
      `[c3] vendor CLI ${m.source}: ${m.vendor} (agent type unavailable). ${reason ? `${reason}. ` : ''}${m.installHint}`,
    )
  }
}

export const logHostBinaryHealth = logVendorCliHealth
