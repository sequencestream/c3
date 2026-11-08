/**
 * The single adapter from the accessor's per-vendor listing to the projection
 * store's native-list contract.
 *
 * The projection repair paths (rebuild, lazy validation, janitor, title
 * backfill) all need "this vendor's current sessions". Funnelling them through
 * here keeps three properties in one place:
 *
 *  - one native listing per vendor, never a full cross-vendor scan per vendor;
 *  - `null` means the vendor could not be read, which is NOT an empty vendor —
 *    the projection must not treat a read failure as "those sessions are gone";
 *  - the native id stays `vendorSessionId`, with the per-vendor sort key
 *    normalized to one `lastModified`.
 */
import type { SessionAccessor } from './accessor.js'
// The projection store owns the contract type; the kernel only consumes its
// shape. This is the same one-way features import the list path already carries.
// eslint-disable-next-line no-restricted-imports
import type { NativeListFn } from '../../../features/sessions/session-metadata-store.js'

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * The session's last-modified sort key, normalized per vendor.
 *  - claude carries `lastModified` (ms) directly;
 *  - other vendors may carry `time = { created, updated? }`, where the
 *    most-recent of `updated`/`created` is the sort key.
 * Falls back to 0 when a vendor surfaces neither (sorts last).
 */
export function lastModifiedOf(extra: Record<string, unknown>): number {
  const direct = num(extra.lastModified)
  if (direct !== undefined) return direct
  const time = extra.time as { created?: unknown; updated?: unknown } | undefined
  if (time) {
    const updated = num(time.updated)
    if (updated !== undefined) return updated
    const created = num(time.created)
    if (created !== undefined) return created
  }
  return 0
}

/**
 * One vendor's native sessions in the shape the projection store consumes.
 * `null` propagates a vendor read failure; the caller decides whether that
 * pass should be skipped or recorded as unverifiable.
 */
export function accessorNativeList(accessor: SessionAccessor): NativeListFn {
  return async (vendor, workspacePath) => {
    let summaries
    try {
      summaries = await accessor.listVendor(vendor, { cwd: workspacePath })
    } catch (err) {
      console.error(`[c3] native list failed for ${vendor}:`, err)
      return null
    }
    if (summaries === null) {
      // The accessor already logged the cause; propagate the contract.
      return null
    }
    return {
      sessions: summaries.map((s) => {
        const extra = s.vendorExtra ?? {}
        const nativeId =
          typeof extra.vendorSessionId === 'string' ? extra.vendorSessionId : s.sessionId
        return {
          vendorSessionId: nativeId,
          title: s.title,
          lastModified: lastModifiedOf(extra),
        }
      }),
    }
  }
}
