import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { AutomationStatus, Intent, IntentSessionInfo } from '@ccc/shared/protocol'
import IntentMergedList from './IntentMergedList.vue'

function session(overrides: Partial<IntentSessionInfo> & { sessionId: string }): IntentSessionInfo {
  return {
    title: null,
    updatedAt: 1000,
    ...overrides,
    sessionId: overrides.sessionId,
  }
}

function mountMerged(
  opts: {
    intents?: Intent[]
    sessions?: IntentSessionInfo[]
    automation?: AutomationStatus | null
  } = {},
) {
  return mount(IntentMergedList, {
    props: {
      project: '/proj',
      intents: opts.intents ?? [],
      automation: opts.automation ?? null,
      intentSessions: opts.sessions ?? [],
      selectedIntentSessionId: null,
      intentSessionRunStates: {},
      ...opts,
    },
  })
}

describe('IntentMergedList.vue — segmented control', () => {
  it('renders both tab buttons with intents active by default', () => {
    const w = mountMerged()
    const tabIntents = w.find('[data-testid="tab-intents"]')
    const tabSessions = w.find('[data-testid="tab-sessions"]')

    expect(tabIntents.exists()).toBe(true)
    expect(tabSessions.exists()).toBe(true)
    expect(tabIntents.attributes('aria-selected')).toBe('true')
    expect(tabSessions.attributes('aria-selected')).toBe('false')
  })

  it('switches active tab when clicking sessions tab', async () => {
    const w = mountMerged()
    const tabSessions = w.find('[data-testid="tab-sessions"]')

    await tabSessions.trigger('click')

    expect(tabSessions.attributes('aria-selected')).toBe('true')
    expect(w.find('[data-testid="tab-intents"]').attributes('aria-selected')).toBe('false')
  })

  it('returns to intents tab when clicking back', async () => {
    const w = mountMerged()
    await w.find('[data-testid="tab-sessions"]').trigger('click')
    await w.find('[data-testid="tab-intents"]').trigger('click')

    expect(w.find('[data-testid="tab-intents"]').attributes('aria-selected')).toBe('true')
    expect(w.find('[data-testid="tab-sessions"]').attributes('aria-selected')).toBe('false')
  })

  it('shows new-session button on sessions tab, hides on intents tab', async () => {
    const w = mountMerged({ sessions: [session({ sessionId: 's1' })] })
    const btn = () => w.find('[data-testid="intent-session-new"]')
    // On intents tab (default), "+" button exists but has display:none from v-show
    expect(btn().exists()).toBe(true)
    expect(btn().attributes('style')).toContain('display: none')

    // Switch to sessions tab → visible (inline style removed by v-show)
    await w.find('[data-testid="tab-sessions"]').trigger('click')
    expect(btn().attributes('style')).toBeUndefined()
  })

  it('shows new-session entry on intents tab, hides on sessions tab', async () => {
    const w = mountMerged()
    const btn = () => w.find('[data-testid="intent-list-new-session"]')
    // On intents tab (default), the new-session button is visible (no inline display:none)
    expect(btn().exists()).toBe(true)
    expect(btn().attributes('style')).toBeUndefined()

    // Switch to sessions tab → hidden (v-show inline style), the sessions-tab "+" takes over
    await w.find('[data-testid="tab-sessions"]').trigger('click')
    expect(btn().attributes('style')).toContain('display: none')
  })

  it('intents-tab new-session entry matches the sessions-tab entry (icon + a11y)', async () => {
    const w = mountMerged()
    const listBtn = w.find('[data-testid="intent-list-new-session"]')
    await w.find('[data-testid="tab-sessions"]').trigger('click')
    const sessionBtn = w.find('[data-testid="intent-session-new"]')

    // Same affordance: identical visible icon, class, aria-label and title.
    expect(listBtn.text()).toBe(sessionBtn.text())
    expect(listBtn.classes()).toEqual(sessionBtn.classes())
    expect(listBtn.attributes('aria-label')).toBe(sessionBtn.attributes('aria-label'))
    expect(listBtn.attributes('title')).toBe(sessionBtn.attributes('title'))
  })

  it('shows auto-btn and filter on intents tab', () => {
    const w = mountMerged()
    // Default intents tab: both visible (v-show=true → no inline style)
    expect(w.find('.auto-btn').attributes('style')).toBeUndefined()
    expect(w.find('.req-filter').attributes('style')).toBeUndefined()
  })

  it('hides auto-btn and filter on sessions tab', async () => {
    const w = mountMerged()
    await w.find('[data-testid="tab-sessions"]').trigger('click')

    expect(w.find('.auto-btn').attributes('style')).toContain('display: none')
    expect(w.find('.req-filter').attributes('style')).toContain('display: none')
  })
})

describe('IntentMergedList.vue — event passthrough', () => {
  it('emits new-intent-session when + button clicked', async () => {
    const w = mountMerged({ sessions: [session({ sessionId: 's1' })] })
    await w.find('[data-testid="tab-sessions"]').trigger('click')

    await w.find('[data-testid="intent-session-new"]').trigger('click')

    expect(w.emitted('new-intent-session')).toHaveLength(1)
  })

  it('intents-tab new-session entry creates a session and switches to sessions tab', async () => {
    const w = mountMerged()
    // Start on intents tab.
    expect(w.find('[data-testid="tab-intents"]').attributes('aria-selected')).toBe('true')

    await w.find('[data-testid="intent-list-new-session"]').trigger('click')

    // Reuses the existing create action exactly once.
    expect(w.emitted('new-intent-session')).toHaveLength(1)
    // Left segmented control switches to the sessions view.
    expect(w.find('[data-testid="tab-sessions"]').attributes('aria-selected')).toBe('true')
    expect(w.find('[data-testid="tab-intents"]').attributes('aria-selected')).toBe('false')
  })

  it('exposes activeTab via defineExpose', () => {
    const w = mountMerged()
    const vm = w.vm as unknown as { activeTab: string }
    expect(vm.activeTab).toBe('intents')
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
