/**
 * The eighth workspace-settings tab: see what the agents remember, and drop one.
 *
 * Two things are asserted here in equal measure. What the tab DOES — render the
 * summary and ask the parent to delete after a confirm — and what it deliberately
 * does NOT: no create, no edit, no memory body, and no row leaving the list on its
 * own. The row disappears because the server said the delete happened; a component
 * that removed it optimistically would show a delete that never occurred.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { WorkspaceMemoryListItem } from '@ccc/shared/protocol'
import WorkspaceMemories from './WorkspaceMemories.vue'

const WORKSPACE = 'ws-1'

const MEMORIES: WorkspaceMemoryListItem[] = [
  {
    id: 'm-lesson',
    title: '沙箱内 vitest 要单线程',
    type: 'lesson',
    status: 'active',
    updatedAt: 1_760_000_000_000,
  },
  {
    id: 'm-pref',
    title: '提交信息用中文',
    type: 'preference',
    status: 'active',
    updatedAt: 1_750_000_000_000,
  },
  {
    id: 'm-fact',
    title: '默认主分支是 main',
    type: 'fact',
    status: 'active',
    updatedAt: 1_740_000_000_000,
  },
]

function render(props: Record<string, unknown> = {}) {
  return mount(WorkspaceMemories, {
    props: { workspaceName: WORKSPACE, memories: MEMORIES, ...props },
  })
}

const texts = (w: ReturnType<typeof render>, testid: string) =>
  w.findAll(`[data-testid="${testid}"]`).map((n) => n.text())

describe('the memory listing', () => {
  it('shows every active memory with its title, type, status and update time', () => {
    const w = render()
    expect(texts(w, 'workspace-memories-row-title')).toEqual([
      '提交信息用中文',
      '默认主分支是 main',
      '沙箱内 vitest 要单线程',
    ])
    expect(texts(w, 'workspace-memories-row-type')).toEqual(['Preference', 'Fact', 'Lesson'])
    expect(texts(w, 'workspace-memories-row-status')).toEqual(['Active', 'Active', 'Active'])
    // A localized absolute time, not a raw epoch — the exact rendering is Intl's,
    // so what is pinned is that the year is there and the number is not.
    const updated = texts(w, 'workspace-memories-row-updated')
    expect(updated).toHaveLength(3)
    for (const cell of updated) {
      expect(cell).toMatch(/20\d\d/)
      expect(cell).not.toContain('1760000000000')
    }
  })

  it('groups by type in the same fixed order the agent-facing directory uses, omitting empty groups', () => {
    const w = render()
    // preference → constraint → fact → lesson; no `constraint` row exists, so that
    // group is absent rather than rendered empty.
    expect(texts(w, 'workspace-memories-group')).toEqual(['Preference', 'Fact', 'Lesson'])
  })

  it('tells "not loaded yet" apart from "this workspace remembers nothing"', () => {
    const loading = render({ memories: null, loading: true })
    expect(loading.find('[data-testid="workspace-memories-loading"]').exists()).toBe(true)
    expect(loading.find('[data-testid="workspace-memories-empty"]').exists()).toBe(false)

    const empty = render({ memories: [] })
    expect(empty.find('[data-testid="workspace-memories-empty"]').exists()).toBe(true)
    expect(empty.find('[data-testid="workspace-memories-loading"]').exists()).toBe(false)
    expect(empty.findAll('[data-testid="workspace-memories-row"]')).toHaveLength(0)
  })

  it('reports a failed read instead of degrading into an empty list', () => {
    const w = render({
      memories: null,
      error: { code: 'workspace.unknown', params: { path: 'x' } },
    })
    expect(w.find('[data-testid="workspace-memories-unavailable"]').exists()).toBe(true)
    expect(w.find('[data-testid="workspace-memories-empty"]').exists()).toBe(false)
    expect(w.find('[data-testid="workspace-memories-list"]').exists()).toBe(false)
  })

  it('asks the parent to re-read rather than deriving a list locally', async () => {
    const w = render()
    await w.get('[data-testid="workspace-memories-reload"]').trigger('click')
    expect(w.emitted('reload')).toHaveLength(1)
  })

  it('says out loud that a delete is soft and still holds capacity for 30 days', () => {
    const w = render()
    expect(w.get('[data-testid="workspace-memories-soft-delete-hint"]').text()).toContain('30')
  })
})

describe('deleting one memory', () => {
  it('asks for confirmation first and emits nothing until it is given', async () => {
    const w = render()
    await w.findAll('[data-testid="workspace-memories-delete"]')[0].trigger('click')

    expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(true)
    expect(w.emitted('delete')).toBeUndefined()

    await w.get('[data-testid="confirm-accept"]').trigger('click')
    // The first row is the `preference` group's — grouping decides the order, so
    // the id asserted here is the one the user actually clicked.
    expect(w.emitted('delete')).toEqual([['m-pref']])
    expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(false)
  })

  it('sends nothing when the confirmation is cancelled', async () => {
    const w = render()
    await w.findAll('[data-testid="workspace-memories-delete"]')[0].trigger('click')
    await w.get('[data-testid="confirm-cancel"]').trigger('click')

    expect(w.emitted('delete')).toBeUndefined()
    expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="workspace-memories-row"]')).toHaveLength(3)
  })

  it('keeps the row until the server confirms, then drops it when the parent does', async () => {
    const w = render()
    await w.findAll('[data-testid="workspace-memories-delete"]')[0].trigger('click')
    await w.get('[data-testid="confirm-accept"]').trigger('click')
    // Still there: the component never removes a row on its own, because the
    // delete may yet be refused.
    expect(texts(w, 'workspace-memories-row-title')).toContain('提交信息用中文')

    // The parent applied the server's `workspace_memory_deleted` confirmation.
    await w.setProps({ memories: MEMORIES.filter((m) => m.id !== 'm-pref') })
    expect(texts(w, 'workspace-memories-row-title')).not.toContain('提交信息用中文')
    expect(w.findAll('[data-testid="workspace-memories-row"]')).toHaveLength(2)
  })

  it('disables the button of a delete already in flight', () => {
    const w = render({ deletingIds: ['m-pref'] })
    const buttons = w.findAll('[data-testid="workspace-memories-delete"]')
    expect(buttons[0].attributes('disabled')).toBeDefined()
    expect(buttons[1].attributes('disabled')).toBeUndefined()
  })
})

describe('what the tab deliberately does not offer', () => {
  it('has no create, edit or Save control — writing a memory stays the agent job', () => {
    const w = render()
    for (const testid of [
      'workspace-memories-create',
      'workspace-memories-create-form',
      'workspace-memories-edit',
      'workspace-memories-save',
    ]) {
      expect(w.find(`[data-testid="${testid}"]`).exists(), testid).toBe(false)
    }
    expect(w.findAll('input')).toHaveLength(0)
    expect(w.findAll('textarea')).toHaveLength(0)
  })

  it('never renders a memory body — the listing is a summary, not a reader', () => {
    const w = render()
    // The prop type carries no `content`; this pins that no row invents one either.
    expect(w.text()).not.toContain('用户明确要求')
  })
})
