/**
 * WorkCenter frontend coverage for the consensus-auto audit surface + the
 * EventDetail attribute list.
 *
 * - WorkCenter.vue: the 'auto' status filter exists, filters the list, and any
 *   filter click emits `reload` (so non-todo tabs re-fetch the full list).
 * - EventDetail.vue: an `status: 'auto'` event renders its consensus outcome
 *   (summary + per-voter verdicts) and offers NO allow/deny buttons (read-only);
 *   the attribute list renders workspace / session kind / session id / intent,
 *   hiding the intent row when there is no owning intent; the jump button emits.
 * Assertions key off structure / emitted events, never visible copy (i18n-spec §4).
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import WorkCenter from './WorkCenter.vue'
import EventDetail from './components/EventDetail.vue'
import type { AnyConsensusOutcome, WaitUserInvolveEvent, WorkspaceInfo } from '@ccc/shared/protocol'

const WORKSPACES: WorkspaceInfo[] = [{ id: '/ws', name: 'my-workspace', lastAccessed: 0 }]

let n = 1
function ev(over: Partial<WaitUserInvolveEvent> = {}): WaitUserInvolveEvent {
  const id = `e${n++}`
  return {
    id,
    workspaceId: '/ws',
    sessionKind: 'work',
    sessionId: 's1',
    intentId: null,
    intentTitle: null,
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

function installMatchMedia(matches: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string): MediaQueryList =>
      ({
        matches,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList,
  )
}

beforeEach(() => {
  globalThis.localStorage?.removeItem('c3.workcenterListExpanded')
})

afterEach(() => {
  vi.unstubAllGlobals()
  globalThis.localStorage?.removeItem('c3.workcenterListExpanded')
})

describe('WorkCenter.vue — desktop message list sizing', () => {
  it('renders the desktop list toggle collapsed by default', () => {
    const wrapper = mount(WorkCenter, {
      props: { events: [ev()], currentWorkspace: '/ws', workspaces: WORKSPACES },
    })

    expect(wrapper.find('.wc-list-toggle').exists()).toBe(true)
    expect(wrapper.find('.wc-sidebar').classes()).not.toContain('expanded')
  })

  it('toggles the sidebar expanded class on click', async () => {
    const wrapper = mount(WorkCenter, {
      props: { events: [ev()], currentWorkspace: '/ws', workspaces: WORKSPACES },
    })

    await wrapper.find('.wc-list-toggle').trigger('click')
    expect(wrapper.find('.wc-sidebar').classes()).toContain('expanded')

    await wrapper.find('.wc-list-toggle').trigger('click')
    expect(wrapper.find('.wc-sidebar').classes()).not.toContain('expanded')
  })

  it('does not render the list toggle on mobile', () => {
    installMatchMedia(true)

    const wrapper = mount(WorkCenter, {
      props: { events: [ev()], currentWorkspace: '/ws', workspaces: WORKSPACES },
    })

    expect(wrapper.find('.wc-list-toggle').exists()).toBe(false)
  })
})

describe('WorkCenter.vue — status filter', () => {
  it('renders 4 status tabs (no All) and defaults to todo-only', async () => {
    const events = [
      ev({ status: 'todo' }),
      ev({ status: 'auto', outcome: toolOutcome }),
      ev({ status: 'auto', outcome: toolOutcome }),
    ]
    const wrapper = mount(WorkCenter, {
      props: { events, currentWorkspace: '/ws', workspaces: WORKSPACES },
    })

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
      props: { events: [ev()], currentWorkspace: '/ws', workspaces: WORKSPACES },
    })
    await wrapper.findAll('.wc-filter-btn')[3].trigger('click') // auto
    await wrapper.findAll('.wc-filter-btn')[1].trigger('click') // done
    expect(wrapper.emitted('reload')).toHaveLength(2)
  })
})

describe('EventDetail.vue — consensus outcome', () => {
  it('renders the consensus votes for an auto record and hides allow/deny', () => {
    const wrapper = mount(EventDetail, {
      props: {
        event: ev({ status: 'auto', requestId: 'r1', outcome: toolOutcome }),
        workspaces: WORKSPACES,
      },
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
      props: { event: ev({ status: 'todo', requestId: 'r1' }), workspaces: WORKSPACES },
    })
    expect(wrapper.find('.wc-consensus').exists()).toBe(false)
    expect(wrapper.find('.wc-btn-allow').exists()).toBe(true)
  })
})

describe('EventDetail.vue — attribute list', () => {
  it('renders all four rows when the event has an owning intent', () => {
    const wrapper = mount(EventDetail, {
      props: {
        event: ev({ sessionKind: 'intent', sessionId: 's-1', intentTitle: 'My intent' }),
        workspaces: WORKSPACES,
      },
    })
    const rows = wrapper.findAll('.wc-attr-row')
    expect(rows).toHaveLength(4)
    // The workspace id resolves to its registered display name.
    expect(rows[0].find('.wc-attr-val').text()).toBe('my-workspace')
    // The session id + intent title surface verbatim.
    expect(rows[2].find('.wc-attr-val').text()).toBe('s-1')
    expect(rows[3].find('.wc-attr-val').text()).toBe('My intent')
  })

  it('hides the intent row when there is no owning intent', () => {
    const wrapper = mount(EventDetail, {
      props: {
        event: ev({ sessionKind: 'work', sessionId: 's-1', intentTitle: null }),
        workspaces: WORKSPACES,
      },
    })
    // workspace + session kind + session id, no intent row.
    expect(wrapper.findAll('.wc-attr-row')).toHaveLength(3)
  })

  it('hides the session-id row when the event has no session id', () => {
    const wrapper = mount(EventDetail, {
      props: {
        event: ev({ sessionKind: 'work', sessionId: null, intentTitle: null }),
        workspaces: WORKSPACES,
      },
    })
    // Only workspace + session kind remain.
    expect(wrapper.findAll('.wc-attr-row')).toHaveLength(2)
  })

  it('emits jump-to-source with the full event when the jump button is clicked', async () => {
    const event = ev({ sessionKind: 'intent', sessionId: 's-1' })
    const wrapper = mount(EventDetail, { props: { event, workspaces: WORKSPACES } })
    await wrapper.find('.wc-btn-jump').trigger('click')
    expect(wrapper.emitted('jump-to-source')?.[0]).toEqual([event])
  })
})
