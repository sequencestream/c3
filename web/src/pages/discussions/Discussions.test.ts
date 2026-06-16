import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Discussion } from '@ccc/shared/protocol'
import Discussions from './Discussions.vue'
import type { DispatchView, DiscussionPhase } from '../../lib/discussion-view'
import type { ChatMsg } from '../../lib/chat-types'

function disc(over: Partial<Discussion> = {}): Discussion {
  return {
    id: 'd1',
    workspaceId: '/proj',
    title: 'T',
    type: 'design',
    goal: '',
    context: '',
    researchResult: '',
    status: 'in_progress',
    agenda: [],
    agendaIndex: 0,
    participantAgentIds: [],
    conclusion: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    ...over,
  }
}

// Mount the container with the heavy children stubbed — the dispatch strip is
// rendered by Discussions.vue itself, between ChatMessages and the composer.
function mountDiscussions(
  dispatch: DispatchView,
  activeDiscussion: Discussion | null = disc(),
  over: {
    phase?: DiscussionPhase
    showStart?: boolean
    researchMessages?: ChatMsg[]
    activeRunState?: 'running' | 'paused' | undefined
  } = {},
) {
  return mount(Discussions, {
    props: {
      discussions: [],
      activeId: 'd1',
      runState: {},
      activeDiscussion,
      activeRunState: over.activeRunState ?? ('running' as const),
      messages: [],
      researchMessages: over.researchMessages ?? [],
      // Default to the discussion phase so the dispatch-strip tests below see the
      // discussion stream (research phase hides the strip).
      phase: over.phase ?? 'discussion',
      showStart: over.showStart ?? false,
      dispatch,
      input: '',
      agents: [],
      defaultAgentId: null,
    },
    global: {
      stubs: {
        DiscussionList: true,
        AgendaProgress: true,
        SessionTitleBar: false,
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
    const lines = w.findAll('[data-testid="discussion-pending"]')
    expect(lines).toHaveLength(2)
    // 断言注入的 agent 名(fixture 业务数据),不碰 "is replying…" 可译文案。
    expect(lines[0].text()).toContain('Alice')
    expect(lines[1].text()).toContain('Bob')
  })

  it('renders a failure error line', () => {
    const w = mountDiscussions({
      pending: [],
      errors: [{ id: 'a', name: 'Alice', error: 'boom' }],
    })
    const err = w.find('[data-testid="discussion-error"]')
    expect(err.exists()).toBe(true)
    // 断言注入的 agent 名与 error(fixture 业务数据),不碰 "failed to reply:" 可译文案。
    expect(err.text()).toContain('Alice')
    expect(err.text()).toContain('boom')
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

describe('Discussions.vue — right-pane phase switch', () => {
  const empty: DispatchView = { pending: [], errors: [] }

  it('shows the research stream (not the discussion stream) while phase = research', () => {
    const w = mountDiscussions(empty, disc({ status: 'draft' }), { phase: 'research' })
    expect(w.find('[data-testid="research-stream"]').exists()).toBe(true)
    expect(w.find('[data-testid="discussion-stream"]').exists()).toBe(false)
  })

  it('shows the discussion stream (not the research stream) while phase = discussion', () => {
    const w = mountDiscussions(empty, disc({ status: 'in_progress' }), { phase: 'discussion' })
    expect(w.find('[data-testid="discussion-stream"]').exists()).toBe(true)
    expect(w.find('[data-testid="research-stream"]').exists()).toBe(false)
  })

  it('hides the dispatch strip during the research phase', () => {
    const w = mountDiscussions(
      { pending: [{ id: 'a', name: 'Alice' }], errors: [] },
      disc({ status: 'draft' }),
      { phase: 'research' },
    )
    expect(w.find('.disc-dispatch').exists()).toBe(false)
  })
})

describe('Discussions.vue — Start button visibility', () => {
  const empty: DispatchView = { pending: [], errors: [] }

  it('shows Start only when showStart is true (research ended/dead, discussion not started)', () => {
    const w = mountDiscussions(empty, disc({ status: 'draft' }), {
      phase: 'discussion',
      showStart: true,
    })
    expect(w.find('.disc-start-btn').exists()).toBe(true)
  })

  it('hides Start while research is running (phase = research, showStart false)', () => {
    const w = mountDiscussions(empty, disc({ status: 'draft' }), {
      phase: 'research',
      showStart: false,
    })
    expect(w.find('.disc-start-btn').exists()).toBe(false)
  })

  it('emits start when the Start button is clicked', async () => {
    const w = mountDiscussions(empty, disc({ status: 'draft' }), {
      phase: 'discussion',
      showStart: true,
    })
    await w.find('.disc-start-btn').trigger('click')
    expect(w.emitted('start')).toBeTruthy()
  })
})
