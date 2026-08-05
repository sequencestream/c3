import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ActionDescriptor } from '@ccc/shared/protocol'
import ActionDescriptorBanner from './ActionDescriptorBanner.vue'
import { ACTION_MESSAGE_KEYS, ACTION_BUTTON_KEYS } from '@/lib/action-descriptor'

const AUTH: ActionDescriptor = {
  labelCode: 'vendor_auth_invalid',
  target: { type: 'system-settings-agent', vendor: 'claude', agentId: 'agent-1' },
}

const EXHAUSTED: ActionDescriptor = {
  labelCode: 'spec_rework_exhausted',
  target: { type: 'intent-spec', intentId: 'i1' },
}

const DEP: ActionDescriptor = {
  labelCode: 'dependency_blocked',
  target: { type: 'intent-detail', intentId: 'i2' },
}

function mountBanner(
  descriptor: ActionDescriptor | null,
  reviewReason?: string | null,
  targetIntent?: { title: string; status: import('@ccc/shared/protocol').IntentStatus } | null,
) {
  return mount(ActionDescriptorBanner, { props: { descriptor, reviewReason, targetIntent } })
}

describe('ActionDescriptorBanner.vue', () => {
  it('renders nothing when nothing blocks the intent', () => {
    const w = mountBanner(null)
    expect(w.find('[data-testid="action-descriptor-banner"]').exists()).toBe(false)
  })

  it('announces itself as an alert with visible text, not colour alone', () => {
    const w = mountBanner(AUTH)
    const banner = w.find('[data-testid="action-descriptor-banner"]')
    expect(banner.attributes('role')).toBe('alert')
    // The situation and the way out must both be readable text — an icon or a
    // red tint alone would be invisible to a screen reader and to a colour-blind
    // user.
    expect(w.find('[data-testid="action-descriptor-message"]').text().length).toBeGreaterThan(0)
    expect(w.find('[data-testid="action-descriptor-action"]').text().length).toBeGreaterThan(0)
  })

  it('offers the action as a real button (focusable, enter-activatable)', () => {
    const w = mountBanner(AUTH)
    const action = w.find('[data-testid="action-descriptor-action"]')
    expect(action.element.tagName).toBe('BUTTON')
    expect(action.attributes('type')).toBe('button')
    // No tabindex override and no disabled state: it is in the tab order and a
    // native button fires click on both Enter and Space.
    expect(action.attributes('tabindex')).toBeUndefined()
    expect(action.attributes('disabled')).toBeUndefined()
  })

  it('emits the wire target on click and navigates nowhere itself', async () => {
    const w = mountBanner(AUTH)
    await w.find('[data-testid="action-descriptor-action"]').trigger('click')
    expect(w.emitted('navigate')).toEqual([[AUTH.target]])
  })

  it('renders a distinct message per label code', () => {
    const auth = mountBanner(AUTH).find('[data-testid="action-descriptor-message"]').text()
    const quota = mountBanner({ ...AUTH, labelCode: 'vendor_quota_exhausted' })
      .find('[data-testid="action-descriptor-message"]')
      .text()
    expect(auth).not.toBe(quota)
    const spec = mountBanner({
      labelCode: 'spec_awaiting_approval',
      target: { type: 'intent-spec', intentId: 'i1' },
    })
      .find('[data-testid="action-descriptor-message"]')
      .text()
    const ask = mountBanner({
      labelCode: 'ask_user_question_pending',
      target: { type: 'workcenter-event', eventId: 'e1' },
    })
      .find('[data-testid="action-descriptor-message"]')
      .text()
    expect(spec).not.toBe(auth)
    expect(ask).not.toBe(spec)
  })

  it('shows the review blocker and a single manual take-over action once rework is exhausted', () => {
    const w = mountBanner(EXHAUSTED, '缺少错误路径的验收项')
    expect(w.find('[data-testid="action-descriptor-message"]').text()).not.toBe('')
    expect(w.find('[data-testid="action-descriptor-blocker"]').text()).toBe('缺少错误路径的验收项')
    // Exactly one action, and it is the manual take-over — no retry / try-again
    // path back into the loop that already failed three times.
    const actions = w.findAll('[data-testid="action-descriptor-action"]')
    expect(actions).toHaveLength(1)
    const label = actions[0].text()
    expect(label).not.toMatch(/retry|try again|重试|再试/i)
    expect(label).not.toBe(
      mountBanner({ ...EXHAUSTED, labelCode: 'spec_awaiting_approval' })
        .find('[data-testid="action-descriptor-action"]')
        .text(),
    )
  })

  it('falls back to plain copy when the review left no rationale, inventing no criteria', () => {
    for (const reason of [null, '   ']) {
      const blocker = mountBanner(EXHAUSTED, reason).find(
        '[data-testid="action-descriptor-blocker"]',
      )
      expect(blocker.exists()).toBe(true)
      expect(blocker.text().length).toBeGreaterThan(0)
    }
  })

  it('renders the blocker as text: newlines survive, markup does not become HTML', () => {
    const w = mountBanner(EXHAUSTED, 'line one\nline two <img src=x onerror="alert(1)">')
    const blocker = w.find('[data-testid="action-descriptor-blocker"]')
    expect(blocker.element.querySelector('img')).toBeNull()
    expect(blocker.element.innerHTML).not.toContain('<img')
    expect(blocker.element.textContent).toContain('line one\nline two')
    // Scoped styles are not applied in the test DOM; the class is what carries
    // `white-space: pre-wrap`, so a blocker without it would collapse the newline.
    expect(blocker.classes()).toContain('ad-blocker')
  })

  it('shows no blocker line for blocks that carry no review reason', () => {
    expect(
      mountBanner(AUTH, 'ignored').find('[data-testid="action-descriptor-blocker"]').exists(),
    ).toBe(false)
  })

  it('maps every label code and target type to copy', () => {
    // The maps are `satisfies Record<…>`-exhaustive at compile time; this pins
    // that they are also non-empty at runtime, so no code renders a blank prompt.
    for (const key of Object.values(ACTION_MESSAGE_KEYS)) expect(key).toBeTruthy()
    for (const key of Object.values(ACTION_BUTTON_KEYS)) expect(key).toBeTruthy()
  })
})

