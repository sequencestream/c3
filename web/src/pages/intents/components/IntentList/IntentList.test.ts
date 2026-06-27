import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Intent } from '@ccc/shared/protocol'
import IntentList from './IntentList.vue'

function installMatchMedia(width: number): void {
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
    const maxWidth = /max-width:\s*(\d+)px/.exec(query)?.[1]
    const minWidth = /min-width:\s*(\d+)px/.exec(query)?.[1]
    const matches =
      (maxWidth === undefined || width <= Number(maxWidth)) &&
      (minWidth === undefined || width >= Number(minWidth))

    return {
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function intent(overrides: Partial<Intent> & { id: string }): Intent {
  return {
    workspaceId: '/proj',
    title: 'Start me',
    shortEnTitle: null,
    content: 'Do work',
    priority: 'P1',
    module: '',
    status: 'todo',
    dependsOn: [],
    dependsOnTypes: {},
    lastDevSessionId: null,
    automate: false,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    runStatus: 'idle',
    branchName: null,
    latestCommitHash: null,
    prId: null,
    prUrl: null,
    prStatus: null,
    specPath: null,
    specApproved: false,
    specApproveUser: null,
    specSessionId: null,
    intentSessionId: null,
    ...overrides,
    id: overrides.id,
  }
}

function mountList(
  intents: Intent[],
  selectedId: string | null = null,
  opts: {
    sddEnabled?: boolean
  } = {},
) {
  return mount(IntentList, {
    props: {
      project: '/proj',
      intents,
      automation: null,
      selectedId,
      sddEnabled: opts.sddEnabled,
    },
  })
}

describe('IntentList.vue — selection model', () => {
  it('emits select-intent with the row id when a row is clicked', async () => {
    const w = mountList([intent({ id: 'intent-1' }), intent({ id: 'intent-2' })])
    const rows = w.findAll('.req-item-main')

    await rows[1].trigger('click')

    expect(w.emitted('select-intent')).toEqual([['intent-2']])
  })

  it('emits select-intent on keyboard activation (enter)', async () => {
    const w = mountList([intent({ id: 'intent-1' })])

    await w.find('.req-item-main').trigger('keydown.enter')

    expect(w.emitted('select-intent')).toEqual([['intent-1']])
  })

  it('marks the row matching selectedId as selected', () => {
    const w = mountList([intent({ id: 'intent-1' }), intent({ id: 'intent-2' })], 'intent-2')
    const items = w.findAll('.req-item')

    expect(items[0].classes()).not.toContain('selected')
    expect(items[1].classes()).toContain('selected')
  })

  it('renders the empty state when there are no intents', () => {
    const w = mountList([])

    expect(w.find('.req-empty').exists()).toBe(true)
    expect(w.findAll('.req-item')).toHaveLength(0)
  })

  it('does not render inline action buttons or chevron', () => {
    const w = mountList([intent({ id: 'intent-1' })])

    expect(w.find('.req-actions').exists()).toBe(false)
    expect(w.find('.req-chevron').exists()).toBe(false)
  })

  it('renders the auto-mode icon ⚙ for automate intents and 🖱 for manual ones', () => {
    const w = mountList([
      intent({ id: 'auto-1', automate: true }),
      intent({ id: 'manual-1', automate: false }),
    ])
    const icons = w.findAll('.req-automate')

    expect(icons[0].text()).toBe('⚙')
    expect(icons[0].attributes('aria-pressed')).toBe('true')
    expect(icons[1].text()).toBe('🖱')
    expect(icons[1].attributes('aria-pressed')).toBe('false')
  })

  it('renders automation tone classes from SDD eligibility', () => {
    const w = mountList(
      [
        intent({
          id: 'eligible',
          automate: true,
          specPath: '/specs/eligible/spec.md',
          specApproved: true,
        }),
        intent({
          id: 'unapproved',
          automate: true,
          specPath: '/specs/unapproved/spec.md',
          specApproved: false,
        }),
        intent({ id: 'done', automate: true, status: 'done', completedAt: 100 }),
      ],
      null,
      { sddEnabled: true },
    )
    const icons = w.findAll('.req-automate')

    expect(icons[0].classes()).toContain('auto-tone-eligible')
    expect(icons[1].classes()).toContain('auto-tone-idle')
    expect(icons[2].classes()).toContain('auto-tone-done')
  })

  it('emits set-automate with (id, !automate) and does not select the row when the mode icon is clicked', async () => {
    const w = mountList([intent({ id: 'manual-1', automate: false })])

    await w.find('.req-automate').trigger('click')

    expect(w.emitted('set-automate')).toEqual([['manual-1', true]])
    expect(w.emitted('select-intent')).toBeUndefined()
  })

  it('shows the refine entry only for todo intents and emits refine on click', async () => {
    const w = mountList([intent({ id: 'todo-1', status: 'todo' })])

    const refine = w.find('.req-refine')
    expect(refine.exists()).toBe(true)

    await refine.trigger('click')

    expect(w.emitted('refine')).toEqual([['todo-1']])
    expect(w.emitted('select-intent')).toBeUndefined()
  })

  it('does not render the refine entry for non-todo (in_progress / done) intents', () => {
    const w = mountList([
      intent({ id: 'wip-1', status: 'in_progress' }),
      intent({ id: 'done-1', status: 'done', completedAt: 100 }),
    ])
    const rows = w.findAll('.req-item')

    expect(rows[0].find('.req-refine').exists()).toBe(false)
    expect(rows[1].find('.req-refine').exists()).toBe(false)
  })

  it('emits ordered-change reflecting the rendered (active-first) order, not server order', () => {
    // 服务端原序按 priority ASC：高优先级的 done 项排在原序首位，活跃项在后。
    const w = mountList([
      intent({ id: 'done-p0', status: 'done', priority: 'P0', completedAt: 100 }),
      intent({ id: 'todo-p1', status: 'todo', priority: 'P1' }),
    ])

    const ordered = w.emitted('ordered-change')
    expect(ordered).toBeTruthy()
    // 左侧实际渲染:活跃项 todo-p1 置顶,done-p0 沉底。首条应为活跃项。
    expect((ordered!.at(-1)![0] as string[])[0]).toBe('todo-p1')
  })
})

describe('IntentList.vue — responsive header actions', () => {
  it('shows inline automation and filter controls on desktop', () => {
    installMatchMedia(1024)
    const w = mountList([intent({ id: 'intent-1' })])

    expect(w.find('.req-head-right > .auto-btn').exists()).toBe(true)
    expect(w.find('.req-head-right > .req-filter').exists()).toBe(true)
    expect(w.find('.req-kebab').exists()).toBe(false)
  })

  it('moves automation and filter controls into a mobile overflow menu', async () => {
    installMatchMedia(390)
    const w = mountList([intent({ id: 'intent-1' })])

    expect(w.find('.req-head-right > .auto-btn').exists()).toBe(false)
    expect(w.find('.req-head-right > .req-filter').exists()).toBe(false)
    expect(w.find('.req-kebab').exists()).toBe(true)
    expect(w.find('.req-menu').exists()).toBe(false)

    await w.find('.req-kebab').trigger('click')

    expect(w.find('.req-menu .auto-btn').exists()).toBe(true)
    expect(w.find('.req-menu .req-filter').exists()).toBe(true)
  })

  it('keeps mobile overflow actions wired to the existing events and closes the menu', async () => {
    installMatchMedia(390)
    const w = mountList([intent({ id: 'intent-1' })])

    await w.find('.req-kebab').trigger('click')
    await w.find('.req-menu .auto-btn').trigger('click')

    expect(w.emitted('start-automation')).toHaveLength(1)
    expect(w.find('.req-menu').exists()).toBe(false)

    await w.find('.req-kebab').trigger('click')
    await w.find('.req-menu .req-filter').setValue('done')

    expect(w.emitted('filter')?.at(-1)).toEqual(['done'])
    expect(w.find('.req-menu').exists()).toBe(false)
  })

  it('closes the mobile overflow menu when clicking outside it', async () => {
    installMatchMedia(390)
    const w = mountList([intent({ id: 'intent-1' })])

    await w.find('.req-kebab').trigger('click')
    expect(w.find('.req-menu').exists()).toBe(true)

    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await w.vm.$nextTick()

    expect(w.find('.req-menu').exists()).toBe(false)
  })
})
