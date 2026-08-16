import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { WorkflowStatus, Intent } from '@ccc/shared/protocol'
import IntentMergedList from './IntentMergedList.vue'

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
    workspaceName: '/proj',
    title: 'Start me',
    shortEnTitle: null,
    content: 'Do work',
    priority: 'P1',
    module: '',
    status: 'todo',
    dependsOn: [],
    dependsOnTypes: {},
    lastWorkSessionId: null,
    automate: false,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    runStatus: 'idle',
    branchName: null,
    latestCommitHash: null,
    baseBranch: 'main',
    baseBranchFallback: false,
    prs: [],
    linkedDeliveries: [],
    specPath: null,
    specStatus: 'raw',
    specMode: null,
    effectiveSpecMode: 'sdd',
    specApproved: false,
    specApproveUser: null,
    specSessionId: null,
    specReviewSessionId: null,
    specReviewVerdict: null,
    specReviewReason: null,
    specReviewAt: null,
    specReviewFingerprint: null,
    specReviewReworkRounds: 0,
    specReviewMachineApprovalBlocked: false,
    intentSessionId: null,
    sessionActive: false,
    actionDescriptor: null,
    ...overrides,
    id: overrides.id,
  }
}

function mountMerged(
  opts: {
    intents?: Intent[]
    automation?: WorkflowStatus | null
  } = {},
) {
  return mount(IntentMergedList, {
    props: {
      project: '/proj',
      intents: opts.intents ?? [],
      automation: opts.automation ?? null,
    },
  })
}

describe('IntentMergedList.vue — header', () => {
  it('renders the intent list title and no segmented control', () => {
    const w = mountMerged()
    expect(w.find('.merged-list-title').exists()).toBe(true)
    expect(w.find('[data-testid="tab-intents"]').exists()).toBe(false)
    expect(w.find('[data-testid="tab-sessions"]').exists()).toBe(false)
  })

  it('uses the title-bar plus button to add an intent', async () => {
    const w = mountMerged()
    const btn = w.find('[data-testid="intent-list-create-intent"]')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toBe('+')
    expect(btn.attributes('aria-label')).toBe('Add intent')
    await btn.trigger('click')
    expect(w.emitted('new-intent')).toHaveLength(1)
    expect(w.find('[data-testid="intent-list-new-session"]').exists()).toBe(false)
  })

  it('shows the automation button and status filter on desktop', () => {
    const w = mountMerged()
    expect(w.find('.auto-btn').attributes('style')).toBeUndefined()
    expect(w.find('.req-filter').attributes('style')).toBeUndefined()
  })
})

describe('IntentMergedList.vue — collapse', () => {
  it('toggles collapsed class on button click', async () => {
    const w = mountMerged()
    const section = w.find('.merged-list')
    const collapseBtn = section.find('.req-collapse-btn')

    // Default: not collapsed
    expect(section.classes()).not.toContain('collapsed')

    // Click collapse
    await collapseBtn.trigger('click')
    expect(section.classes()).toContain('collapsed')

    // Click again to expand
    await collapseBtn.trigger('click')
    expect(section.classes()).not.toContain('collapsed')
  })
})

