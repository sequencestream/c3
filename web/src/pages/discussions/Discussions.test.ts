import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Discussion } from '@ccc/shared/protocol'
import Discussions from './Discussions.vue'
import MobileStack from '../../components/MobileStack/MobileStack.vue'
import ChatColumn from '../../components/ChatColumn/ChatColumn.vue'
import SessionStatusBar from '../../components/SessionStatusBar/SessionStatusBar.vue'
import MessageInput from '../../components/MessageInput/MessageInput.vue'
import type {
  DispatchView,
  DiscussionPhase,
  DiscussionLaunchAction,
} from '../../lib/discussion-view'
import type { ChatMsg, RunActivity } from '../../lib/chat-types'
import type { TaskListModel } from '../../lib/task-list'

function disc(over: Partial<Discussion> = {}): Discussion {
  return {
    id: 'd1',
    workspaceName: '/proj',
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
    metadata: {},
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
    launchAction?: DiscussionLaunchAction | null
    researchMessages?: ChatMsg[]
    activeRunState?: 'running' | 'paused' | undefined
    /** The globally active session — the research-session tab renders only on a match. */
    activeSession?: string | null
    sessionMessages?: ChatMsg[]
    running?: boolean
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
      launchAction: over.launchAction ?? null,
      dispatch,
      input: '',
      agents: [],
      defaultAgentId: null,
      // ---- research session chat column ----
      activeSession: over.activeSession ?? null,
      sessionTitle: 'Research',
      sessionHasActive: true,
      sessionMessages: over.sessionMessages ?? [],
      actionablePermissionId: null,
      taskModel: { tasks: [], collapsed: false } as unknown as TaskListModel,
      running: over.running ?? false,
      teamActive: false,
      connection: 'open' as const,
      activity: { kind: 'idle' } as unknown as RunActivity,
      queue: [],
      availableCommands: [],
      voiceLang: 'zh-CN',
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

describe('Discussions.vue — launch button visibility', () => {
  const empty: DispatchView = { pending: [], errors: [] }

  it("shows Start on launchAction 'start' (research ended/dead, discussion not started)", () => {
    const w = mountDiscussions(empty, disc({ status: 'draft' }), {
      phase: 'discussion',
      launchAction: 'start',
    })
    expect(w.find('.disc-start-btn').exists()).toBe(true)
  })

  it('hides the button while research is running (phase = research, launchAction null)', () => {
    const w = mountDiscussions(empty, disc({ status: 'draft' }), {
      phase: 'research',
      launchAction: null,
    })
    expect(w.find('.disc-start-btn').exists()).toBe(false)
  })

  it("marks the button as the restart variant on launchAction 'restart' (dangling in_progress)", () => {
    const w = mountDiscussions(empty, disc({ status: 'in_progress' }), {
      phase: 'discussion',
      launchAction: 'restart',
      activeRunState: undefined,
    })
    // 断言结构(变体 testid)而非可见文案。
    expect(w.find('[data-testid="discussion-launch-restart"]').exists()).toBe(true)
    expect(w.find('[data-testid="discussion-launch-start"]').exists()).toBe(false)
  })

  it('emits start when the launch button is clicked', async () => {
    const w = mountDiscussions(empty, disc({ status: 'draft' }), {
      phase: 'discussion',
      launchAction: 'start',
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

  it('the research-session tab appears only once the discussion has a research session', () => {
    const without = mountDiscussions(empty, disc({ status: 'in_progress' }))
    expect(without.find('[data-testid="discussion-pane-tab-researchSession"]').exists()).toBe(false)
    const withSession = mountDiscussions(
      empty,
      disc({ status: 'in_progress', researchSessionId: 's-res' }),
    )
    const kinds = withSession
      .findAll('[data-testid^="discussion-pane-tab-"]')
      .map((b) => b.attributes('data-tab'))
    expect(kinds).toEqual(['researchSession', 'process', 'details'])
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

describe('Discussions.vue — 研究会话 tab', () => {
  const empty: DispatchView = { pending: [], errors: [] }
  const withResearch = (over: Partial<Discussion> = {}): Discussion =>
    disc({ status: 'in_progress', researchSessionId: 's-res', ...over })

  it('asks the control layer to select the research session when the tab is opened', async () => {
    const w = mountDiscussions(empty, withResearch(), { activeSession: null })
    await w.find('[data-testid="discussion-pane-tab-researchSession"]').trigger('click')
    expect(w.emitted('open-research-session')).toEqual([['s-res']])
  })

  it('renders the placeholder (not the chat column) until the active session aligns', async () => {
    const w = mountDiscussions(empty, withResearch(), { activeSession: 'some-other-session' })
    await w.find('[data-testid="discussion-pane-tab-researchSession"]').trigger('click')
    expect(w.find('[data-testid="discussion-research-session"]').exists()).toBe(true)
    expect(w.findComponent(ChatColumn).exists()).toBe(false)
  })

  it('mounts the chat column (status bar + composer) once the active session matches', async () => {
    const w = mountDiscussions(empty, withResearch(), { activeSession: 's-res' })
    await w.find('[data-testid="discussion-pane-tab-researchSession"]').trigger('click')
    const chat = w.findComponent(ChatColumn)
    expect(chat.exists()).toBe(true)
    // The status bar and the composer are what make this a session rather than a log.
    expect(chat.findComponent(SessionStatusBar).exists()).toBe(true)
    expect(chat.findComponent(MessageInput).exists()).toBe(true)
    // No second title bar — the discussion's own one already sits above the tab strip.
    expect(chat.find('.session-title-bar').exists()).toBe(false)
  })

  it('forwards Stop and a follow-up submit onto the ordinary session channel', async () => {
    const w = mountDiscussions(empty, withResearch(), { activeSession: 's-res', running: true })
    await w.find('[data-testid="discussion-pane-tab-researchSession"]').trigger('click')
    const chat = w.findComponent(ChatColumn)
    chat.vm.$emit('stop')
    chat.vm.$emit('submit', 'please re-check the cache layer', [])
    expect(w.emitted('stop')).toBeTruthy()
    expect(w.emitted('session-submit')).toEqual([['please re-check the cache layer', []]])
  })

  it('opens on the research-session tab while the research run is live', () => {
    const w = mountDiscussions(empty, withResearch({ status: 'draft' }), {
      phase: 'research',
      activeSession: 's-res',
    })
    expect(w.find('[data-testid="discussion-research-session"]').exists()).toBe(true)
    // …and back to the ordinary chain once research has settled.
    const settled = mountDiscussions(empty, withResearch(), { phase: 'discussion' })
    expect(settled.find('[data-testid="discussion-research-session"]').exists()).toBe(false)
    expect(settled.find('[data-testid="discussion-stream"]').exists()).toBe(true)
  })

  // 创建流的真实时序:discussion_detail(无 researchSessionId、研究未跑)→ 研究跑批
  // running → 讨论列表广播携带 researchSessionId。
  it('create flow: lands on process first, then follows the research-session tab once it appears', async () => {
    const w = mountDiscussions(empty, disc({ status: 'draft' }), {
      phase: 'discussion',
      activeSession: null,
    })
    // 详情先到:研究会话 tab 还不存在 → 落过程会话(其中稍后展示实时研究流)
    expect(w.find('[data-testid="discussion-pane-tab-researchSession"]').exists()).toBe(false)
    expect(w.find('[data-testid="discussion-stream"]').exists()).toBe(true)
    // 研究跑批启动:仍未绑定 session id,过程会话里展示研究流
    await w.setProps({ phase: 'research' })
    expect(w.find('[data-testid="research-stream"]').exists()).toBe(true)
    // 厂商报出 session id 回写 → 研究会话 tab 出现,自动跟随过去并请求对齐活动会话
    await w.setProps({ activeDiscussion: disc({ status: 'draft', researchSessionId: 's-res' }) })
    expect(w.find('[data-testid="discussion-research-session"]').exists()).toBe(true)
    expect(w.find('[data-testid="research-stream"]').exists()).toBe(false)
    expect(w.emitted('open-research-session')).toEqual([['s-res']])
  })

  it('create flow: a tab the user picked themselves is never taken away', async () => {
    const w = mountDiscussions(empty, disc({ status: 'draft' }), {
      phase: 'discussion',
      activeSession: null,
    })
    await w.find('[data-testid="discussion-pane-tab-details"]').trigger('click')
    await w.setProps({ phase: 'research' })
    await w.setProps({ activeDiscussion: disc({ status: 'draft', researchSessionId: 's-res' }) })
    expect(w.find('[data-testid="disc-meta-type"]').exists()).toBe(true)
    expect(w.find('[data-testid="discussion-research-session"]').exists()).toBe(false)
    expect(w.emitted('open-research-session')).toBeFalsy()
    // 切到另一个讨论 → 保护复位,该讨论重新获得自己的默认落点(研究在跑且已绑定 ⇒ 研究会话)
    await w.setProps({
      activeId: 'd2',
      activeDiscussion: disc({ id: 'd2', status: 'draft', researchSessionId: 's-res-2' }),
    })
    expect(w.find('[data-testid="discussion-research-session"]').exists()).toBe(true)
  })

  it('research ending does not jump the tab back to the process tab', async () => {
    const w = mountDiscussions(empty, withResearch({ status: 'draft' }), {
      phase: 'research',
      activeSession: 's-res',
    })
    expect(w.find('[data-testid="discussion-research-session"]').exists()).toBe(true)
    // 研究结束、编排自动启动 → 用户留在研究会话,不被强制拽回过程会话
    await w.setProps({ phase: 'discussion', activeDiscussion: withResearch() })
    expect(w.find('[data-testid="discussion-research-session"]').exists()).toBe(true)
    expect(w.find('[data-testid="discussion-stream"]').exists()).toBe(false)
  })

  it('keeps the process tab reachable and unchanged alongside the new tab', async () => {
    const w = mountDiscussions(empty, withResearch(), { activeSession: 's-res' })
    await w.find('[data-testid="discussion-pane-tab-process"]').trigger('click')
    expect(w.find('[data-testid="discussion-stream"]').exists()).toBe(true)
    expect(w.find('.disc-composer').exists()).toBe(true)
    expect(w.find('[data-testid="discussion-research-session"]').exists()).toBe(false)
  })
})
