// @vitest-environment happy-dom
/* eslint-disable vue/one-component-per-file */

import { mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import type { Intent } from '@ccc/shared/protocol'
import Intents from './Intents.vue'

function intent(overrides: Partial<Intent> & { id: string }): Intent {
  return {
    workspaceId: '/proj',
    title: 'Intent',
    shortEnTitle: null,
    content: 'Do work',
    priority: 'P1',
    module: '',
    status: 'todo',
    dependsOn: [],
    dependsOnTypes: {},
    lastWorkSessionId: null,
    automate: false,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    runStatus: 'idle',
    branchName: null,
    latestCommitHash: null,
    prId: null,
    prUrl: null,
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

const MobileStackStub = defineComponent({
  name: 'MobileStack',
  template: '<div><slot name="list" /><slot name="right" /></div>',
})

const IntentDetailStub = defineComponent({
  name: 'IntentDetail',
  props: {
    intent: { type: Object, default: null },
  },
  template: '<div data-testid="intent-detail">{{ intent?.id ?? "" }}</div>',
})

const ChatColumnStub = defineComponent({
  name: 'ChatColumn',
  template: '<div data-testid="standalone-chat" />',
})

function mountIntents(intents: Intent[]) {
  return mount(Intents, {
    props: {
      project: '/proj',
      intents,
      automation: null,
      intentSpecContent: null,
      intentSpecLoading: false,
      activeSession: null,
      activeTitle: '',
      hasActiveSession: false,
      messages: [],
      actionablePermissionId: null,
      taskModel: { tasks: [] },
      running: false,
      teamActive: false,
      connection: 'open',
      activity: { phase: 'idle' },
      queue: [],
      availableCommands: [],
      voiceLang: 'en-US',
    },
    global: {
      stubs: {
        MobileStack: MobileStackStub,
        IntentDetail: IntentDetailStub,
        ChatColumn: ChatColumnStub,
      },
    },
  })
}

describe('Intents.vue — default selected intent', () => {
  it('shows the left list first rendered intent in the right detail, not server order first', async () => {
    const wrapper = mountIntents([
      intent({ id: 'done-p0', status: 'done', priority: 'P0', completedAt: 100 }),
      intent({ id: 'todo-p1', status: 'todo', priority: 'P1' }),
    ])

    await nextTick()

    expect(wrapper.find('[data-testid="intent-detail"]').text()).toBe('todo-p1')
  })

  it('continues tracking the rendered first intent until the user manually selects a row', async () => {
    const wrapper = mountIntents([
      intent({ id: 'todo-old', status: 'todo', priority: 'P1' }),
      intent({ id: 'done-p0', status: 'done', priority: 'P0', completedAt: 100 }),
    ])
    await nextTick()
    expect(wrapper.find('[data-testid="intent-detail"]').text()).toBe('todo-old')

    await wrapper.setProps({
      intents: [
        intent({ id: 'done-p0', status: 'done', priority: 'P0', completedAt: 100 }),
        intent({ id: 'todo-new', status: 'todo', priority: 'P1' }),
      ],
    })
    await nextTick()

    expect(wrapper.find('[data-testid="intent-detail"]').text()).toBe('todo-new')

    await wrapper.findAll('.req-item-main')[1].trigger('click')
    expect(wrapper.find('[data-testid="intent-detail"]').text()).toBe('done-p0')

    await wrapper.setProps({
      intents: [
        intent({ id: 'done-p0', status: 'done', priority: 'P0', completedAt: 100 }),
        intent({ id: 'todo-newer', status: 'todo', priority: 'P1' }),
      ],
    })
    await nextTick()

    expect(wrapper.find('[data-testid="intent-detail"]').text()).toBe('done-p0')
  })
})

describe('Intents.vue — external select request (jump from work session)', () => {
  it('selects the requested intent over the default first row and emits consumed', async () => {
    const wrapper = mountIntents([
      intent({ id: 'todo-a', status: 'todo', priority: 'P1' }),
      intent({ id: 'todo-b', status: 'todo', priority: 'P2' }),
    ])
    await nextTick()
    // Default selection is the first rendered row.
    expect(wrapper.find('[data-testid="intent-detail"]').text()).toBe('todo-a')

    await wrapper.setProps({ requestedIntentId: 'todo-b' })
    await nextTick()

    expect(wrapper.find('[data-testid="intent-detail"]').text()).toBe('todo-b')
    expect(wrapper.emitted('requested-intent-consumed')).toHaveLength(1)
  })

  it('applies the request once the target lands in a later-loaded list', async () => {
    const wrapper = mountIntents([])
    // Request arrives before the list loads — silently waits, no consume yet.
    await wrapper.setProps({ requestedIntentId: 'todo-late' })
    await nextTick()
    expect(wrapper.emitted('requested-intent-consumed')).toBeUndefined()

    await wrapper.setProps({
      intents: [
        intent({ id: 'todo-first', status: 'todo', priority: 'P1' }),
        intent({ id: 'todo-late', status: 'todo', priority: 'P2' }),
      ],
    })
    await nextTick()

    expect(wrapper.find('[data-testid="intent-detail"]').text()).toBe('todo-late')
    expect(wrapper.emitted('requested-intent-consumed')).toHaveLength(1)
  })

  it('opens the standalone chat (not a detail) when a standalone intent-session is requested', async () => {
    const wrapper = mountIntents([intent({ id: 'todo-a', status: 'todo', priority: 'P1' })])
    await nextTick()
    expect(wrapper.find('[data-testid="intent-detail"]').exists()).toBe(true)

    await wrapper.setProps({ requestedIntentSessionId: 'chat-99' })
    await nextTick()

    // Right column flips to the standalone chat bound to the active session.
    expect(wrapper.find('[data-testid="standalone-chat"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="intent-detail"]').exists()).toBe(false)
    expect(wrapper.emitted('requested-intent-session-consumed')).toHaveLength(1)
  })

  it('ignores a request whose target never appears, leaving the default selection', async () => {
    const wrapper = mountIntents([intent({ id: 'todo-a', status: 'todo', priority: 'P1' })])
    await nextTick()

    await wrapper.setProps({ requestedIntentId: 'missing' })
    await nextTick()

    expect(wrapper.find('[data-testid="intent-detail"]').text()).toBe('todo-a')
    expect(wrapper.emitted('requested-intent-consumed')).toBeUndefined()
  })
})

describe('Intents.vue — dependency selection', () => {
  it('selects the dependency so its detail and left-list highlight update', async () => {
    const wrapper = mountIntents([
      intent({ id: 'current', status: 'todo', priority: 'P1' }),
      intent({ id: 'dependency', status: 'todo', priority: 'P2' }),
    ])
    await nextTick()

    wrapper.findComponent(IntentDetailStub).vm.$emit('select-dependency', 'dependency')
    await nextTick()

    expect(wrapper.find('[data-testid="intent-detail"]').text()).toBe('dependency')
    expect(wrapper.find('[data-intent-id="dependency"]').classes()).toContain('selected')
  })
})

describe('Intents.vue — right column', () => {
  it('shows the intent detail for the selected intent by default', async () => {
    const wrapper = mountIntents([intent({ id: 'todo-1', status: 'todo', priority: 'P1' })])
    await nextTick()

    expect(wrapper.find('[data-testid="intent-detail"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="standalone-chat"]').exists()).toBe(false)
    // The old segmented control stays gone — the left column is the intent list only.
    expect(wrapper.find('[data-testid="tab-sessions"]').exists()).toBe(false)
  })

  it('clicking "+" toggles the right column to a standalone intent-session chat and emits new-intent-session', async () => {
    const wrapper = mountIntents([intent({ id: 'todo-1', status: 'todo', priority: 'P1' })])
    await nextTick()

    await wrapper.find('[data-testid="intent-list-new-session"]').trigger('click')

    expect(wrapper.emitted('new-intent-session')).toHaveLength(1)
    expect(wrapper.find('[data-testid="standalone-chat"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="intent-detail"]').exists()).toBe(false)
  })

  it('selecting an intent row toggles back from the standalone chat to the detail', async () => {
    const wrapper = mountIntents([intent({ id: 'todo-1', status: 'todo', priority: 'P1' })])
    await nextTick()
    await wrapper.find('[data-testid="intent-list-new-session"]').trigger('click')
    expect(wrapper.find('[data-testid="standalone-chat"]').exists()).toBe(true)

    await wrapper.find('[data-intent-id="todo-1"] .req-item-main').trigger('click')

    expect(wrapper.find('[data-testid="intent-detail"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="standalone-chat"]').exists()).toBe(false)
  })
})
