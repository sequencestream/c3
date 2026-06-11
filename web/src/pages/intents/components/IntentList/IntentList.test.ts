import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Intent } from '@ccc/shared/protocol'
import IntentList from './IntentList.vue'

function intent(overrides: Partial<Intent> & { id: string }): Intent {
  return {
    projectPath: '/proj',
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

function mountList(intents: Intent[], intentActionErrorSeq = 0) {
  return mount(IntentList, {
    props: {
      project: '/proj',
      intents,
      automation: null,
      intentActionErrorSeq,
    },
  })
}

describe('IntentList.vue — start dev in-flight guard', () => {
  it('disables immediately and emits one start-dev on rapid double click', async () => {
    const w = mountList([intent({ id: 'intent-1' })])
    const start = w.find('.req-btn.primary')

    await start.trigger('click')
    await start.trigger('click')

    expect(w.emitted('start-dev')).toEqual([['intent-1', false]])
    expect((start.element as HTMLButtonElement).disabled).toBe(true)
  })

  it('restores the button when status changes or an intent error arrives', async () => {
    const item = intent({ id: 'intent-1' })
    const w = mountList([item])

    await w.find('.req-btn.primary').trigger('click')
    expect((w.find('.req-btn.primary').element as HTMLButtonElement).disabled).toBe(true)

    await w.setProps({ intents: [{ ...item, status: 'in_progress' }] })
    expect(w.find('.req-btn.primary').exists()).toBe(false)

    await w.setProps({ intents: [item] })
    await w.find('.req-btn.primary').trigger('click')
    expect((w.find('.req-btn.primary').element as HTMLButtonElement).disabled).toBe(true)

    await w.setProps({ intentActionErrorSeq: 1 })
    expect((w.find('.req-btn.primary').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not enter in-flight when unfinished dependency confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false)
    const dep = intent({ id: 'dep', status: 'in_progress', title: 'Dependency' })
    const child = intent({ id: 'child', dependsOn: ['dep'] })
    const w = mountList([dep, child])
    const startButtons = w.findAll('.req-btn.primary')

    await startButtons[0].trigger('click')

    expect(w.emitted('start-dev')).toBeUndefined()
    expect((startButtons[0].element as HTMLButtonElement).disabled).toBe(false)
  })
})
