/*
 * useTabbedDraftSave — the shared Tab-grouped draft/save state machine behind the
 * system-settings and workspace-setting pages.
 *
 * A settings page splits one server object into tabs; each tab owns a whitelist of
 * fields, keeps its own draft, shows its own dirty marker and has its own Save.
 * Saving a tab overlays ONLY that tab's (transformed) fields onto the latest
 * committed snapshot, so one tab's Save never carries another tab's unsaved draft,
 * and pass-through fields the page has no control for survive the round trip.
 *
 * This composable owns the vendor-neutral parts of that contract — draft/committed
 * state, per-tab dirty derivation, the dirty-guarded tab switch, the save ordering
 * (build from committed → emit → optimistically fold the payload back into
 * committed) and the pushback reconcile. Everything page-specific — which fields a
 * tab owns, how a payload is normalized, which sub-fields keep syncing into a
 * protected dirty tab — enters through options, never through this file.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'

/**
 * A JSON deep clone that preserves the static type of its argument (a discriminated
 * union survives, unlike a shallow spread). Tolerant of Vue reactive proxies.
 */
export function deepCopy<T>(v: T): T {
  // `JSON.stringify(undefined)` yields `undefined` (not a string), which
  // `JSON.parse` chokes on — so pass an absent field straight through.
  if (v === undefined) return undefined as T
  return JSON.parse(JSON.stringify(v)) as T
}

/**
 * Structural value equality for dirty detection. Reads properties directly, which
 * unwraps Vue reactive proxies, so a draft slice can be compared to its baseline.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aArr = Array.isArray(a)
  if (aArr !== Array.isArray(b)) return false
  if (aArr) {
    const aa = a as unknown[]
    const bb = b as unknown[]
    if (aa.length !== bb.length) return false
    return aa.every((v, i) => deepEqual(v, bb[i]))
  }
  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  const bk = Object.keys(bo)
  if (ak.length !== bk.length) return false
  return ak.every((k) => k in bo && deepEqual(ao[k], bo[k]))
}

/**
 * Overwrite `target`'s `fields` with deep copies from `src`. The default way a tab
 * is (re)seeded and the way a just-saved payload folds back into the committed
 * baseline. Exported so a page's `reseedTab` override can still fall back to it.
 */
export function applyTabFields<S extends object>(
  target: S,
  src: S,
  fields: readonly (keyof S)[],
): void {
  const t = target as unknown as Record<string, unknown>
  const s = src as unknown as Record<string, unknown>
  for (const f of fields) {
    t[f as string] = deepCopy(s[f as string])
  }
}

export interface TabbedDraftSaveOptions<Tab extends string, S extends object> {
  /** The tab ids, in render order. */
  tabs: readonly Tab[]
  /**
   * Per tab, the exact fields it owns. This map is the single save whitelist: it
   * decides what a tab's Save overlays, what a reseed copies and (by default) what
   * dirty compares.
   */
  tabFields: Record<Tab, readonly (keyof S)[]>
  /** The tab shown before the user picks one. Defaults to `tabs[0]`. */
  initialTab?: Tab
  /** The placeholder value `draft`/`committed` hold before the first seed. */
  initial: () => S
  /**
   * Build the full object a tab's Save emits: `base` is a fresh deep copy of the
   * latest committed snapshot, to be overlaid with this tab's normalized draft
   * fields. Must never write back into `draft`. Returning `null` aborts the save
   * (no emit, no pending tab, no optimistic commit).
   */
  buildPayload: (tab: Tab, base: S, draft: S) => S | null
  /** Ship the built payload (the page's existing save emit). */
  onSave: (payload: S) => void
  /** Save permission gate; `false` ⇒ the save is dropped before anything happens. */
  canSave?: () => boolean
  /**
   * (Re)seed one tab's draft from a snapshot, overriding the default whitelist deep
   * copy — for a tab whose draft is a synthesized form of the stored value rather
   * than a verbatim copy.
   */
  reseedTab?: (tab: Tab, draft: S, seed: S) => void
  /**
   * The value a tab's dirty check compares, overriding the default whitelist slice
   * — for a tab that is dirty against its *transformed* save form rather than its
   * raw fields. Return `undefined` to fall back to the default.
   */
  dirtySlice?: (tab: Tab, value: S) => unknown
  /**
   * Sync a dirty (therefore draft-protected) tab's immediately-persisted sub-fields
   * from a pushback — values a dedicated server path already committed, which must
   * not wait for this tab's Save.
   */
  syncProtectedTab?: (tab: Tab, draft: S, seed: S) => void
}