describe('ActionDescriptorBanner.vue — dependency blocked', () => {
  it('names the predecessor title and status in the prompt', () => {
    const w = mountBanner(DEP, null, { title: '打底能力', status: 'todo' })
    const message = w.find('[data-testid="action-descriptor-message"]').text()
    expect(message).toContain('打底能力')
    // The status is spelled out as its readable label, never left to colour alone.
    expect(message).toContain('To do')
  })

  it('offers the view-predecessor action as a real keyboard-activatable button', () => {
    const w = mountBanner(DEP, null, { title: '打底能力', status: 'todo' })
    const action = w.find('[data-testid="action-descriptor-action"]')
    expect(action.element.tagName).toBe('BUTTON')
    expect(action.attributes('type')).toBe('button')
    expect(action.attributes('tabindex')).toBeUndefined()
    expect(action.attributes('disabled')).toBeUndefined()
  })

  it('emits the intent-detail target on click and navigates nowhere itself', async () => {
    const w = mountBanner(DEP, null, { title: '打底能力', status: 'todo' })
    await w.find('[data-testid="action-descriptor-action"]').trigger('click')
    expect(w.emitted('navigate')).toEqual([[DEP.target]])
  })

  it('falls back to a copy that claims no title when the predecessor is out of view', () => {
    const w = mountBanner(DEP, null, null)
    const message = w.find('[data-testid="action-descriptor-message"]').text()
    expect(message.length).toBeGreaterThan(0)
    // Never a bare id, never a fabricated title.
    expect(message).not.toContain('i2')
  })
})