describe('IntentMergedList.vue — responsive header actions', () => {
  it('shows inline automation and filter controls on desktop', () => {
    installMatchMedia(1024)
    const w = mountMerged()

    expect(w.find('.merged-list-head-right > .auto-btn').attributes('style')).toBeUndefined()
    expect(w.find('.merged-list-head-right > .req-filter').attributes('style')).toBeUndefined()
    expect(w.find('[data-testid="intent-list-mobile-actions"]').attributes('style')).toContain(
      'display: none',
    )
  })

  it('moves automation and filter controls into a mobile overflow menu', async () => {
    installMatchMedia(390)
    const w = mountMerged()

    expect(w.find('.merged-list-head-right > .auto-btn').attributes('style')).toContain(
      'display: none',
    )
    expect(w.find('.merged-list-head-right > .req-filter').attributes('style')).toContain(
      'display: none',
    )
    expect(w.find('[data-testid="intent-list-mobile-actions"]').attributes('style')).toBeUndefined()
    expect(w.find('.req-kebab').exists()).toBe(true)

    await w.find('.req-kebab').trigger('click')

    expect(w.find('.req-menu .auto-btn').exists()).toBe(true)
    expect(w.find('.req-menu .req-filter').exists()).toBe(true)
  })

  it('keeps merged mobile overflow actions wired to existing events and closes the menu', async () => {
    installMatchMedia(390)
    const w = mountMerged()

    await w.find('.req-kebab').trigger('click')
    await w.find('.req-menu .auto-btn').trigger('click')

    expect(w.emitted('start-automation')).toHaveLength(1)
    expect(w.find('.req-menu').exists()).toBe(false)

    await w.find('.req-kebab').trigger('click')
    await w.find('.req-menu .req-filter').setValue('blocked')

    expect(w.emitted('filter')?.at(-1)).toEqual(['blocked'])
    expect(w.find('.req-menu').exists()).toBe(false)
  })

  it('closes the merged mobile overflow menu when clicking outside it', async () => {
    installMatchMedia(390)
    const w = mountMerged()

    await w.find('.req-kebab').trigger('click')
    expect(w.find('.req-menu').exists()).toBe(true)

    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await w.vm.$nextTick()

    expect(w.find('.req-menu').exists()).toBe(false)
  })
})

describe('IntentMergedList.vue — empty-list guide bubble', () => {
  const GUIDE = '[data-testid="intent-list-empty-guide"]'
  const GUIDE_CLOSE = '[data-testid="intent-list-empty-guide-close"]'

  it('shows the guide bubble anchored to the plus button when the list is empty', () => {
    const w = mountMerged({ intents: [] })

    // 气泡与「+」同处一个定位容器,故箭头/贴近定位始终指向按钮
    const wrap = w.find('.req-new-wrap')
    expect(wrap.find(GUIDE).exists()).toBe(true)
    expect(wrap.find('[data-testid="intent-list-create-intent"]').exists()).toBe(true)
  })

  it('hides the guide bubble when the list already has intents', () => {
    const w = mountMerged({ intents: [intent({ id: 'r1' })] })

    expect(w.find(GUIDE).exists()).toBe(false)
  })

  it('hides the guide bubble after clicking its close button', async () => {
    const w = mountMerged({ intents: [] })

    await w.find(GUIDE_CLOSE).trigger('click')

    expect(w.find(GUIDE).exists()).toBe(false)
  })

  it('keeps the guide bubble hidden while the list stays empty after closing', async () => {
    const w = mountMerged({ intents: [] })

    await w.find(GUIDE_CLOSE).trigger('click')
    // 列表仍为空的其它渲染(过滤等)不应让气泡回来
    await w.setProps({ intents: [] })

    expect(w.find(GUIDE).exists()).toBe(false)
  })

  it('drops the guide bubble once the first intent lands, even if never closed', async () => {
    const w = mountMerged({ intents: [] })
    expect(w.find(GUIDE).exists()).toBe(true)

    await w.setProps({ intents: [intent({ id: 'r1' })] })

    expect(w.find(GUIDE).exists()).toBe(false)
  })

  it('shows the guide bubble again on a fresh mount with an empty list', async () => {
    const first = mountMerged({ intents: [] })
    await first.find(GUIDE_CLOSE).trigger('click')
    expect(first.find(GUIDE).exists()).toBe(false)

    // 刷新页面 / 重新进入 workspace = 组件重新挂载,关闭态不持久化
    const second = mountMerged({ intents: [] })

    expect(second.find(GUIDE).exists()).toBe(true)
  })

  it('leaves the plus button clickable while the guide bubble is showing', async () => {
    const w = mountMerged({ intents: [] })
    expect(w.find(GUIDE).exists()).toBe(true)

    await w.find('[data-testid="intent-list-create-intent"]').trigger('click')

    expect(w.emitted('new-intent')).toHaveLength(1)
  })
})
