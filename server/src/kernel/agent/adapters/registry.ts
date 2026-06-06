/**
 * Vendor adapter registry (ADR-0012) — turns the ProcessLauncher's host-binary
 * probe into the **available agent types**. This is the first capability gate:
 * for each *implemented* vendor we ask the launcher `resolve(vendor)`; only when
 * the host CLI is present do we construct the {@link VendorAdapter} at all. A
 * missing host binary ⇒ the vendor lands in `missing` (with install guidance) and
 * its adapter is never built, so its {@link AdapterCapabilities} never come into
 * play. "Probe before construct" keeps the gate strictly ahead of capabilities.
 *
 * `claude` registers via a no-arg factory (ADR-0011 reference); `codex` likewise
 * (read-only advisor seat, Phase 0 008 NO-GO, 2026-06-06-005) — like Claude it
 * spawns its CLI per run via the SDK, so it needs no supervisor. `opencode` is the
 * first full non-Claude integration (2026-06-06-003) but it needs a started
 * {@link OpencodeSupervisor}, so it is NOT a no-arg factory — the composition root
 * builds its adapter and injects it here via `opts.opencode`.
 */
import type { VendorId, VendorAdapter } from './types.js'
import { createClaudeAdapter } from './claude/index.js'
import { createCodexAdapter } from './codex/index.js'
import { HOST_BINARIES, resolve as resolveHostBinary } from '../process/launcher.js'

/** Builds a fresh {@link VendorAdapter}. */
type VendorFactory = () => VendorAdapter

/**
 * The vendors c3 drives via a no-arg factory. `opencode` is registered separately
 * (it needs a supervisor) — see {@link resolveAvailableAdapters}'s `opencode` opt.
 */
export const VENDOR_FACTORIES: Partial<Record<VendorId, VendorFactory>> = {
  claude: createClaudeAdapter,
  codex: () => createCodexAdapter(),
}

/** A vendor whose adapter exists but whose host CLI was not found on this host. */
export interface MissingVendor {
  readonly vendor: VendorId
  readonly binary: string
  readonly installHint: string
}

/**
 * The composition root's injected OpenCode adapter (built over a started
 * supervisor). `external` true ⇒ an operator-run instance (`--opencode-url`) that
 * bypasses the host-binary gate.
 */
export interface OpencodeRegistration {
  readonly adapter: VendorAdapter
  readonly external: boolean
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
  resolve: (vendor: VendorId) => string | null = resolveHostBinary,
  opencode?: OpencodeRegistration | null,
): AdapterRegistry {
  const available: VendorAdapter[] = []
  const missing: MissingVendor[] = []

  for (const vendor of Object.keys(VENDOR_FACTORIES) as VendorId[]) {
    const factory = VENDOR_FACTORIES[vendor]
    if (!factory) continue
    const path = resolve(vendor)
    if (path) {
      available.push(factory())
    } else {
      const spec = HOST_BINARIES[vendor]
      missing.push({ vendor, binary: spec.binary, installHint: spec.installHint })
    }
  }

  // OpenCode is injected (it carries a started supervisor). An external instance
  // (`--opencode-url`) bypasses the host-binary gate — no local CLI is needed when
  // someone else runs the server; otherwise the same probe gates it as the others.
  if (opencode) {
    if (opencode.external || resolve('opencode')) {
      available.push(opencode.adapter)
    } else {
      const spec = HOST_BINARIES.opencode
      missing.push({ vendor: 'opencode', binary: spec.binary, installHint: spec.installHint })
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
export function logHostBinaryHealth(): void {
  const { available, missing } = resolveAvailableAdapters()
  for (const adapter of available) {
    console.log(`[c3] host CLI ok: ${adapter.vendor}`)
  }
  for (const m of missing) {
    console.warn(
      `[c3] host CLI MISSING: ${m.vendor} (agent type unavailable until installed). ${m.installHint}`,
    )
  }
}
