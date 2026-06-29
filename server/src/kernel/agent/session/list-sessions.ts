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
import type { SessionInfo, SessionKind, VendorId } from '@ccc/shared/protocol'
import type { SessionAccessor } from './accessor.js'
// ADR-0009 R1 exception: the daily `list_sessions` read path needs the
// projection store (features/works) and the hidden-set filter
// (features/intents). The boundary is justified because the read
// path IS the composition point for the projection — it lives in the
// kernel only because the WS handler routes through it.
// eslint-disable-next-line no-restricted-imports
import {
  isToolSessionRecorded,
  listToolSessionIds,
  listHiddenSessions,
  listSpecSessionIds,
} from '../../../features/intents/store.js'
import { getSessionAgentId, getShowToolSessions } from '../../config/index.js'
import { getDefaultAgentId } from '../../agent-config/index.js'
import { getSessionMode } from '../../../state.js'
import { listWorkspaceSessions } from '../../../sessions.js'
import { isRunning } from '../../../runs.js'
// eslint-disable-next-line no-restricted-imports
import {
  listForWorkspace,
  rebuildOne,
  updateRealRowTitle,
  upsertBoundRow,
  validateLazy,
  type NativeListFn,
  type SessionMetadataRow,
} from '../../../features/sessions/session-metadata-store.js'

/** Rollback escape hatch — default ON. Set `C3_LIST_FROM_PROJECTION=0` to roll back. */
const USE_PROJECTION = process.env.C3_LIST_FROM_PROJECTION !== '0'

