/**
 * The cross-vendor `list_sessions` path (ADR-0013). Replaces the claude-only
 * `listWorkspaceSessions` on the wire by reading the `session_metadata`
 * projection table in c3.db (F-1, F-10). The accessor union stays the
 * rebuild / lazy-validation source; the daily read path is one SQL query.
 *
 * **Wire compatibility.** The emitted `SessionInfo.sessionId` is the
 * vendor-NATIVE id (the c3 id on the wire is a deferred ADR-0013 phase),
 * and the new `state` field is additive (clients that don't know it
 * ignore it). The `mode` lookup still hits `state.ts`'s per-session map;
 * the `isToolSession` / `isHiddenSession` filters are applied here, not
 * in the row (filter parity with the legacy claude path).
 *
 * **Env-flag rollback.** `C3_LIST_FROM_PROJECTION` defaults ON. Set to `0`
 * to roll back to the legacy `listWorkspaceSessions` (claude-only) path
 * — the analogue of `C3_SESSION_LIST_ACCESSOR=0` from the accessor swap.
 *
 * **Rebuild path.** When the projection is empty for a workspace (a
 * fresh install or a deleted table), the read path transparently
 * rebuilds from the accessor + `sessionAgents` facts and then re-reads
 * (F-10). The rebuild is one synchronous accessor list; the cost is
 * paid once.
 *
 * **Lazy validation.** At the end of the handler, a fire-and-forget
 * `validateLazy` re-checks rows older than `LAZY_VALIDATE_MS` against
 * the native stores; the wire reply is not blocked (F-8).
 */
import type { SessionInfo, VendorId } from '@ccc/shared/protocol'
import type { SessionAccessor } from './accessor.js'
// ADR-0009 R1 exception: the daily `list_sessions` read path needs the
// projection store (features/sessions) and the hidden-set filter
// (features/requirements). The boundary is justified because the read
// path IS the composition point for the projection — it lives in the
// kernel only because the WS handler routes through it.
// eslint-disable-next-line no-restricted-imports
import { isToolSessionRecorded, listHiddenSessions } from '../../../features/requirements/store.js'
import { getSessionAgentId, getShowToolSessions } from '../../config/index.js'
import { getDefaultAgentId } from '../../agent-config/index.js'
import { getSessionMode } from '../../../state.js'
import { listWorkspaceSessions } from '../../../sessions.js'
// eslint-disable-next-line no-restricted-imports
import {
  listForWorkspace,
  rebuildOne,
  validateLazy,
  type NativeListFn,
  type SessionMetadataRow,
} from '../../../features/sessions/store.js'

/** Rollback escape hatch — default ON. Set `C3_LIST_FROM_PROJECTION=0` to roll back. */
const USE_PROJECTION = process.env.C3_LIST_FROM_PROJECTION !== '0'

/** All known vendor tags. The rebuild tries each; absent sources no-op. */
const KNOWN_VENDORS: readonly VendorId[] = ['claude', 'codex', 'opencode']

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * The session's last-modified sort key, normalized per vendor (used by the
 * OFF path / rebuild path; the projection's `last_modified` is already ms).
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

/**
 * Map a `SessionMetadataRow` to a wire `SessionInfo`. Looks up `mode` from
 * `state.ts` (per-session persisted mode), applies the additive `state`
 * field, defaults `lastModified` to 0 for Codex rows whose bind-time
 * `last_modified` is null (the next lazy validation will populate it).
 */
function rowToSessionInfo(row: SessionMetadataRow): SessionInfo {
  const sessionId = row.vendorSessionId ?? row.c3Id
  return {
    sessionId,
    title: row.title,
    lastModified: row.lastModified ?? 0,
    mode: getSessionMode(sessionId),
    isToolSession: isToolSessionRecorded(sessionId),
    vendor: row.vendor,
    state: row.state,
  }
}

