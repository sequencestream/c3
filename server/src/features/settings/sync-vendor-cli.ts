/**
 * Manual npm-managed vendor CLI download / update check.
 *
 * The startup background refresh already syncs every managed CLI on a 24h
 * cooldown, but that leaves no retry entry for a first download that failed on
 * network, permissions or `npm install` — the panel just shows the failure and
 * the user is stuck inside the cooldown window. This handler is that retry: it
 * calls the same full sync directly, bypassing the cooldown by construction
 * (the cooldown gate `shouldCheckRemote` is only read by the background path).
 *
 * Narrow by design: the client names only a `vendor`, never a package/version/URL,
 * and only an npm-managed vendor is accepted — the server's whitelist decides what
 * may be fetched. A non-managed vendor (e.g. cursor) is refused with no reply at
 * all (the console never renders a button for it, so no in-flight flag can dangle).
 *
 * Concurrent same-vendor triggers are merged: a later request while a sync is in
 * flight waits for that same outcome instead of starting a duplicate download.
 */
import type { VendorId } from '@ccc/shared/protocol'
import {
  isNpmManagedVendor,
  readVendorCliStatus,
  recordVendorCliSyncError,
  syncManagedVendorCli,
  type VendorCliStatus,
} from '../../kernel/agent/process/launcher.js'
import { loadSettings } from '../../kernel/config/index.js'
import type { Handler } from '../../transport/handler-registry.js'
import { requireAdmin } from '../auth/authz.js'
import { settingsFrame } from './index.js'

/** The outcome of one sync, decoupled from any connection so concurrent waiters
 *  each get their own `settings` + result frames off the same shared run. */
interface SyncOutcome {
  ok: boolean
  version?: string
  installed?: boolean
  error?: string
}

/**
 * Whether a sync actually materialised/upgraded a version on disk: the download
 * target advanced, OR the installed list gained a version (covers "downloaded last
 * time but the install never completed, now finished"). Compared against the
 * manifest, never guessed by the console.
 */
function syncInstalled(before: VendorCliStatus, after: VendorCliStatus): boolean {
  if (after.downloadTargetVersion && after.downloadTargetVersion !== before.downloadTargetVersion) {
    return true
  }
  const beforeVersions = new Set(before.installedVersions.map((v) => v.version))
  return after.installedVersions.some((v) => !beforeVersions.has(v.version))
}

/** Run one sync and fold its result into a connection-agnostic outcome. Never
 *  rejects: the thrown path is caught and recorded, matching the internal
 *  `managedError` path so both produce `ok: false` with a panel-readable reason. */
function runVendorCliSync(vendor: VendorId): Promise<SyncOutcome> {
  const before = readVendorCliStatus(vendor)
  return syncManagedVendorCli(vendor)
    .then((probe) => {
      const after = readVendorCliStatus(vendor)
      const ok = probe.managedError === undefined
      return {
        ok,
        ...(after.downloadTargetVersion ? { version: after.downloadTargetVersion } : {}),
        ...(ok
          ? { installed: syncInstalled(before, after) }
          : { error: after.lastError ?? probe.managedError }),
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      recordVendorCliSyncError(vendor, message)
      const after = readVendorCliStatus(vendor)
      return {
        ok: false,
        ...(after.downloadTargetVersion ? { version: after.downloadTargetVersion } : {}),
        error: after.lastError ?? message,
      }
    })
}

/** In-flight syncs, keyed by vendor — the same-vendor concurrency merge. */
const inflight = new Map<VendorId, Promise<SyncOutcome>>()

export const syncVendorCliHandler: Handler<'sync_vendor_cli'> = async (_ctx, conn, msg) => {
  // System configuration mutation — behind the same gate as `save_settings`.
  if (!requireAdmin(conn)) return
  // Only npm-managed vendors may enter the download path; refuse silently so the
  // console (which renders no button for such a vendor) never holds a dangling flag.
  if (!isNpmManagedVendor(msg.vendor)) return

  let outcome = inflight.get(msg.vendor)
  if (!outcome) {
    outcome = runVendorCliSync(msg.vendor)
    inflight.set(msg.vendor, outcome)
    void outcome.finally(() => {
      if (inflight.get(msg.vendor) === outcome) inflight.delete(msg.vendor)
    })
  }
  const result = await outcome

  // Order matters: the panel must refresh its status (download target, installed
  // versions, lastError) before the toast that explains the outcome lands.
  conn.send(settingsFrame(loadSettings()))
  conn.send({ type: 'vendor_cli_sync_result', vendor: msg.vendor, ...result })
}
