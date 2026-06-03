import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Discussion } from '@ccc/shared/protocol'
import Discussions from './Discussions.vue'
import type { DispatchView } from '../../lib/discussion-view'

function disc(over: Partial<Discussion> = {}): Discussion {
  return {
    id: 'd1',
    projectPath: '/proj',
    title: 'T',
    type: 'design',
    goal: '',
    context: '',
    status: 'in_progress',
    agenda: [],
    agendaIndex: 0,
    conclusion: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    ...over,
  }
}

// Mount the container with the heavy children stubbed — the dispatch strip is
// rendered by Discussions.vue itself, between ChatMessages and the composer.
function mountDiscussions(dispatch: DispatchView, activeDiscussion: Discussion | null = disc()) {
  return mount(Discussions, {
    props: {
      discussions: [],
      activeId: 'd1',
      runState: {},
      activeDiscussion,
      activeRunState: 'running' as const,
      messages: [],
      dispatch,
      input: '',
    },
    global: {
      stubs: {
        DiscussionList: true,
        AgendaProgress: true,
        SessionTitleBar: true,
        ChatMessages: true,
      },
    },
  })
}

describe('Discussions.vue — transient dispatch strip', () => {
  it('renders one "X is replying…" line per pending agent (broadcast concurrency)', () => {
    const w = mountDiscussions({
      pending: [
        { id: 'a', name: 'Alice' },
        { id: 'b', name: 'Bob' },
      ],
      errors: [],
    })
    const lines = w.findAll('.disc-dispatch-pending')
    expect(lines).toHaveLength(2)
    expect(lines[0].text()).toContain('Alice is replying…')
    expect(lines[1].text()).toContain('Bob is replying…')
  })

  it('renders a failure error line', () => {
    const w = mountDiscussions({
      pending: [],
      errors: [{ id: 'a', name: 'Alice', error: 'boom' }],
    })
    const err = w.find('.disc-dispatch-error')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('Alice failed to reply: boom')
  })

  it('renders nothing when there is no pending/failed status', () => {
    const w = mountDiscussions({ pending: [], errors: [] })
    expect(w.find('.disc-dispatch').exists()).toBe(false)
  })

  it('renders nothing when no discussion is open', () => {
    const w = mountDiscussions({ pending: [{ id: 'a', name: 'Alice' }], errors: [] }, null)
    expect(w.find('.disc-dispatch').exists()).toBe(false)
  })
})