/** All known vendor tags. The rebuild tries each; absent sources no-op. */
const KNOWN_VENDORS: readonly VendorId[] = ['claude', 'codex']

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * The session's last-modified sort key, normalized per vendor (used by the
 * OFF path / rebuild path; the projection's `last_modified` is already ms).
 *  - claude carries `lastModified` (ms) directly (via `listWorkspaceSessions`);
 *  - future vendors may carry `time = { created, updated? }`, where the
 *    most-recent of `updated`/`created` is the sort key.
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
    sessionKind: row.sessionKind,
    ownerKind: row.ownerKind,
    ownerId: row.ownerId,
    bound: row.bound,
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
    // Codex was previously skipped here (no listing API); the 2026-06-08
    // `CodexSessionStore.list()` implementation reads `~/.codex/sessions/`
    // JSONL files directly, so enumeration now works.
    try {
      const summaries = await accessor.list({ cwd: workspacePath })
      return {
        sessions: summaries
          .filter((s) => s.vendor === vendor)
          .map((s) => {
            const extra = s.vendorExtra ?? {}
            const vsid =
              typeof extra.vendorSessionId === 'string' ? extra.vendorSessionId : s.c3SessionId
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
  sessionKind: SessionKind = 'work',
): Promise<SessionInfo[]> {
  if (!USE_PROJECTION) {
    return sessionKind === 'work' ? listWorkspaceSessions(workspacePath) : []
  }
  // Read the projection for this workspace. Pending rows are excluded
  // (the SQL filter is on `kind='real'`).
  let rows = listForWorkspace(workspacePath, sessionKind)
  if (rows.length === 0 && sessionKind === 'work') {
    // Rebuild path (F-10): the projection is empty for this workspace.
    // Rebuild from the accessor + the `sessionAgents` fact map. Codex is
    // enumerable via its local JSONL session store, so it participates in
    // the same one-shot rebuild as Claude.
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
    rows = listForWorkspace(workspacePath, sessionKind)
  }
  if (rows.length === 0 && sessionKind === 'tool' && getShowToolSessions()) {
    await rebuildToolProjectionFromNative(accessor, workspacePath)
    rows = listForWorkspace(workspacePath, sessionKind)
  }

  // Apply the filter parity (hidden set + tool-session filter) and stamp
  // the `mode` / `state` fields. Sort newest-first; nulls (Codex
  // bind-time) sort last. Intent/spec comm sessions are hidden only from
  // the work tab; their own unified tabs must read the projection rows.
  const hidden =
    sessionKind === 'work'
      ? new Set([...listHiddenSessions(workspacePath), ...listSpecSessionIds(workspacePath)])
      : new Set<string>()
  const showTool = getShowToolSessions()
  if (sessionKind === 'tool' && !showTool) return []
  const out = rows
    .map((r) => rowToSessionInfo(r))
    .filter((s) => !hidden.has(s.sessionId))
    .filter((s) => sessionKind === 'tool' || showTool || !s.isToolSession)
    .sort((a, b) => {
      if (a.lastModified === 0 && b.lastModified === 0) return 0
      if (a.lastModified === 0) return 1
      if (b.lastModified === 0) return -1
      return b.lastModified - a.lastModified
    })

  // Fire-and-forget lazy validation (F-8). The wire reply is not blocked;
  // the validation rewrites stale rows in place.
  void runLazyValidation(workspacePath, accessor)
  // Fire-and-forget title sync: running sessions whose projection title is
  // still a default placeholder get their real SDK-derived title written back
  // to the projection table. The wire reply is not blocked (F-8).
  void syncRunningTitles(workspacePath, accessor, out)
  return out
}

async function rebuildToolProjectionFromNative(
  accessor: SessionAccessor,
  workspacePath: string,
): Promise<void> {
  const toolIds = new Set(listToolSessionIds())
  if (toolIds.size === 0) return
  const nativeList = accessorNativeList(accessor)
  const defaultAgentId = getDefaultAgentId()
  const factAgentId = (vendorSessionId: string): string =>
    getSessionAgentId(vendorSessionId) ?? defaultAgentId
  for (const vendor of KNOWN_VENDORS) {
    const native = await nativeList(vendor, workspacePath)
    if (!native) continue
    for (const s of native.sessions) {
      if (!toolIds.has(s.vendorSessionId)) continue
      upsertBoundRow({
        sessionId: s.vendorSessionId,
        workspacePath,
        vendor,
        agentId: factAgentId(s.vendorSessionId),
        title: s.title,
        lastModified: s.lastModified,
        sessionKind: 'tool',
        ownerKind: null,
        ownerId: null,
      })
    }
  }
}

async function runLazyValidation(workspacePath: string, accessor: SessionAccessor): Promise<void> {
  try {
    await validateLazy({ workspacePath, nativeList: accessorNativeList(accessor) })
  } catch (err) {
    console.error('[c3] lazy validation failed:', err)
  }
}

/** Default placeholder titles that the projection table uses before the SDK
 * derives a real title (from the first prompt or auto-summary). Sessions with
 * these titles are candidates for the background title sync. */
const DEFAULT_PLACEHOLDER_TITLES = new Set(['New session', 'Untitled session'])

/**
 * Fire-and-forget background sync (F-8). For running sessions whose projection
 * title is still a default placeholder ("New session" or "Untitled session"),
 * query the native SDK list via the accessor and, when a real title exists,
 * write it back to the projection table via `updateRealRowTitle`.
 *
 * This bridges the gap between the projection table (updated only at bind time
 * and on explicit `rename_session`) and the SDK's auto-derived title (which
 * populates after the first interaction). The next list refresh reads the
 * updated projection and shows the correct title.
 *
 * Constraints:
 *  - Only running sessions are checked (no runtime → no title to sync).
 *  - Only default placeholder titles are overwritten (user-renamed sessions
 *    are untouched).
 *  - An empty or absent native title is never written back (don't replace a
 *    placeholder with nothing).
 *  - Errors are caught and logged, never propagated.
 *  - The wire reply is not blocked (the caller fires this with `void`).
 */
async function syncRunningTitles(
  workspacePath: string,
  accessor: SessionAccessor,
  sessions: SessionInfo[],
): Promise<void> {
  try {
    const summaries = await accessor.list({ cwd: workspacePath })
    if (!summaries.length) return

    // Build a map keyed by the wire sessionId (vendor-native id when present,
    // falling back to the c3 digest for unbound sessions).
    const nativeTitles = new Map<string, string>()
    for (const s of summaries) {
      const vsid = s.vendorExtra?.vendorSessionId
      const key = typeof vsid === 'string' && vsid ? vsid : s.c3SessionId
      // Only store non-empty titles (empty would overwrite a placeholder with
      // nothing, which is worse than keeping the placeholder).
      if (s.title) nativeTitles.set(key, s.title)
    }

    for (const s of sessions) {
      // Condition 1: the session must have a live runtime (the SDK's
      // auto-title only appears after the first interaction, which implies a
      // running session).
      if (!isRunning(s.sessionId)) continue
      // Condition 2: the projection title must still be a default placeholder
      // (otherwise the user or a previous sync has already set a real title).
      if (!DEFAULT_PLACEHOLDER_TITLES.has(s.title)) continue

      const nativeTitle = nativeTitles.get(s.sessionId)
      // Condition 3: the native title must exist, be non-empty, and be a real
      // title (not another placeholder) — otherwise there's nothing useful to
      // write back.
      if (!nativeTitle || DEFAULT_PLACEHOLDER_TITLES.has(nativeTitle)) continue

      updateRealRowTitle(s.sessionId, s.vendor, nativeTitle)
    }
  } catch (err) {
    console.error('[c3] sync running session titles failed:', err)
  }
}