/**
 * Build a `NativeListFn` from the accessor's per-vendor normalization. The
 * accessor lists everything; we filter per-vendor here so the rebuild /
 * lazy validation call the right store without the accessor having to
 * expose its sources.
 */
function accessorNativeList(accessor: SessionAccessor): NativeListFn {
  return async (vendor, workspacePath) => {
    if (vendor === 'codex') return null
    try {
      const summaries = await accessor.list({ cwd: workspacePath })
      return {
        sessions: summaries
          .filter((s) => s.vendor === vendor)
          .map((s) => {
            const extra = s.vendorExtra ?? {}
            const vsid = typeof extra.vendorSessionId === 'string' ? extra.vendorSessionId : ''
            return {
              vendorSessionId: vsid,
              title: s.title,
              lastModified: lastModifiedOf(extra),
            }
          }),
      }
    } catch (err) {
      console.error(`[c3] list: native list failed for ${vendor}:`, err)
      return null
    }
  }
}

/**
 * The session list for a workspace. Reads the `session_metadata` projection
 * (default), falling back to the legacy claude-only `listWorkspaceSessions`
 * when `C3_LIST_FROM_PROJECTION=0`. Triggers a one-shot rebuild when the
 * projection is empty (F-10) and a fire-and-forget lazy validation at
 * the end of every call (F-8).
 */
export async function listSessionsVia(
  accessor: SessionAccessor,
  workspacePath: string,
): Promise<SessionInfo[]> {
  if (!USE_PROJECTION) {
    return listWorkspaceSessions(workspacePath)
  }
  // Read the projection for this workspace. Pending rows are excluded
  // (the SQL filter is on `kind='real'`).
  let rows = listForWorkspace(workspacePath)
  if (rows.length === 0) {
    // Rebuild path (F-10): the projection is empty for this workspace.
    // Rebuild from the accessor + the `sessionAgents` fact map (Codex is
    // NOT enumerable, so the caller's fact list is the source — but
    // `rebuildOne` no-ops on Codex; the bind-time writes have already
    // populated Codex rows via `upsertForBind`).
    const nativeList = accessorNativeList(accessor)
    // Rebuild source-of-truth ordering (F-10): the per-vendor native list
    // is the primary source; the agent id comes from `sessionAgents` when
    // a fact exists, otherwise the default agent (a session with no
    // explicit binding just runs on the default — same behavior as
    // `resolveSessionLaunch`).
    const defaultAgentId = getDefaultAgentId()
    const factAgentId = (vendorSessionId: string): string =>
      getSessionAgentId(vendorSessionId) ?? defaultAgentId
    for (const vendor of KNOWN_VENDORS) {
      await rebuildOne({
        workspacePath,
        vendor,
        agentIdFor: factAgentId,
        nativeList,
      })
    }
    rows = listForWorkspace(workspacePath)
  }

  // Apply the filter parity (hidden set + tool-session filter) and stamp
  // the `mode` / `state` fields. Sort newest-first; nulls (Codex
  // bind-time) sort last.
  const hidden = new Set(listHiddenSessions(workspacePath))
  const showTool = getShowToolSessions()
  const out = rows
    .map((r) => rowToSessionInfo(r))
    .filter((s) => !hidden.has(s.sessionId))
    .filter((s) => showTool || !s.isToolSession)
    .sort((a, b) => {
      if (a.lastModified === 0 && b.lastModified === 0) return 0
      if (a.lastModified === 0) return 1
      if (b.lastModified === 0) return -1
      return b.lastModified - a.lastModified
    })

  // Fire-and-forget lazy validation (F-8). The wire reply is not blocked;
  // the validation rewrites stale rows in place.
  void runLazyValidation(workspacePath, accessor)
  return out
}

async function runLazyValidation(workspacePath: string, accessor: SessionAccessor): Promise<void> {
  try {
    await validateLazy({ workspacePath, nativeList: accessorNativeList(accessor) })
  } catch (err) {
    console.error('[c3] lazy validation failed:', err)
  }
}
