/**
 * Vendor adapter registry — turns the ProcessLauncher's vendor executable
 * resolution into the available agent types. The launcher may resolve an env
 * override, a c3-managed CLI, or a degraded host PATH fallback; only a runnable
 * executable constructs an adapter.
 */
import type { ModeToken, NeutralMode, VendorId, VendorAdapter } from './types.js'
import { createClaudeAdapter } from './claude/index.js'
import { createCodexAdapter, codexPolicyToGrid, resolveCodexGhTokenEnv } from './codex/index.js'
import { createCursorAdapter } from './cursor/index.js'
import { HOST_BINARIES, resolveExecutable, type VendorProbe } from '../process/launcher.js'
import { tokenToGrid } from './mode-catalog.js'
import { MODE_CATALOGS } from './index.js'
import type { Relay } from '../../relay/contract.js'
import type { CodexPolicy } from '@ccc/shared/protocol'

/**
 * Optional dependencies a vendor factory may need. Injected rather than reached
 * for, so a caller (a feature, the server composition root) never has to import
 * `adapters/<vendor>/**` to construct an adapter (2026-09-28).
 */
export interface VendorFactoryDeps {
  /** The in-process vendor-neutral relay, for vendors that support it. */
  relay?: Relay
}

/** Builds a fresh {@link VendorAdapter}. */
type VendorFactory = (deps: VendorFactoryDeps) => VendorAdapter

/** The vendors c3 drives via a factory. */
export const VENDOR_FACTORIES: Partial<Record<VendorId, VendorFactory>> = {
  claude: () => createClaudeAdapter(),
  codex: (deps) => createCodexAdapter(undefined, undefined, deps.relay),
  cursor: () => createCursorAdapter(),
}

/**
 * Construct a vendor's adapter through the registry, so callers outside the
 * kernel's adapter subtree never import a vendor module. Returns `undefined` for
 * a vendor c3 does not implement (a partial table, by design).
 */
export function resolveVendorAdapter(
  vendor: VendorId,
  deps: VendorFactoryDeps = {},
): VendorAdapter | undefined {
  return VENDOR_FACTORIES[vendor]?.(deps)
}

/**
 * Resolve a stored vendor-native mode to the NEUTRAL grid, vendor-agnostically.
 *
 * codex is the one vendor whose stored form is a dual-policy OBJECT rather than
 * a catalog token, so it is read through its own reverse mapping here; every
 * other vendor's stored form is a {@link ModeToken} read through its catalog.
 * The vendor branch lives in the kernel (this file), never in a feature — a
 * feature that needs the grid calls this and gets a `NeutralMode` back.
 */
export function storedModeToGrid(
  vendor: VendorId,
  storedMode: ModeToken | CodexPolicy,
): NeutralMode {
  if (vendor === 'codex' && typeof storedMode === 'object' && storedMode !== null) {
    return codexPolicyToGrid(storedMode as CodexPolicy)
  }
  const token = typeof storedMode === 'string' ? storedMode : MODE_CATALOGS[vendor].defaultToken
  return tokenToGrid(MODE_CATALOGS[vendor], token)
}

/**
 * Bridge a vendor's host credential needs into the run's env overrides.
 *
 * Codex is the only vendor with a sandbox that cannot read the OS keyring where
 * `gh` keeps its token, so it is the only one that needs the bridge; for every
 * other vendor this is the identity function. A feature calls this instead of
 * importing `adapters/codex/gh-token.js` (2026-09-28).
 */
export function resolveVendorCredentialEnv(
  vendor: VendorId,
  envOverrides?: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  if (vendor === 'codex') return resolveCodexGhTokenEnv(envOverrides)
  return Promise.resolve(envOverrides)
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
      available.push(factory({}))
    } else {
      // Every factory in this table is a host-CLI vendor, so a spec always exists;
      // the probe's own binary name is the fallback that keeps this total without
      // a non-null assertion.
      const spec = HOST_BINARIES[vendor]
      missing.push({
        vendor,
        binary: spec?.binary ?? result.binary,
        installHint: spec?.installHint ?? result.installHint,
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
 *
 * This reports the CLI state resolvable at call time. The managed-CLI remote sync
 * runs in the background, so at boot these lines are a pre-refresh snapshot, never
 * the result of a completed check — hence the explicit header.
 */
export function logVendorCliHealth(): void {
  const { available, missing } = resolveAvailableAdapters()
  console.log('[c3] vendor CLI snapshot (background refresh may still be in flight):')
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
