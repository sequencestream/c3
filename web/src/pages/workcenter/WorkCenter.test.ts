/**
 * WorkCenter frontend coverage for the consensus-auto audit surface.
 *
 * - WorkCenter.vue: the 'auto' status filter exists, filters the list, and any
 *   filter click emits `reload` (so non-todo tabs re-fetch the full list).
 * - EventDetail.vue: an `status: 'auto'` event renders its consensus outcome
 *   (summary + per-voter verdicts) and offers NO allow/deny buttons (read-only).
 * Assertions key off structure / emitted events, never visible copy (i18n-spec §4).
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkCenter from './WorkCenter.vue'
import EventDetail from './components/EventDetail.vue'
import type { AnyConsensusOutcome, WaitUserInvolveEvent } from '@ccc/shared/protocol'

let n = 1
function ev(over: Partial<WaitUserInvolveEvent> = {}): WaitUserInvolveEvent {
  const id = `e${n++}`
  return {
    id,
    workspaceId: '/ws',
    source: 'work',
    sourceId: 's1',
    title: id,
    requestId: 'r1',
    toolName: 'edit_file',
    toolInput: { path: 'a.ts' },
    status: 'todo',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

const toolOutcome: AnyConsensusOutcome = {
  kind: 'tool',
  votes: [
    { agentId: 'a2', agentName: 'Reviewer', decision: 'allow', reason: 'safe' },
    { agentId: 'a3', agentName: 'Auditor', decision: 'allow', reason: 'ok' },
  ],
  summary: 'unanimous allow',
  unanimous: true,
  decision: 'allow',
}

describe('WorkCenter.vue — status filter', () => {
  it('renders 4 status tabs (no All) and defaults to todo-only', async () => {
    const events = [
      ev({ status: 'todo' }),
      ev({ status: 'auto', outcome: toolOutcome }),
      ev({ status: 'auto', outcome: toolOutcome }),
    ]
    const wrapper = mount(WorkCenter, { props: { events, currentWorkspace: '/ws' } })

    const btns = wrapper.findAll('.wc-filter-btn')
    expect(btns).toHaveLength(4) // todo / done / canceled / auto — no 'all'

    // Default filter is 'todo': only the todo row renders, the auto rows are hidden.
    expect(wrapper.findAll('.wc-event-row')).toHaveLength(1)

    // Click the last tab (auto) → only the two auto records remain.
    await btns[3].trigger('click')
    expect(wrapper.findAll('.wc-event-row')).toHaveLength(2)
  })

  it('emits reload on every filter switch (non-todo tabs re-fetch)', async () => {
    const wrapper = mount(WorkCenter, {
      props: { events: [ev()], currentWorkspace: '/ws' },
    })
    await wrapper.findAll('.wc-filter-btn')[3].trigger('click') // auto
    await wrapper.findAll('.wc-filter-btn')[1].trigger('click') // done
    expect(wrapper.emitted('reload')).toHaveLength(2)
  })
})

describe('EventDetail.vue — consensus outcome', () => {
  it('renders the consensus votes for an auto record and hides allow/deny', () => {
    const wrapper = mount(EventDetail, {
      props: { event: ev({ status: 'auto', requestId: 'r1', outcome: toolOutcome }) },
    })
    expect(wrapper.find('.wc-consensus').exists()).toBe(true)
    expect(wrapper.findAll('.wc-vote')).toHaveLength(2)
    expect(wrapper.find('.wc-consensus-summary').text()).toContain('unanimous allow')
    // Auto records are already resolved — no human action buttons.
    expect(wrapper.find('.wc-btn-allow').exists()).toBe(false)
    expect(wrapper.find('.wc-btn-deny').exists()).toBe(false)
  })

  it('shows allow/deny for a normal todo event and no consensus block', () => {
    const wrapper = mount(EventDetail, {
      props: { event: ev({ status: 'todo', requestId: 'r1' }) },
    })
    expect(wrapper.find('.wc-consensus').exists()).toBe(false)
    expect(wrapper.find('.wc-btn-allow').exists()).toBe(true)
  })
})
