import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ActionDescriptor } from '@ccc/shared/protocol'
import ActionDescriptorBanner from './ActionDescriptorBanner.vue'
import { ACTION_MESSAGE_KEYS, ACTION_BUTTON_KEYS } from '@/lib/action-descriptor'

const AUTH: ActionDescriptor = {
  labelCode: 'vendor_auth_invalid',
  target: { type: 'system-settings-agent', vendor: 'claude', agentId: 'agent-1' },
}

function mountBanner(descriptor: ActionDescriptor | null) {
  return mount(ActionDescriptorBanner, { props: { descriptor } })
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
  })

  it('maps every label code and target type to copy', () => {
    // The maps are `satisfies Record<…>`-exhaustive at compile time; this pins
    // that they are also non-empty at runtime, so no code renders a blank prompt.
    for (const key of Object.values(ACTION_MESSAGE_KEYS)) expect(key).toBeTruthy()
    for (const key of Object.values(ACTION_BUTTON_KEYS)) expect(key).toBeTruthy()
  })
})
