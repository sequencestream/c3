import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Intent } from '@ccc/shared/protocol'
import IntentList from './IntentList.vue'

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

function mountList(intents: Intent[], selectedId: string | null = null) {
  return mount(IntentList, {
    props: {
      project: '/proj',
      intents,
      automation: null,
      selectedId,
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
