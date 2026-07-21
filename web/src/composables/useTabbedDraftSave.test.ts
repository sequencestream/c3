import { describe, it, expect, vi } from 'vitest'
import { nextTick } from 'vue'
import { useTabbedDraftSave, deepCopy, deepEqual, applyTabFields } from './useTabbedDraftSave'

// A miniature two-tab settings object standing in for SystemSettings /
// WorkspaceSetting: `alpha`/`nested` belong to tab a, `beta` to tab b, and
// `passthrough` belongs to no tab (the page has no control for it).
interface Demo {
  alpha: string
  nested: { deep: string[] }
  beta: number
  passthrough: string
}
type DemoTab = 'a' | 'b'
const TABS: DemoTab[] = ['a', 'b']
const TAB_FIELDS: Record<DemoTab, (keyof Demo)[]> = {
  a: ['alpha', 'nested'],
  b: ['beta'],
}

function demo(over: Partial<Demo> = {}): Demo {
  return {
    alpha: 'a0',
    nested: { deep: ['x'] },
    beta: 0,
    passthrough: 'keep-me',
    ...over,
  }
}

/** A composable instance with the default (whitelist) slice/reseed rules, seeded. */
function setup(over: Parameters<typeof useTabbedDraftSave<DemoTab, Demo>>[0] | null = null) {
  const onSave = vi.fn()
  const s = useTabbedDraftSave<DemoTab, Demo>({
    tabs: TABS,
    tabFields: TAB_FIELDS,
    initial: demo,
    onSave,
    // Overlay every one of the tab's fields verbatim — the simplest page transform.
    buildPayload: (tab, payload, src) => {
      applyTabFields(payload, src, TAB_FIELDS[tab])
      return payload
    },
    ...(over ?? {}),
  })
  s.seedAll(demo())
  return { ...s, onSave }
}

describe('deepCopy / deepEqual', () => {
  it('deepCopy passes an absent value straight through instead of choking on JSON', () => {
    expect(deepCopy(undefined)).toBeUndefined()
  })

  it('deepEqual compares structurally, including array length and key sets', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(deepEqual({ a: [1] }, { a: [1, 2] })).toBe(false)
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
  })
})

describe('useTabbedDraftSave — per-tab dirty state', () => {
  it('starts clean on every tab right after seeding', () => {
    const s = setup()
    expect(s.tabDirtyMap.value).toEqual({ a: false, b: false })
  })

  it('marks only the tab owning the edited field dirty', () => {
    const s = setup()
    s.draft.value.alpha = 'edited'
    expect(s.tabDirtyMap.value).toEqual({ a: true, b: false })
  })

  it('detects a nested, deep edit as dirty (not just top-level identity)', () => {
    const s = setup()
    s.draft.value.nested.deep.push('y')
    expect(s.tabDirtyMap.value.a).toBe(true)
  })

  it('ignores a field no tab owns — a passthrough edit dirties nothing', () => {
    const s = setup()
    s.draft.value.passthrough = 'changed'
    expect(s.tabDirtyMap.value).toEqual({ a: false, b: false })
  })

  it('uses the page dirtySlice when provided, so dirty means "saving would change something"', () => {
    // Tab a compares its trimmed alpha: whitespace-only edits are not dirty.
    const s = setup({
      tabs: TABS,
      tabFields: TAB_FIELDS,
      initial: demo,
      onSave: vi.fn(),
      buildPayload: (tab, payload, src) => {
        applyTabFields(payload, src, TAB_FIELDS[tab])
        return payload
      },
      dirtySlice: (tab, v) => (tab === 'a' ? { alpha: v.alpha.trim() } : undefined),
    })
    s.draft.value.alpha = '  a0  '
    expect(s.tabDirtyMap.value.a).toBe(false)
    s.draft.value.alpha = ' a1 '
    expect(s.tabDirtyMap.value.a).toBe(true)
  })
})

