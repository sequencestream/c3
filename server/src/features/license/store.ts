// The c3-side entitlement cache — the single new persistent store ADR-0026
// accepts on the c3 side (product-license design § Entitlement cache). It holds
// the most recent LS-signed entitlement token plus the long-lived heartbeat
// bearer token, so restart continuity and the offline grace can work.
//
// The file carries a bearer credential (the heartbeat token), so it is written
// with restrictive permissions (0600 — owner read/write only), mirroring the
// secret-by-reference discipline of the auth settings file. It NEVER holds a
// signing key, OAuth secret, or payment credential (PL-R12) — only the embedded
// PUBLIC key (license-pubkey.ts) is needed to verify the cached token.
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { LicenseStatus } from '@ccc/shared/protocol'
import { c3HomeDir } from '../../kernel/config/index.js'
import { readJsonFile } from '../../kernel/config/store.js'
import { verifyEntitlementToken } from './token.js'

/** Restrictive mode for the entitlement cache: owner read/write only. */
export const LICENSE_FILE_MODE = 0o600

/**
 * The derived c3-side Entitlement state (product-license spec § States).
 * `Active`/`Grace` permit new sessions; the rest gate them. Heartbeat-driven
 * Grace/Revoked transitions land in the heartbeat task; this module derives the
 * baseline from the cached token's signature + validity window.
 */
export const ENTITLEMENT_STATES = ['unactivated', 'active', 'grace', 'expired', 'revoked'] as const
export type EntitlementState = (typeof ENTITLEMENT_STATES)[number]

/** What gets persisted to `~/.c3/license.json`. */
export interface LicenseCache {
  /** Stable per-installation id minted on first use; binds the entitlement. */
  installationId: string
  /** The bound license key (empty until activated); the c3<->LS API handle. */
  licenseKey: string
  /** Most recent LS-signed entitlement token (empty until activated). */
  entitlementToken: string
  /** Per-binding bearer credential presented on each heartbeat (PL-R2). */
  aliveToken: string
  plan: string
  state: EntitlementState
  /** License term end (unix seconds), surfaced for the badge/menu. */
  termEnd: number
  /** Last successful heartbeat (unix ms); null until the heartbeat task lands. */
  lastSuccessfulHeartbeat: number | null
  /** Last write time (unix ms). */
  updatedAt: number
}

function licenseFile(): string {
  return join(c3HomeDir(), 'license.json')
}

/** Exposed for tests/diagnostics: the resolved entitlement cache path. */
export function licenseFilePath(): string {
  return licenseFile()
}

function isCache(v: unknown): v is LicenseCache {
  if (typeof v !== 'object' || v === null) return false
  const c = v as Record<string, unknown>
  return typeof c.installationId === 'string' && typeof c.state === 'string'
}

/** Read the entitlement cache, or `undefined` if absent/corrupt. */
export function readLicenseCache(): LicenseCache | undefined {
  const raw = readJsonFile<unknown>(licenseFile())
  return isCache(raw) ? raw : undefined
}

/**
 * Atomically write the entitlement cache with 0600 permissions. The temp file is
 * created restricted from the start (no 0644 window), then renamed over the
 * target (rename preserves mode); a final chmod defends against a pre-existing
 * file with looser permissions.
 */
export function writeLicenseCache(cache: LicenseCache): void {
  const file = licenseFile()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: LICENSE_FILE_MODE })
  renameSync(tmp, file)
  chmodSync(file, LICENSE_FILE_MODE)
}

/**
 * Return the installation id, minting and persisting one (as an `unactivated`
 * cache) on first use so it is stable across restarts and activations.
 */
export function getOrCreateInstallationId(): string {
  const existing = readLicenseCache()
  if (existing?.installationId) return existing.installationId
  const installationId = randomUUID()
  writeLicenseCache({
    installationId,
    licenseKey: '',
    entitlementToken: '',
    aliveToken: '',
    plan: '',
    state: 'unactivated',
    termEnd: 0,
    lastSuccessfulHeartbeat: null,
    updatedAt: Date.now(),
  })
  return installationId
}

/**
 * Persist a freshly-activated entitlement: the verified token, the heartbeat
 * bearer token, and the derived `active` state. Caller has already verified the
 * token's signature; this records it and marks the last successful contact.
 */
export function saveActivation(args: {
  installationId: string
  licenseKey: string
  entitlementToken: string
  aliveToken: string
  plan: string
  termEnd: number
}): LicenseCache {
  const cache: LicenseCache = {
    installationId: args.installationId,
    licenseKey: args.licenseKey,
    entitlementToken: args.entitlementToken,
    aliveToken: args.aliveToken,
    plan: args.plan,
    state: 'active',
    termEnd: args.termEnd,
    lastSuccessfulHeartbeat: Date.now(),
    updatedAt: Date.now(),
  }
  writeLicenseCache(cache)
  return cache
}