export interface TabbedDraftSave<Tab extends string, S extends object> {
  /** The editable copy the tab controls bind to. */
  draft: Ref<S>
  /** The authoritative last-committed snapshot; save payloads and dirty derive from it. */
  committed: Ref<S>
  activeTab: Ref<Tab>
  /** The tab whose Save was emitted and whose server echo is awaited. */
  pendingSaveTab: Ref<Tab | null>
  /** A requested-but-unconfirmed switch away from a dirty tab (drives the confirm). */
  pendingTabSwitch: Ref<Tab | null>
  tabDirtyMap: ComputedRef<Record<Tab, boolean>>
  /** First open (or reopen): reset both snapshots wholesale from the server value. */
  seedAll: (seed: S) => void
  /** A pushback while open: merge by field ownership so unsaved drafts survive. */
  reconcile: (seed: S) => void
  requestTab: (tab: Tab) => void
  confirmTabSwitch: () => void
  cancelTabSwitch: () => void
  saveTab: (tab: Tab) => void
}

export function useTabbedDraftSave<Tab extends string, S extends object>(
  options: TabbedDraftSaveOptions<Tab, S>,
): TabbedDraftSave<Tab, S> {
  const { tabs, tabFields } = options

  const draft = ref(options.initial()) as Ref<S>
  const committed = ref(options.initial()) as Ref<S>
  const activeTab = ref(options.initialTab ?? tabs[0]) as Ref<Tab>
  const pendingSaveTab = ref<Tab | null>(null) as Ref<Tab | null>
  const pendingTabSwitch = ref<Tab | null>(null) as Ref<Tab | null>

  // The value a tab's dirty check compares: the page's transformed slice when it
  // provides one, else the tab's raw whitelist fields.
  function compareSlice(tab: Tab, value: S): unknown {
    const custom = options.dirtySlice?.(tab, value)
    if (custom !== undefined) return custom
    const v = value as unknown as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const f of tabFields[tab]) out[f as string] = v[f as string]
    return out
  }

  function tabDirtyAgainst(tab: Tab, baseline: S): boolean {
    return !deepEqual(compareSlice(tab, draft.value), compareSlice(tab, baseline))
  }

  function reseed(tab: Tab, seed: S): void {
    if (options.reseedTab) options.reseedTab(tab, draft.value, seed)
    else applyTabFields(draft.value, seed, tabFields[tab])
  }

  const tabDirtyMap = computed<Record<Tab, boolean>>(() => {
    const out = {} as Record<Tab, boolean>
    for (const tab of tabs) out[tab] = tabDirtyAgainst(tab, committed.value)
    return out
  })

  function seedAll(seed: S): void {
    committed.value = seed
    draft.value = deepCopy(seed)
    pendingSaveTab.value = null
  }

  // Dirty MUST be measured against the OLD committed snapshot: a tab counts as
  // protected because the user changed it since the last commit, not because the
  // incoming server value differs from their draft.
  function reconcile(seed: S): void {
    const prev = committed.value
    const wasDirty = {} as Record<Tab, boolean>
    for (const tab of tabs) wasDirty[tab] = tabDirtyAgainst(tab, prev)
    committed.value = seed
    const saved = pendingSaveTab.value
    pendingSaveTab.value = null
    for (const tab of tabs) {
      if (tab === saved || !wasDirty[tab]) reseed(tab, seed)
      else options.syncProtectedTab?.(tab, draft.value, seed)
    }
  }

  function saveTab(tab: Tab): void {
    if (options.canSave && !options.canSave()) return
    const payload = options.buildPayload(tab, deepCopy(committed.value), draft.value)
    if (!payload) return
    pendingSaveTab.value = tab
    options.onSave(payload)
    // Optimistically fold the just-saved tab into `committed` (this tab's fields,
    // exactly as emitted). Two reasons: (1) a second tab saved before this save's
    // echo builds its payload from the up-to-date snapshot instead of a stale one
    // that would silently revert this save; (2) the saved tab's dirty flag clears
    // now rather than lingering until the pushback. The pushback still reconciles
    // the saved tab to the server-normalized truth (see reconcile/pendingSaveTab).
    applyTabFields(committed.value, payload, tabFields[tab])
  }

  // Switch immediately if the current tab is clean; otherwise open a confirm. On
  // confirm we ONLY change tabs — the leaving tab's draft is neither saved nor
  // discarded, so returning to it shows the same unsaved edits.
  function requestTab(tab: Tab): void {
    if (tab === activeTab.value) return
    if (tabDirtyMap.value[activeTab.value]) {
      pendingTabSwitch.value = tab
    } else {
      activeTab.value = tab
    }
  }
  function confirmTabSwitch(): void {
    if (pendingTabSwitch.value) activeTab.value = pendingTabSwitch.value
    pendingTabSwitch.value = null
  }
  function cancelTabSwitch(): void {
    pendingTabSwitch.value = null
  }

  return {
    draft,
    committed,
    activeTab,
    pendingSaveTab,
    pendingTabSwitch,
    tabDirtyMap,
    seedAll,
    reconcile,
    requestTab,
    confirmTabSwitch,
    cancelTabSwitch,
    saveTab,
  }
}