describe('useTabbedDraftSave — tab switch confirmation', () => {
  it('leaving a clean tab switches immediately, with no confirmation', () => {
    const s = setup()
    s.requestTab('b')
    expect(s.activeTab.value).toBe('b')
    expect(s.pendingTabSwitch.value).toBeNull()
  })

  it('leaving a dirty tab only records the request and opens the confirm', () => {
    const s = setup()
    s.draft.value.alpha = 'edited'
    s.requestTab('b')
    expect(s.activeTab.value).toBe('a')
    expect(s.pendingTabSwitch.value).toBe('b')
  })

  it('confirming switches without saving or discarding the leaving draft', () => {
    const s = setup()
    s.draft.value.alpha = 'edited'
    s.requestTab('b')
    s.confirmTabSwitch()
    expect(s.activeTab.value).toBe('b')
    expect(s.pendingTabSwitch.value).toBeNull()
    expect(s.onSave).not.toHaveBeenCalled()
    expect(s.draft.value.alpha).toBe('edited')
    expect(s.tabDirtyMap.value.a).toBe(true)
  })

  it('cancelling stays on the current tab and keeps the draft', () => {
    const s = setup()
    s.draft.value.alpha = 'edited'
    s.requestTab('b')
    s.cancelTabSwitch()
    expect(s.activeTab.value).toBe('a')
    expect(s.pendingTabSwitch.value).toBeNull()
    expect(s.draft.value.alpha).toBe('edited')
  })

  it('requesting the already-active tab is a no-op even when dirty', () => {
    const s = setup()
    s.draft.value.alpha = 'edited'
    s.requestTab('a')
    expect(s.pendingTabSwitch.value).toBeNull()
  })
})

describe('useTabbedDraftSave — per-tab save', () => {
  it('emits a full object carrying only this tab’s draft, with passthrough intact', () => {
    const s = setup()
    s.draft.value.alpha = 'edited'
    s.draft.value.beta = 42
    s.saveTab('a')
    const payload = s.onSave.mock.calls[0][0] as Demo
    expect(payload.alpha).toBe('edited')
    // Tab b's unsaved draft is NOT carried — the committed value is.
    expect(payload.beta).toBe(0)
    expect(payload.passthrough).toBe('keep-me')
  })

  it('clears the saved tab’s dirty flag immediately, before any pushback', () => {
    const s = setup()
    s.draft.value.alpha = 'edited'
    s.saveTab('a')
    expect(s.tabDirtyMap.value.a).toBe(false)
    expect(s.pendingSaveTab.value).toBe('a')
  })

  it('a second tab saved before the first echo builds on the first save’s values', () => {
    const s = setup()
    s.draft.value.alpha = 'edited'
    s.saveTab('a')
    s.draft.value.beta = 42
    s.saveTab('b')
    const second = s.onSave.mock.calls[1][0] as Demo
    expect(second.beta).toBe(42)
    // Without the optimistic commit this would revert to 'a0'.
    expect(second.alpha).toBe('edited')
  })

  it('the optimistic commit does not touch another tab’s draft', () => {
    const s = setup()
    s.draft.value.alpha = 'edited'
    s.draft.value.beta = 42
    s.saveTab('a')
    expect(s.draft.value.beta).toBe(42)
    expect(s.tabDirtyMap.value.b).toBe(true)
  })

  it('a rejected save gate emits nothing and advances neither pending nor committed', () => {
    const s = setup({
      tabs: TABS,
      tabFields: TAB_FIELDS,
      initial: demo,
      onSave: vi.fn(),
      buildPayload: (tab, payload, src) => {
        applyTabFields(payload, src, TAB_FIELDS[tab])
        return payload
      },
      canSave: () => false,
    })
    s.draft.value.alpha = 'edited'
    s.saveTab('a')
    expect(s.onSave).not.toHaveBeenCalled()
    expect(s.pendingSaveTab.value).toBeNull()
    expect(s.tabDirtyMap.value.a).toBe(true)
  })

  it('a null payload aborts the save the same way', () => {
    const s = setup({
      tabs: TABS,
      tabFields: TAB_FIELDS,
      initial: demo,
      onSave: vi.fn(),
      buildPayload: () => null,
    })
    s.draft.value.alpha = 'edited'
    s.saveTab('a')
    expect(s.onSave).not.toHaveBeenCalled()
    expect(s.pendingSaveTab.value).toBeNull()
    expect(s.tabDirtyMap.value.a).toBe(true)
  })

  it('emits the payload before folding it into committed, so a page mutating the echo cannot race', () => {
    const seen: string[] = []
    const s = setup()
    s.onSave.mockImplementation((p: Demo) => seen.push(p.alpha))
    s.draft.value.alpha = 'edited'
    s.saveTab('a')
    expect(seen).toEqual(['edited'])
    expect(s.committed.value.alpha).toBe('edited')
  })
})

