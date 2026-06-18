import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Intent } from '@ccc/shared/protocol'
import IntentDetail from './IntentDetail.vue'

function intent(overrides: Partial<Intent> & { id: string }): Intent {
  return {
    workspaceId: '/proj',
    title: 'Start me',
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
    prStatus: null,
    ...overrides,
    id: overrides.id,
  }
}

function mountDetail(
  current: Intent | null,
  opts: { intents?: Intent[]; intentActionErrorSeq?: number } = {},
) {
  return mount(IntentDetail, {
    props: {
      intent: current,
      intents: opts.intents ?? (current ? [current] : []),
      intentActionErrorSeq: opts.intentActionErrorSeq ?? 0,
    },
  })
}

describe('IntentDetail.vue — empty state', () => {
  it('renders the empty placeholder when no intent is selected', () => {
    const w = mountDetail(null)
    expect(w.find('[data-testid="intent-detail-empty"]').exists()).toBe(true)
  })
})

describe('IntentDetail.vue — start dev in-flight guard', () => {
  it('disables immediately and emits one start-dev on rapid double click', async () => {
    const item = intent({ id: 'intent-1' })
    const w = mountDetail(item)
    const start = w.find('.req-btn.primary')

    await start.trigger('click')
    await start.trigger('click')

    expect(w.emitted('start-dev')).toEqual([['intent-1', false]])
    expect((start.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('restores the button when status changes or an intent error arrives', async () => {
    const item = intent({ id: 'intent-1' })
    const w = mountDetail(item)

    await w.find('.req-btn.primary').trigger('click')
    expect((w.find('.req-btn.primary').element as HTMLButtonElement).disabled).toBe(true)

    await w.setProps({ intent: { ...item, status: 'in_progress' }, intents: [item] })
    expect(w.find('.req-btn.primary').exists()).toBe(false)

    await w.setProps({ intent: item, intents: [item] })
    await w.find('.req-btn.primary').trigger('click')
    expect((w.find('.req-btn.primary').element as HTMLButtonElement).disabled).toBe(true)

    await w.setProps({ intentActionErrorSeq: 1 })
    expect((w.find('.req-btn.primary').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not enter in-flight when unfinished dependency confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    const dep = intent({ id: 'dep', status: 'in_progress', title: 'Dependency' })
    const child = intent({ id: 'child', dependsOn: ['dep'] })
    const w = mountDetail(child, { intents: [dep, child] })

    await w.find('.req-btn.primary').trigger('click')

    expect(w.emitted('start-dev')).toBeUndefined()
    expect((w.find('.req-btn.primary').element as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('IntentDetail.vue — actions', () => {
  it('emits set-status done from the mark-done button', async () => {
    const item = intent({ id: 'intent-1', status: 'in_progress' })
    const w = mountDetail(item)

    // status in_progress → action buttons are: mark-done, cancel (first is mark-done).
    const buttons = w.findAll('.intent-detail-actions .req-btn')
    await buttons[0].trigger('click')

    expect(w.emitted('set-status')).toEqual([['intent-1', 'done']])
  })

  it('emits set-automate toggling the current flag', async () => {
    const item = intent({ id: 'intent-1', automate: false })
    const w = mountDetail(item)

    await w.find('.req-automate').trigger('click')

    expect(w.emitted('set-automate')).toEqual([['intent-1', true]])
  })

  it('emits create-pr for a done intent without a pr', async () => {
    const item = intent({ id: 'intent-1', status: 'done', completedAt: 2 })
    const w = mountDetail(item)

    await w.find('.req-btn.primary').trigger('click')

    expect(w.emitted('create-pr')).toEqual([['intent-1']])
  })
})
