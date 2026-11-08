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
 * (F-10). The rebuild is one native list per vendor; the cost is
 * paid once.
 *
 * **Title backfill.** A vendor can finish naming a session after the
 * projection row was bound (a DSH summary lands after the turn), so
 * placeholder titles are resolved from the owning vendor's store before
 * the reply. Only placeholders are written; a user rename is untouched.
 *
 * **Lazy validation.** At the end of the handler, a fire-and-forget
 * `validateLazy` re-checks rows older than `LAZY_VALIDATE_MS` against
 * the native stores; the wire reply is not blocked (F-8).
 */
import type { SessionInfo, SessionKind, VendorId, ModeToken } from '@ccc/shared/protocol'
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
import { MODE_CATALOGS, isKnownToken } from '../adapters/index.js'
import { accessorNativeList } from './native-list.js'
import { isPlaceholderTitle } from './placeholder-titles.js'
// eslint-disable-next-line no-restricted-imports
import {
  listForWorkspace,
  rebuildOne,
  updateRealRowTitle,
  upsertBoundRow,
  validateLazy,
  type SessionMetadataRow,
} from '../../../features/sessions/session-metadata-store.js'

/** Rollback escape hatch — default ON. Set `C3_LIST_FROM_PROJECTION=0` to roll back. */
const USE_PROJECTION = process.env.C3_LIST_FROM_PROJECTION !== '0'

/**
 * The real session kinds a requested display category covers. Only「规范」
 * aggregates: it lists spec authoring AND spec review sessions under one entry
 * (there is no separate review category). Rows keep their real `sessionKind` on
 * the wire, so selection and jump-to-source stay kind-accurate.
 */
export function sessionKindsForCategory(sessionKind: SessionKind): readonly SessionKind[] {
  return sessionKind === 'spec' ? ['spec', 'spec_review'] : [sessionKind]
}

/** All known vendor tags. The rebuild tries each; absent sources no-op. */
const KNOWN_VENDORS: readonly VendorId[] = ['claude', 'codex', 'dsh']

/**
 * Map a `SessionMetadataRow` to a wire `SessionInfo`. Looks up `mode` from
 * `state.ts` (per-session persisted mode), applies the additive `state`
 * field, defaults `lastModified` to 0 for Codex rows whose bind-time
 * `last_modified` is null (the next lazy validation will populate it).
 * Mode is gated to the row's vendor catalog so Cursor rows never expose a
 * bare Claude `'default'` that the title-bar dropdown cannot match.
 */
function listedModeForVendor(sessionId: string, vendor: VendorId): ModeToken {
  const mode = getSessionMode(sessionId)
  const cat = MODE_CATALOGS[vendor]
  if (cat && isKnownToken(cat, mode)) return mode
  return (cat?.defaultToken as ModeToken | undefined) ?? mode
}

function rowToSessionInfo(row: SessionMetadataRow): SessionInfo {
  const sessionId = row.vendorSessionId ?? row.c3Id
  return {
    sessionId,
    title: row.title,
    lastModified: row.lastModified ?? 0,
    mode: listedModeForVendor(sessionId, row.vendor),
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
 * The session list for a workspace. Reads the `session_metadata` projection
 * (default), falling back to the legacy claude-only `listWorkspaceSessions`
 * when `C3_LIST_FROM_PROJECTION=0`. Triggers a one-shot rebuild when the
 * projection is empty (F-10) and a fire-and-forget lazy validation at
 * the end of every call (F-8).
 *
 * `sessionKind` is the DISPLAY category the client asked for, which may cover
 * more than one real kind (`spec` also lists `spec_review` — see
 * {@link sessionKindsForCategory}). Aggregation happens in the projection query
 * so first page / load-more / refresh all see one global order; each row still
 * reports its own real kind on the wire.
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
  let rows = listForWorkspace(workspacePath, sessionKindsForCategory(sessionKind))
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

  // A vendor can write its accepted display name after the row was bound — a
  // DSH summary lands after the turn — so placeholders are resolved from the
  // native stores before this reply leaves. Only placeholder titles are
  // rewritten, so a user rename is never touched.
  await backfillPlaceholderTitles(accessor, workspacePath, rows)

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

/**
 * Resolve placeholder titles from the vendor-native stores before the list is
 * returned. The projection learns a title at bind / run end, but a vendor can
 * finish writing its accepted name after that (a DSH summary lands after the
 * turn), so a row would otherwise sit on the placeholder until the daily lazy
 * pass.
 *
 * Only placeholders are written (a user rename is never touched), only the
 * vendors that still have a placeholder are listed, and a vendor that cannot be
 * read leaves its rows alone rather than clearing them.
 */
async function backfillPlaceholderTitles(
  accessor: SessionAccessor,
  workspacePath: string,
  rows: SessionMetadataRow[],
): Promise<void> {
  const pending = new Map<VendorId, SessionMetadataRow[]>()
  for (const row of rows) {
    const sessionId = row.vendorSessionId
    if (!sessionId || !isPlaceholderTitle(row.title)) continue
    const group = pending.get(row.vendor) ?? []
    group.push(row)
    pending.set(row.vendor, group)
  }
  for (const [vendor, group] of pending) {
    const summaries = await accessor.listVendor(vendor, { cwd: workspacePath })
    if (!summaries) continue
    const titles = new Map(summaries.map((s) => [s.sessionId, s.title]))
    for (const row of group) {
      const sessionId = row.vendorSessionId
      if (!sessionId) continue
      const title = titles.get(sessionId)
      if (!title || isPlaceholderTitle(title)) continue
      updateRealRowTitle(sessionId, vendor, title)
      row.title = title
    }
  }
}

/** All visible business categories share one stable chronological order. */
export async function listGlobalWorkspaceSessions(
  accessor: SessionAccessor,
  workspacePath: string,
): Promise<SessionInfo[]> {
  const kinds: SessionKind[] = [
    'work',
    'intent',
    'spec',
    'discussion',
    'automation',
    'consensus',
    'robot',
  ]
  const pages = await Promise.all(
    kinds.map((kind) => listSessionsVia(accessor, workspacePath, kind)),
  )
  return [
    ...new Map(
      pages
        .flat()
        .filter((row) => !row.isToolSession && row.sessionKind !== 'tool')
        .map((row) => [row.sessionId, row]),
    ).values(),
  ].sort(
    (a, b) =>
      b.lastModified - a.lastModified ||
      (a.sessionId < b.sessionId ? 1 : a.sessionId > b.sessionId ? -1 : 0),
  )
}
