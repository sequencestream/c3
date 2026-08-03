/**
 * "Can c3 run this vendor right now" — answered once, for every vendor, in terms
 * every vendor can answer.
 *
 * c3 backs its vendors with two different kinds of runtime: a host CLI it
 * resolves and spawns, and an SDK that ships inside c3 and executes in the server
 * process. Asking the CLI probe alone therefore stopped being a valid
 * availability test the moment the second kind existed — an in-process runtime
 * has no binary to be "on PATH", so a CLI-shaped question answers `false` for a
 * perfectly healthy vendor.
 *
 * The two registries this module reads — the launcher's `HOST_BINARIES` and the
 * adapters' `EMBEDDED_RUNTIME_PROBES` — partition {@link VENDOR_IDS} between
 * them, so applying that split IS the answer. Every caller that gates on
 * availability (the settings snapshot, the session agent switcher) reads it from
 * here, which is what keeps them from drifting apart or growing an
 * `if (vendor === …)`.
 */
import { VENDOR_IDS } from '@ccc/shared/protocol'
import type { VendorId, VendorRuntimeStatus } from '@ccc/shared/protocol'
import { EMBEDDED_RUNTIME_PROBES } from './adapters/index.js'
import { isManagedVendor, probeAll } from './process/launcher.js'

/**
 * Every vendor's runtime status. Host-CLI vendors answer from the ProcessLauncher
 * probe — exactly the presence `hostStatus` reports, so CLI semantics are
 * unchanged; embedded-runtime vendors answer from their own module probe, the
 * same one `server.ts` gates adapter construction on at startup.
 *
 * A vendor in neither registry is reported unavailable rather than assumed
 * runnable: an unregistered runtime is one nothing can launch.
 */
export function vendorRuntimeStatuses(): Record<VendorId, VendorRuntimeStatus> {
  const probes = new Map(probeAll().map((p) => [p.vendor, p]))
  const out = {} as Record<VendorId, VendorRuntimeStatus>
  for (const vendor of VENDOR_IDS) {
    if (isManagedVendor(vendor)) {
      const probe = probes.get(vendor)
      const available = probe ? probe.path !== null : false
      out[vendor] = {
        vendor,
        available,
        runtime: 'host-cli',
        ...(probe ? { runtimeId: probe.binary } : {}),
        ...(available ? {} : { reason: 'host-cli-missing' as const }),
      }
      continue
    }
    const spec = EMBEDDED_RUNTIME_PROBES[vendor]
    const available = spec?.available() ?? false
    out[vendor] = {
      vendor,
      available,
      runtime: 'embedded-sdk',
      ...(spec ? { runtimeId: spec.module } : {}),
      ...(available ? {} : { reason: 'sdk-unresolved' as const }),
    }
  }
  return out
}

/**
 * The vendors that can run right now, as a set — the shape the agent-switcher
 * resolver takes. Reading it from {@link vendorRuntimeStatuses} rather than from
 * the CLI probe is what stops a session bound to an SDK-backed vendor being
 * reported as "current agent unavailable" while it is happily running.
 */
export function availableVendorSet(): Set<VendorId> {
  const statuses = vendorRuntimeStatuses()
  return new Set(VENDOR_IDS.filter((vendor) => statuses[vendor].available))
}
