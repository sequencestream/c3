// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import SpecStartupOverlay from './SpecStartupOverlay.vue'

describe('SpecStartupOverlay', () => {
  it('renders done, active, and pending step markers', () => {
    const wrapper = mount(SpecStartupOverlay, {
      props: {
        model: {
          intentId: 'intent-1',
          phase: 'pulling-code',
          startedAt: 0,
          visibleAt: 0,
        },
      },
    })

    expect(wrapper.find('[data-status="done"] .sso-check').text()).toBe('✓')
    expect(wrapper.find('[data-status="active"] .sso-spinner').exists()).toBe(true)
    expect(wrapper.find('[data-status="pending"] .sso-dot').exists()).toBe(true)
  })
})
