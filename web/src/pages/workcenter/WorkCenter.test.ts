/**
 * WorkCenter frontend coverage for the consensus-auto audit surface + the
 * EventDetail attribute list.
 *
 * - WorkCenter.vue: the 'auto' status filter exists, filters the list, and any
 *   filter change emits `reload`; the default All filter shows all statuses.
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
import EventList from './components/EventList.vue'
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

const askToolInput = {
  questions: [
    {
      header: 'Deployment target',
      question: 'Where should this run?',
      options: [
        { label: 'Staging', description: 'Use the staging cluster' },
        { label: 'Production', description: 'Use the production cluster' },
      ],
    },
    {
      header: 'Follow-up',
      question: 'Which checks should run?',
      multiSelect: true,
      options: [
        { label: 'Unit tests', description: 'Fast tests only' },
        { label: 'E2E tests', description: 'Browser coverage' },
      ],
    },
  ],
}

const askOutcome: AnyConsensusOutcome = {
  kind: 'ask',
  perQuestion: [
    {
      index: 0,
      question: 'Where should this run?',
      header: 'Deployment target',
      multiSelect: false,
      answers: [
        {
          agentId: 'a1',
          agentName: 'Planner',
          optionLabels: ['Staging'],
          reason: 'Safer rollout',
        },
      ],
      unanimous: true,
      agreed: 'Staging',
    },
    {
      index: 1,
      question: 'Which checks should run?',
      header: 'Follow-up',
      multiSelect: true,
      answers: [
        {
          agentId: 'a2',
          agentName: 'Reviewer',
          optionLabels: [],
          custom: 'Run smoke tests too',
          reason: 'Covers the risky path',
        },
      ],
      unanimous: false,
      agreed: null,
    },
  ],
  fullyUnanimous: false,
  agreedAnswers: { 'Where should this run?': 'Staging' },
  summary: 'Use staging and add smoke coverage',
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

async function selectDropdownItem(wrapper: ReturnType<typeof mount>, index: number): Promise<void> {
  await wrapper.find('.dd-trigger').trigger('click')
  await wrapper.findAll('.dd-item')[index].trigger('click')
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
      props: {
        events: [ev()],
        hasMore: false,
        loading: false,
        currentWorkspace: '/ws',
        workspaces: WORKSPACES,
      },
    })

    expect(wrapper.find('.wc-list-toggle').exists()).toBe(true)
    expect(wrapper.find('.wc-sidebar').classes()).not.toContain('expanded')
  })

  it('toggles the sidebar expanded class on click', async () => {
    const wrapper = mount(WorkCenter, {
      props: {
        events: [ev()],
        hasMore: false,
        loading: false,
        currentWorkspace: '/ws',
        workspaces: WORKSPACES,
      },
    })

    await wrapper.find('.wc-list-toggle').trigger('click')
    expect(wrapper.find('.wc-sidebar').classes()).toContain('expanded')

    await wrapper.find('.wc-list-toggle').trigger('click')
    expect(wrapper.find('.wc-sidebar').classes()).not.toContain('expanded')
  })

  it('does not render the list toggle on mobile', () => {
    installMatchMedia(true)

    const wrapper = mount(WorkCenter, {
      props: {
        events: [ev()],
        hasMore: false,
        loading: false,
        currentWorkspace: '/ws',
        workspaces: WORKSPACES,
      },
    })

    expect(wrapper.find('.wc-list-toggle').exists()).toBe(false)
  })
})

describe('WorkCenter.vue — mobile drill-down', () => {
  it('starts on the list pane and renders no back button', () => {
    installMatchMedia(true)
    const wrapper = mount(WorkCenter, {
      props: {
        events: [ev({ status: 'todo', requestId: 'r1', toolName: 'edit_file' })],
        hasMore: false,
        loading: false,
        currentWorkspace: '/ws',
        workspaces: WORKSPACES,
      },
    })

    // The stack renders in mobile mode with the list pane on top.
    expect(wrapper.find('[data-testid="mobile-stack-mobile"]').exists()).toBe(true)
    const pane = wrapper.find('[data-testid="mobile-stack-pane"]')
    expect(pane.attributes('data-pane-key')).toBe('list')
    // List pane shows rows; no detail action controls are on screen yet.
    expect(wrapper.find('.wc-event-row').exists()).toBe(true)
    expect(wrapper.find('.wc-btn-allow').exists()).toBe(false)
    expect(wrapper.find('[data-testid="mobile-stack-back"]').exists()).toBe(false)
  })

  it('drills into the detail pane on row click with allow/deny operable', async () => {
    installMatchMedia(true)
    const wrapper = mount(WorkCenter, {
      props: {
        events: [ev({ id: 'appr-1', status: 'todo', requestId: 'r1', toolName: 'edit_file' })],
        hasMore: false,
        loading: false,
        currentWorkspace: '/ws',
        workspaces: WORKSPACES,
      },
    })

    await wrapper.find('.wc-event-row').trigger('click')

    const pane = wrapper.find('[data-testid="mobile-stack-pane"]')
    expect(pane.attributes('data-pane-key')).toBe('detail')
    // The list is no longer on the stack top; the detail action buttons are reachable.
    expect(wrapper.find('.wc-event-row').exists()).toBe(false)
    expect(wrapper.find('.wc-btn-allow').exists()).toBe(true)

    await wrapper.find('.wc-btn-allow').trigger('click')
    expect(wrapper.emitted('respond')?.[0]?.[1]).toBe('allow')
  })

  it('drills into an AskUserQuestion detail with the answer panel operable', async () => {
    installMatchMedia(true)
    const wrapper = mount(WorkCenter, {
      props: {
        events: [
          ev({
            id: 'ask-1',
            status: 'todo',
            requestId: null,
            toolName: 'AskUserQuestion',
            toolInput: askToolInput,
          }),
        ],
        hasMore: false,
        loading: false,
        currentWorkspace: '/ws',
        workspaces: WORKSPACES,
      },
    })

    await wrapper.find('.wc-event-row').trigger('click')
    expect(wrapper.find('[data-testid="mobile-stack-pane"]').attributes('data-pane-key')).toBe(
      'detail',
    )
    expect(wrapper.find('.wc-ask-panel').exists()).toBe(true)
    expect(wrapper.findAll('input[type="radio"]').length).toBeGreaterThan(0)
  })

  it('returns to the list pane on back, keeping the filter value and selection highlight', async () => {
    installMatchMedia(true)
    const wrapper = mount(WorkCenter, {
      props: {
        events: [
          ev({ id: 'todo-1', status: 'todo', requestId: 'r1', toolName: 'edit_file' }),
          ev({ id: 'todo-2', status: 'todo', requestId: 'r1', toolName: 'edit_file' }),
        ],
        hasMore: false,
        loading: false,
        currentWorkspace: '/ws',
        workspaces: WORKSPACES,
      },
    })

    await wrapper.find('.wc-event-row').trigger('click')
    expect(wrapper.find('[data-testid="mobile-stack-pane"]').attributes('data-pane-key')).toBe(
      'detail',
    )

    await wrapper.find('[data-testid="mobile-stack-back"]').trigger('click')
    // Back returns to the list pane; the previously selected row stays highlighted.
    expect(wrapper.find('[data-testid="mobile-stack-pane"]').attributes('data-pane-key')).toBe(
      'list',
    )
    expect(wrapper.find('.wc-event-row.selected').exists()).toBe(true)
    // The filter dropdown value is untouched by the drill-down round-trip.
    expect(wrapper.find('.dd-value').text()).toBe('All')

    // Re-tapping the same row drills back into its detail (explicit pane state, not a
    // pure derivation that a same-id selection could not re-trigger).
    await wrapper.find('.wc-event-row.selected').trigger('click')
    expect(wrapper.find('[data-testid="mobile-stack-pane"]').attributes('data-pane-key')).toBe(
      'detail',
    )
  })

  it('clears selection and stays on the list pane when the filter changes', async () => {
    installMatchMedia(true)
    const wrapper = mount(WorkCenter, {
      props: {
        events: [
          ev({ id: 'todo-1', status: 'todo', requestId: 'r1', toolName: 'edit_file' }),
          ev({ id: 'done-1', status: 'done' }),
        ],
        hasMore: false,
        loading: false,
        currentWorkspace: '/ws',
        workspaces: WORKSPACES,
      },
    })

    // Drill in, then back to the list pane (where the filter dropdown lives on mobile).
    await wrapper.find('.wc-event-row').trigger('click')
    await wrapper.find('[data-testid="mobile-stack-back"]').trigger('click')
    expect(wrapper.find('.wc-event-row.selected').exists()).toBe(true)

    // Switch the filter to Done: selection clears, mobile stays on list, reload emitted
    // with the new status.
    await selectDropdownItem(wrapper, 2)
    expect(wrapper.find('[data-testid="mobile-stack-pane"]').attributes('data-pane-key')).toBe(
      'list',
    )
    expect(wrapper.find('.wc-event-row.selected').exists()).toBe(false)
    expect(wrapper.emitted('reload')).toEqual([['done']])
  })
})

describe('WorkCenter.vue — status filter', () => {
  it('renders a title and status dropdown that defaults to All', async () => {
    const events = [
      ev({ status: 'todo' }),
      ev({ status: 'auto', outcome: toolOutcome }),
      ev({ status: 'done' }),
    ]
    const wrapper = mount(WorkCenter, {
      props: {
        events,
        hasMore: false,
        loading: false,
        currentWorkspace: '/ws',
        workspaces: WORKSPACES,
      },
    })

    expect(wrapper.find('.wc-sidebar-title').exists()).toBe(true)
    expect(wrapper.find('.dd').exists()).toBe(true)
    expect(wrapper.find('.dd-value').text()).toBe('All')
    await wrapper.find('.dd-trigger').trigger('click')
    expect(wrapper.findAll('.dd-item')).toHaveLength(5)

    // Default filter is All: every status is visible.
    expect(wrapper.findAll('.wc-event-row')).toHaveLength(3)

    await wrapper.findAll('.dd-item')[4].trigger('click')
    expect(wrapper.findAll('.wc-event-row')).toHaveLength(1)

    await selectDropdownItem(wrapper, 0)
    expect(wrapper.findAll('.wc-event-row')).toHaveLength(3)
  })

  it('emits reload on every filter switch, using undefined for All', async () => {
    const wrapper = mount(WorkCenter, {
      props: {
        events: [ev()],
        hasMore: false,
        loading: false,
        currentWorkspace: '/ws',
        workspaces: WORKSPACES,
      },
    })
    await selectDropdownItem(wrapper, 4)
    await selectDropdownItem(wrapper, 2)
    await selectDropdownItem(wrapper, 0)
    expect(wrapper.emitted('reload')).toEqual([['auto'], ['done'], [undefined]])
  })

  it('emits load-more with the active filter and last visible row cursor', async () => {
    const events = [
      ev({ id: 'newer', status: 'todo', createdAt: 200 }),
      ev({ id: 'older', status: 'todo', createdAt: 100 }),
      ev({ id: 'done-hidden', status: 'done', createdAt: 50 }),
    ]
    const wrapper = mount(WorkCenter, {
      props: {
        events,
        hasMore: true,
        loading: false,
        currentWorkspace: '/ws',
        workspaces: WORKSPACES,
      },
    })

    await selectDropdownItem(wrapper, 1)
    await wrapper.find('.wc-load-more').trigger('click')
    expect(wrapper.emitted('load-more')).toEqual([['todo', 100, 'older']])
  })

  it('emits load-more with undefined status when All is selected', async () => {
    const events = [
      ev({ id: 'newer', status: 'todo', createdAt: 200 }),
      ev({ id: 'older-done', status: 'done', createdAt: 100 }),
    ]
    const wrapper = mount(WorkCenter, {
      props: {
        events,
        hasMore: true,
        loading: false,
        currentWorkspace: '/ws',
        workspaces: WORKSPACES,
      },
    })

    await wrapper.find('.wc-load-more').trigger('click')
    expect(wrapper.emitted('load-more')).toEqual([[undefined, 100, 'older-done']])
  })
})

describe('WorkCenter.vue — notification auto-complete', () => {
  it('marks todo notification events done after selection', async () => {
    const notice = ev({ id: 'notice-1', status: 'todo', requestId: null, toolName: 'NotifyUser' })
    const wrapper = mount(WorkCenter, {
      props: {
        events: [notice],
        hasMore: false,
        loading: false,
        currentWorkspace: '/ws',
        workspaces: WORKSPACES,
      },
    })

    await wrapper.find('.wc-event-row').trigger('click')
    expect(wrapper.emitted('mark-done')).toEqual([['notice-1']])
  })

  it('does not auto-complete approval or AskUserQuestion events after selection', async () => {
    const approval = ev({
      id: 'approval-1',
      status: 'todo',
      requestId: 'r1',
      toolName: 'edit_file',
    })
    const ask = ev({
      id: 'ask-1',
      status: 'todo',
      requestId: null,
      toolName: 'AskUserQuestion',
      toolInput: askToolInput,
    })
    const wrapper = mount(WorkCenter, {
      props: {
        events: [approval, ask],
        hasMore: false,
        loading: false,
        currentWorkspace: '/ws',
        workspaces: WORKSPACES,
      },
    })

    const rows = wrapper.findAll('.wc-event-row')
    await rows[0].trigger('click')
    await rows[1].trigger('click')
    expect(wrapper.emitted('mark-done')).toBeUndefined()
  })
})

describe('EventList.vue — row actions', () => {
  it('renders status at row end, shows Mark done only for todo, and emits actions', async () => {
    const todo = ev({ id: 'todo-1', status: 'todo' })
    const done = ev({ id: 'done-1', status: 'done' })
    const wrapper = mount(EventList, {
      props: { events: [todo, done], selectedId: null, hasMore: true, loading: false },
    })

    const rows = wrapper.findAll('.wc-event-row')
    expect(rows[0].find('.wc-row-actions .wc-status-badge').exists()).toBe(true)
    expect(rows[0].find('.wc-mark-done').exists()).toBe(true)
    expect(rows[1].find('.wc-mark-done').exists()).toBe(false)

    await rows[0].find('.wc-mark-done').trigger('click')
    expect(wrapper.emitted('mark-done')).toEqual([['todo-1']])

    await wrapper.find('.wc-load-more').trigger('click')
    expect(wrapper.emitted('load-more')).toEqual([[]])
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

describe('EventDetail.vue — AskUserQuestion', () => {
  it('renders every question and option in the panel without ordinary allow/deny controls', () => {
    const wrapper = mount(EventDetail, {
      props: {
        event: ev({
          toolName: 'AskUserQuestion',
          toolInput: askToolInput,
          outcome: askOutcome,
        }),
        workspaces: WORKSPACES,
      },
    })

    expect(wrapper.find('.wc-ask-panel').exists()).toBe(true)
    expect(wrapper.findAll('.wc-ask-q')).toHaveLength(2)
    expect(wrapper.text()).toContain('Deployment target')
    expect(wrapper.text()).toContain('Where should this run?')
    expect(wrapper.text()).toContain('Which checks should run?')
    expect(wrapper.text()).toContain('Staging')
    expect(wrapper.text()).toContain('E2E tests')
    expect(wrapper.findAll('.wc-detail-actions .wc-btn-allow')).toHaveLength(0)
    expect(wrapper.findAll('.wc-detail-actions .wc-btn-deny')).toHaveLength(0)
  })

  it('renders native single and multi-select inputs plus the custom reply option', () => {
    const wrapper = mount(EventDetail, {
      props: {
        event: ev({ toolName: 'AskUserQuestion', toolInput: askToolInput }),
        workspaces: WORKSPACES,
      },
    })

    expect(wrapper.findAll('input[type="radio"]')).toHaveLength(3)
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(3)
    expect(wrapper.find('.wc-ask-option-custom').exists()).toBe(true)
  })

  it('shows the custom reply text input after selecting the synthetic option', async () => {
    const wrapper = mount(EventDetail, {
      props: {
        event: ev({ toolName: 'AskUserQuestion', toolInput: askToolInput }),
        workspaces: WORKSPACES,
      },
    })

    await wrapper.findAll('.wc-ask-option-custom input')[0].setValue(true)
    expect(wrapper.find('.wc-ask-custom-input').exists()).toBe(true)
    await wrapper.find('.wc-ask-custom-input').setValue('Canary first')
    expect((wrapper.find('.wc-ask-custom-input').element as HTMLInputElement).value).toBe(
      'Canary first',
    )
  })

  it('keeps submit disabled until every question has an answer', async () => {
    const wrapper = mount(EventDetail, {
      props: {
        event: ev({ toolName: 'AskUserQuestion', toolInput: askToolInput }),
        workspaces: WORKSPACES,
      },
    })
    const submit = () => wrapper.find('.wc-ask-actions .wc-btn-allow')

    expect((submit().element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.findAll('input[type="radio"]')[0].setValue(true)
    expect((submit().element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.findAll('input[type="checkbox"]')[0].setValue(true)
    expect((submit().element as HTMLButtonElement).disabled).toBe(false)
  })

  it('emits submit-ask with question-text keyed answers', async () => {
    const event = ev({ toolName: 'AskUserQuestion', toolInput: askToolInput })
    const wrapper = mount(EventDetail, { props: { event, workspaces: WORKSPACES } })

    await wrapper.findAll('input[type="radio"]')[1].setValue(true)
    await wrapper.findAll('input[type="checkbox"]')[0].setValue(true)
    await wrapper.findAll('input[type="checkbox"]')[1].setValue(true)
    await wrapper.find('.wc-ask-actions .wc-btn-allow').trigger('click')

    expect(wrapper.emitted('submit-ask')?.[0]).toEqual([
      event,
      {
        'Where should this run?': 'Production',
        'Which checks should run?': 'Unit tests, E2E tests',
      },
    ])
  })

  it('renders ask consensus summary and agent hints inside the pending panel', () => {
    const wrapper = mount(EventDetail, {
      props: {
        event: ev({
          toolName: 'AskUserQuestion',
          toolInput: askToolInput,
          outcome: askOutcome,
        }),
        workspaces: WORKSPACES,
      },
    })

    expect(wrapper.find('.wc-ask-summary').text()).toContain('Use staging')
    expect(wrapper.findAll('.wc-ask-agent-badge').map((node) => node.text())).toContain('Planner')
    expect(wrapper.find('.wc-consensus').exists()).toBe(false)
  })

  it('renders done and canceled ask events as read-only history without action controls', () => {
    for (const status of ['done', 'canceled'] as const) {
      const wrapper = mount(EventDetail, {
        props: {
          event: ev({
            status,
            toolName: 'AskUserQuestion',
            toolInput: askToolInput,
            requestId: 'r1',
          }),
          workspaces: WORKSPACES,
        },
      })
      expect(wrapper.find('.wc-ask-readonly').exists()).toBe(true)
      expect(wrapper.find('.wc-ask-panel').exists()).toBe(false)
      expect(wrapper.find('.wc-btn-allow').exists()).toBe(false)
      expect(wrapper.find('.wc-btn-deny').exists()).toBe(false)
    }
  })

  it('renders auto ask outcome as a read-only consensus audit record', () => {
    const wrapper = mount(EventDetail, {
      props: {
        event: ev({
          status: 'auto',
          toolName: 'AskUserQuestion',
          toolInput: askToolInput,
          outcome: askOutcome,
        }),
        workspaces: WORKSPACES,
      },
    })

    expect(wrapper.find('.wc-consensus').exists()).toBe(true)
    expect(wrapper.find('.wc-consensus-summary').text()).toContain('Use staging')
    expect(wrapper.find('.wc-ask-panel').exists()).toBe(false)
    expect(wrapper.find('.wc-btn-allow').exists()).toBe(false)
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

  it('shows "Intent ID" label when intentLevel is true', () => {
    const wrapper = mount(EventDetail, {
      props: {
        event: ev({
          sessionKind: 'intent',
          sessionId: 'intent-self',
          intentId: 'intent-self',
          intentLevel: true,
        }),
        workspaces: WORKSPACES,
      },
    })
    const rows = wrapper.findAll('.wc-attr-row')
    // The session-id row label should be "Intent ID" (sessionId attribute rendered as intentId i18n key).
    expect(rows[2].find('.wc-attr-key').text()).toBe('Intent ID')
    expect(rows[2].find('.wc-attr-val').text()).toBe('intent-self')
  })

  it('shows "Session ID" label when intentLevel is false/absent', () => {
    const wrapper = mount(EventDetail, {
      props: {
        event: ev({
          sessionKind: 'intent',
          sessionId: 'sess-1',
          intentId: 'intent-42',
          intentLevel: false,
        }),
        workspaces: WORKSPACES,
      },
    })
    const rows = wrapper.findAll('.wc-attr-row')
    expect(rows[2].find('.wc-attr-key').text()).toBe('Session ID')
    expect(rows[2].find('.wc-attr-val').text()).toBe('sess-1')
  })
})
