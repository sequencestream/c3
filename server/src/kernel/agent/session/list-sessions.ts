/**
 * The cross-vendor `list_sessions` path (ADR-0013). Replaces the claude-only
 * `listWorkspaceSessions` on the wire by reading every available vendor's store
 * through one {@link SessionAccessor} and normalizing each entry back into the
 * wire {@link SessionInfo}.
 *
 * **Wire compatibility.** The emitted `SessionInfo.sessionId` is the vendor-NATIVE
 * id (pulled from the accessor's `vendorExtra.vendorSessionId`), NOT the opaque c3
 * id — the c3 namespace on the wire is an ADR-0013 deferred phase, and
 * `select_session`/`delete_session`/`rename_session` still round-trip the native
 * id. Only the new `vendor` *tag* is surfaced (a display dimension); the native
 * id never leaks cross-vendor as a top-level handle.
 *
 * **Zero-regression for claude.** The claude source resolves to
 * `ClaudeSessionStore.list` → `listWorkspaceSessions`, whose `vendorExtra` already
 * carries `lastModified`/`mode`/`isToolSession`. Mapping those straight back, plus
 * the global last-modified sort below, reproduces the old output byte-for-byte
 * (only the added `vendor: 'claude'` differs).
 */
import type { SessionInfo, PermissionMode } from '@ccc/shared/protocol'
import type { SessionAccessor, C3SessionSummary } from './accessor.js'

/** Permission modes c3 persists per session — used to narrow a `vendorExtra` read. */
const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'auto',
  'plan',
  'acceptEdits',
  'bypassPermissions',
]

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * The session's last-modified sort key, normalized per vendor:
 *  - claude carries `lastModified` (ms) directly (via `listWorkspaceSessions`);
 *  - opencode carries `time = { created, updated? }` (see `opencode/translate.ts`),
 *    so the most-recent of `updated`/`created` is the sort key.
 * Falls back to 0 when a vendor surfaces neither (sorts last).
 */
function lastModifiedOf(extra: Record<string, unknown>): number {
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

/** Narrow a `vendorExtra.mode` to a `PermissionMode`, defaulting to `default`. */
function modeOf(extra: Record<string, unknown>): PermissionMode {
  const mode = extra.mode
  return PERMISSION_MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : 'default'
}

/** Map one normalized accessor entry back to the wire `SessionInfo`. */
function toSessionInfo(s: C3SessionSummary): SessionInfo {
  const extra = s.vendorExtra ?? {}
  // The native vendor id the accessor tucked into vendorExtra — the wire id.
  const sessionId = typeof extra.vendorSessionId === 'string' ? extra.vendorSessionId : ''
  return {
    sessionId,
    title: s.title,
    lastModified: lastModifiedOf(extra),
    mode: modeOf(extra),
    isToolSession: extra.isToolSession === true,
    vendor: s.vendor,
  }
}

/**
 * List a workspace's sessions across every available vendor via the accessor,
 * normalized to {@link SessionInfo} and sorted newest-first (global, cross-vendor).
 */
export async function listSessionsVia(
  accessor: SessionAccessor,
  workspacePath: string,
): Promise<SessionInfo[]> {
  const summaries = await accessor.list({ cwd: workspacePath })
  return summaries.map(toSessionInfo).sort((a, b) => b.lastModified - a.lastModified)
}