/**
 * Derive the current entitlement from the cache by verifying the cached token
 * offline (PL-R5). Absent/unverifiable ⇒ `unactivated`; verified-but-expired ⇒
 * `expired`. The heartbeat-driven `grace`/`revoked` refinements are applied by
 * the heartbeat scheduler (separate task); this is the offline baseline.
 */
export function deriveEntitlement(
  cache: LicenseCache | undefined = readLicenseCache(),
  nowSeconds: number = Math.floor(Date.now() / 1000),
): { state: EntitlementState; installationId?: string } {
  if (!cache) return { state: 'unactivated' }
  if (cache.state === 'revoked') return { state: 'revoked', installationId: cache.installationId }
  if (!cache.entitlementToken) {
    return { state: 'unactivated', installationId: cache.installationId }
  }
  const res = verifyEntitlementToken(cache.entitlementToken, nowSeconds)
  if (!res.ok) {
    // Within window but unverifiable ⇒ deny-by-default; past window ⇒ expired.
    const state: EntitlementState =
      res.reason === 'outside validity window' ? 'expired' : 'unactivated'
    return { state, installationId: cache.installationId }
  }
  return { state: 'active', installationId: cache.installationId }
}

/**
 * The wire-facing license status surfaced to the console badge/menu (PL-R7).
 * A pure read: it derives state from the cache without minting an installation
 * id (that happens at activation start), so a status query never writes disk.
 */
export function currentLicenseStatus(
  nowSeconds: number = Math.floor(Date.now() / 1000),
): LicenseStatus {
  const cache = readLicenseCache()
  const { state } = deriveEntitlement(cache, nowSeconds)
  return {
    state,
    entitled: state === 'active' || state === 'grace',
    plan: cache?.plan ?? '',
    termEnd: cache?.termEnd ?? 0,
    installationId: cache?.installationId ?? '',
    licenseKey: cache?.licenseKey ?? '',
  }
}

/** Offline-grace window: stay entitled this long after the last success (PL-R4). */
export const GRACE_WINDOW_MS = 30 * 60 * 1000

/** A refreshed entitlement a successful heartbeat may carry. */
export interface HeartbeatRefresh {
  entitlementToken?: string
  plan?: string
  termEnd?: number
}

/**
 * Record a successful heartbeat: reset the grace deadline and cache any refreshed
 * token/plan/term (PL-R3). No-op (returns `undefined`) when there is no cache.
 */
export function recordHeartbeatSuccess(refresh: HeartbeatRefresh = {}): LicenseCache | undefined {
  const cache = readLicenseCache()
  if (!cache) return undefined
  const next: LicenseCache = {
    ...cache,
    entitlementToken: refresh.entitlementToken ?? cache.entitlementToken,
    plan: refresh.plan ?? cache.plan,
    termEnd: refresh.termEnd ?? cache.termEnd,
    state: 'active',
    lastSuccessfulHeartbeat: Date.now(),
    updatedAt: Date.now(),
  }
  writeLicenseCache(next)
  return next
}

/**
 * Record a definitive non-active heartbeat verdict (`revoked` covers both an
 * admin revocation and a license rebound to another installation — "disabled";
 * `expired` is a lapsed term, PL-R8). This is not grace-recoverable.
 */
export function recordHeartbeatLapse(
  state: Extract<EntitlementState, 'revoked' | 'expired'>,
): LicenseCache | undefined {
  const cache = readLicenseCache()
  if (!cache) return undefined
  if (cache.state === state) return cache
  const next: LicenseCache = { ...cache, state, updatedAt: Date.now() }
  writeLicenseCache(next)
  return next
}

/**
 * Apply the offline grace after a failed heartbeat (network down/LS unreachable
 * or a transient server error). Within 30 minutes of the last success c3 stays in
 * `grace` (new sessions allowed); past it the entitlement lapses to `expired`
 * (PL-R4). An unactivated cache is left untouched.
 */
export function recordHeartbeatFailure(nowMs: number = Date.now()): LicenseCache | undefined {
  const cache = readLicenseCache()
  if (!cache || !cache.entitlementToken || cache.state === 'revoked') return cache
  const within = nowMs - (cache.lastSuccessfulHeartbeat ?? 0) <= GRACE_WINDOW_MS
  const state: EntitlementState = within ? 'grace' : 'expired'
  if (cache.state === state) return cache
  const next: LicenseCache = { ...cache, state, updatedAt: Date.now() }
  writeLicenseCache(next)
  return next
}