describe('useTabbedDraftSave — pushback reconcile', () => {
  it('reseeds clean tabs and keeps a dirty tab’s draft', () => {
    const s = setup()
    s.draft.value.alpha = 'edited' // tab a dirty
    s.reconcile(demo({ alpha: 'server-a', beta: 9 }))
    expect(s.draft.value.alpha).toBe('edited')
    expect(s.draft.value.beta).toBe(9)
    expect(s.tabDirtyMap.value).toEqual({ a: true, b: false })
  })

  it('reseeds the just-saved tab from the server-normalized echo', () => {
    const s = setup()
    s.draft.value.alpha = 'edited'
    s.saveTab('a')
    // The server normalizes the value it accepted.
    s.reconcile(demo({ alpha: 'EDITED' }))
    expect(s.draft.value.alpha).toBe('EDITED')
    expect(s.tabDirtyMap.value.a).toBe(false)
    expect(s.pendingSaveTab.value).toBeNull()
  })

  it('measures dirty against the OLD committed snapshot, not the incoming seed', () => {
    // Tab a is clean but the server changed it: it must follow the server, not be
    // mistaken for a protected dirty draft because draft ≠ seed.
    const s = setup()
    s.reconcile(demo({ alpha: 'server-a' }))
    expect(s.draft.value.alpha).toBe('server-a')
  })

  it('syncs a protected dirty tab’s immediate-persist sub-fields only', () => {
    const s = setup({
      tabs: TABS,
      tabFields: TAB_FIELDS,
      initial: demo,
      onSave: vi.fn(),
      buildPayload: (tab, payload, src) => {
        applyTabFields(payload, src, TAB_FIELDS[tab])
        return payload
      },
      // `nested` is persisted by a dedicated path, so it keeps following the server
      // even while the rest of tab a stays dirty.
      syncProtectedTab: (tab, target, seed) => {
        if (tab === 'a') target.nested = deepCopy(seed.nested)
      },
    })
    s.draft.value.alpha = 'edited'
    s.reconcile(demo({ alpha: 'server-a', nested: { deep: ['x', 'y'] } }))
    expect(s.draft.value.alpha).toBe('edited')
    expect(s.draft.value.nested.deep).toEqual(['x', 'y'])
  })

  it('uses the page reseedTab override when a tab’s draft is synthesized', () => {
    const s = setup({
      tabs: TABS,
      tabFields: TAB_FIELDS,
      initial: demo,
      onSave: vi.fn(),
      buildPayload: (tab, payload, src) => {
        applyTabFields(payload, src, TAB_FIELDS[tab])
        return payload
      },
      reseedTab: (tab, target, seed) => {
        if (tab === 'b') target.beta = seed.beta * 2
        else applyTabFields(target, seed, TAB_FIELDS[tab])
      },
    })
    s.reconcile(demo({ beta: 5 }))
    expect(s.draft.value.beta).toBe(10)
  })
})

describe('useTabbedDraftSave — seeding', () => {
  it('seedAll resets both snapshots and clears any awaited echo', () => {
    const s = setup()
    s.draft.value.alpha = 'edited'
    s.saveTab('a')
    s.seedAll(demo({ alpha: 'reopened' }))
    expect(s.draft.value.alpha).toBe('reopened')
    expect(s.committed.value.alpha).toBe('reopened')
    expect(s.pendingSaveTab.value).toBeNull()
    expect(s.tabDirtyMap.value).toEqual({ a: false, b: false })
  })

  it('the draft is an independent copy — editing it never mutates committed', async () => {
    const s = setup()
    s.draft.value.nested.deep.push('y')
    await nextTick()
    expect(s.committed.value.nested.deep).toEqual(['x'])
  })
})
