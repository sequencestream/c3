import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Discussion } from '@ccc/shared/protocol'
import Discussions from './Discussions.vue'
import MobileStack from '../../components/MobileStack/MobileStack.vue'
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
    organizerAgentId: null,
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

describe('Discussions.vue — right-pane title bar + tabs', () => {
  const empty: DispatchView = { pending: [], errors: [] }

  // Click a right-pane tab by its stable kind so assertions survive i18n label changes.
  async function clickTab(w: ReturnType<typeof mountDiscussions>, kind: string): Promise<void> {
    const tab = w.find(`[data-testid="discussion-pane-tab-${kind}"]`)
    if (!tab.exists()) throw new Error(`pane tab not found: ${kind}`)
    await tab.trigger('click')
  }

  it('default tab follows conclusion → process: a completed discussion opens on conclusion', () => {
    const w = mountDiscussions(empty, disc({ status: 'completed', conclusion: 'Use 60s TTL' }))
    // conclusion is a markdown tab → process stream is hidden, markdown body shows.
    expect(w.find('[data-testid="discussion-pane-md"]').exists()).toBe(true)
    expect(w.find('[data-testid="discussion-pane-md"]').text()).toContain('Use 60s TTL')
    expect(w.find('[data-testid="discussion-stream"]').exists()).toBe(false)
  })

  it('default tab falls to process for an in-progress discussion without a conclusion', () => {
    const w = mountDiscussions(empty, disc({ status: 'in_progress' }), { phase: 'discussion' })
    expect(w.find('[data-testid="discussion-stream"]').exists()).toBe(true)
    expect(w.find('[data-testid="discussion-pane-md"]').exists()).toBe(false)
  })

  it('only non-empty markdown fields get a tab; process + details are always present', () => {
    const w = mountDiscussions(empty, disc({ status: 'in_progress', goal: 'G', conclusion: '' }))
    const kinds = w
      .findAll('[data-testid^="discussion-pane-tab-"]')
      .map((b) => b.attributes('data-tab'))
    expect(kinds).toEqual(['goal', 'process', 'details'])
  })

  it('the title bar and its actions stay constant across tab switches', async () => {
    const w = mountDiscussions(empty, disc({ status: 'completed', goal: 'G', conclusion: 'C' }))
    // Completed → Convert action + title bar present on the default (conclusion) tab.
    expect(w.find('.session-title-bar').exists()).toBe(true)
    expect(w.find('.disc-start-btn').exists()).toBe(true)
    // Switch to the process tab — title bar + action remain.
    await clickTab(w, 'process')
    expect(w.find('.session-title-bar').exists()).toBe(true)
    expect(w.find('.disc-start-btn').exists()).toBe(true)
    // Switch to goal (markdown) tab — still there.
    await clickTab(w, 'goal')
    expect(w.find('.session-title-bar').exists()).toBe(true)
    expect(w.find('.disc-start-btn').exists()).toBe(true)
  })

  it('details tab renders structured meta and hides process content', async () => {
    const w = mountDiscussions(empty, disc({ status: 'in_progress' }), { phase: 'discussion' })
    await clickTab(w, 'details')
    expect(w.find('[data-testid="disc-meta-type"]').exists()).toBe(true)
    expect(w.find('[data-testid="disc-meta-status"]').exists()).toBe(true)
    expect(w.find('[data-testid="disc-meta-created"]').exists()).toBe(true)
    // Process content (stream / composer) is not in the details tab.
    expect(w.find('[data-testid="discussion-stream"]').exists()).toBe(false)
    expect(w.find('.disc-composer').exists()).toBe(false)
  })

  it('dispatch strip and composer render only in the process tab', async () => {
    const w = mountDiscussions(
      { pending: [{ id: 'a', name: 'Alice' }], errors: [] },
      disc({ status: 'in_progress', conclusion: 'C' }),
      { phase: 'discussion' },
    )
    // Default tab is conclusion (has a conclusion) → no dispatch / composer.
    expect(w.find('.disc-dispatch').exists()).toBe(false)
    expect(w.find('.disc-composer').exists()).toBe(false)
    // Switch to process → both appear.
    await clickTab(w, 'process')
    expect(w.find('.disc-dispatch').exists()).toBe(true)
    expect(w.find('.disc-composer').exists()).toBe(true)
  })

  it('research and discussion phases stay mutually exclusive inside the process tab', () => {
    const research = mountDiscussions(empty, disc({ status: 'draft' }), { phase: 'research' })
    expect(research.find('[data-testid="research-stream"]').exists()).toBe(true)
    expect(research.find('[data-testid="discussion-stream"]').exists()).toBe(false)
    const discussion = mountDiscussions(empty, disc({ status: 'in_progress' }), {
      phase: 'discussion',
    })
    expect(discussion.find('[data-testid="discussion-stream"]').exists()).toBe(true)
    expect(discussion.find('[data-testid="research-stream"]').exists()).toBe(false)
  })

  it('mobile drill-down: the right-pane detail is the second pane, back forwards mobile-back', () => {
    const w = mountDiscussions(empty, disc({ status: 'in_progress' }))
    const stack = w.findComponent(MobileStack)
    // The open discussion (activeId) drills into the `history` (right-pane detail) pane.
    expect(stack.props('activeKey')).toBe('history')
    // MobileStack's back is forwarded up as `mobile-back` so the parent returns to the list.
    stack.vm.$emit('back', 'discussions')
    expect(w.emitted('mobile-back')).toEqual([['discussions']])
  })
})
