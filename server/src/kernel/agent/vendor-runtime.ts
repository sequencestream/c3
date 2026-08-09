/**
 * "Can c3 run this vendor right now" — answered once, for every vendor, in terms
 * every vendor can answer.
 *
 * Every vendor is backed by a host CLI that c3 resolves and spawns, so the
 * question reduces to whether that CLI resolved. What differs between vendors is
 * only *who distributes* the binary, which the provenance below reports and no
 * gate reads. Every caller that gates on availability (the settings snapshot, the
 * session agent switcher) reads the answer from here, which is what keeps them
 * from drifting apart or growing an `if (vendor === …)`.
 *
 * @module
 */
import { VENDOR_IDS } from '@ccc/shared/protocol'
import type { VendorId, VendorRuntimeOrigin, VendorRuntimeStatus } from '@ccc/shared/protocol'
import { isManagedVendor, probeAll, type VendorCliSource } from './process/launcher.js'

/**
 * How a resolution source reads as provenance. Sources that mean "nothing
 * resolved" map to nothing: an unavailable runtime has no copy to point at.
 */
const ORIGIN_BY_SOURCE: Partial<Record<VendorCliSource, VendorRuntimeOrigin>> = {
  'env-override': 'override',
  managed: 'installed',
  'host-path-fallback': 'host-path',
}

/**
 * Every vendor's runtime status, from the ProcessLauncher probe — exactly the
 * presence `hostStatus` reports, so CLI semantics are unchanged.
 *
 * A vendor with no registered host CLI is reported unavailable rather than
 * assumed runnable: an unregistered runtime is one nothing can launch.
 */
export function vendorRuntimeStatuses(): Record<VendorId, VendorRuntimeStatus> {
  const probes = new Map(probeAll().map((p) => [p.vendor, p]))
  const out = {} as Record<VendorId, VendorRuntimeStatus>
  for (const vendor of VENDOR_IDS) {
    const probe = isManagedVendor(vendor) ? probes.get(vendor) : undefined
    const available = probe ? probe.path !== null : false
    const origin = probe ? ORIGIN_BY_SOURCE[probe.source] : undefined
    out[vendor] = {
      vendor,
      available,
      runtime: 'host-cli',
      ...(probe ? { runtimeId: probe.binary } : {}),
      // Provenance travels with availability: "runnable" and "which copy" come
      // from one resolution, so the row can never name a binary the run will not
      // launch.
      ...(available && origin ? { origin } : {}),
      ...(available && probe?.path ? { location: probe.path } : {}),
      ...(available ? {} : { reason: 'host-cli-missing' as const }),
    }
  }
  return out
}

/**
 * The vendors that can run right now, as a set — the shape the agent-switcher
 * resolver takes.
 */
export function availableVendorSet(): Set<VendorId> {
  const statuses = vendorRuntimeStatuses()
  return new Set(VENDOR_IDS.filter((vendor) => statuses[vendor].available))
}
