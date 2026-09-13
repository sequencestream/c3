import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import IntentDetailTabs from './IntentDetailTabs.vue'
import type { DetailTabItem } from './useIntentDetailTabs'

const TABS: DetailTabItem[] = [
  { key: 'intent', label: 'Intent' },
  { key: 'intentSession', label: 'Intent session' },
  { key: 'specSession', label: 'Spec session' },
  { key: 'specReviewSession', label: 'Spec review session' },
  { key: 'workSession', label: 'Work session' },
  { key: 'reviewSession', label: 'Review session' },
  { key: 'fixSession', label: 'Fix session' },
  { key: 'changelog', label: 'Changelog' },
]

function mountTabs(over: Record<string, unknown> = {}) {
  return mount(IntentDetailTabs, {
    props: {
      tabs: TABS,
      activeTab: 'intent',
      workSessionStatusDot: null,
      intentSessionStatusDot: null,
      specSessionStatusDot: null,
      specReviewSessionStatusDot: null,
      ...over,
    },
  })
}

describe('IntentDetailTabs.vue', () => {
  it('renders the visible tabs and marks the active one', () => {
    const w = mountTabs({ activeTab: 'changelog' })
    expect(w.findAll('.intent-detail-tab').map((b) => b.attributes('data-tab'))).toEqual([
      'intent',
      'intentSession',
      'specSession',
      'specReviewSession',
      'workSession',
      'reviewSession',
      'fixSession',
      'changelog',
    ])
    expect(w.find('.intent-detail-tab[data-tab="changelog"]').classes()).toContain('active')
    expect(w.find('.intent-detail-tab[data-tab="changelog"]').attributes('aria-pressed')).toBe(
      'true',
    )
  })

  it('emits select with the clicked tab key', async () => {
    const w = mountTabs()
    await w.find('.intent-detail-tab[data-tab="workSession"]').trigger('click')
    expect(w.emitted('select')).toEqual([['workSession']])
  })

  it('shows session status dots only when provided, keyed to the right tab', () => {
    const w = mountTabs({
      workSessionStatusDot: 'running',
      intentSessionStatusDot: 'awaiting_permission',
      specSessionStatusDot: 'team',
    })
    const work = w.find('[data-testid="intent-detail-work-session-status"]')
    const intentDot = w.find('[data-testid="intent-detail-intent-session-status"]')
    const specDot = w.find('[data-testid="intent-detail-spec-session-status"]')
    expect(work.classes()).toContain('running')
    expect(intentDot.classes()).toContain('awaiting_permission')
    expect(specDot.classes()).toContain('team')

    const none = mountTabs()
    expect(none.find('[data-testid="intent-detail-work-session-status"]').exists()).toBe(false)
    expect(none.find('[data-testid="intent-detail-intent-session-status"]').exists()).toBe(false)
    expect(none.find('[data-testid="intent-detail-spec-session-status"]').exists()).toBe(false)
  })

  it('scopes the review dot to the review tab and keeps it independent', async () => {
    const w = mountTabs({ specReviewSessionStatusDot: 'running' })
    const dots = w.findAll('[data-testid="intent-detail-spec-review-session-status"]')
    expect(dots).toHaveLength(1)
    expect(dots[0].classes()).toContain('running')
    expect(
      w.find('.intent-detail-tab[data-tab="specReviewSession"]').find('.session-status').exists(),
    ).toBe(true)
    // 评审会话在跑不影响编写规范/意图/工作会话的状态点。
    expect(w.find('[data-testid="intent-detail-spec-session-status"]').exists()).toBe(false)
    expect(w.find('[data-testid="intent-detail-intent-session-status"]').exists()).toBe(false)
    expect(w.find('[data-testid="intent-detail-work-session-status"]').exists()).toBe(false)

    // 未提供状态点(idle/未知)时不渲染。
    await w.setProps({ specReviewSessionStatusDot: null })
    expect(w.find('[data-testid="intent-detail-spec-review-session-status"]').exists()).toBe(false)
  })

  it('renders review/fix tabs without any status dot', async () => {
    const w = mountTabs()
    const reviewTab = w.find('.intent-detail-tab[data-tab="reviewSession"]')
    const fixTab = w.find('.intent-detail-tab[data-tab="fixSession"]')
    expect(reviewTab.exists()).toBe(true)
    expect(fixTab.exists()).toBe(true)
    expect(reviewTab.find('.session-status').exists()).toBe(false)
    expect(fixTab.find('.session-status').exists()).toBe(false)

    // 即便其他会话在跑,评审/修复 tab 也不渲染状态点(无对应 prop)。
    await w.setProps({ workSessionStatusDot: 'running', specReviewSessionStatusDot: 'running' })
    expect(reviewTab.find('.session-status').exists()).toBe(false)
    expect(fixTab.find('.session-status').exists()).toBe(false)
  })

  it('scopes the spec session dot to the specSession tab, active or not', async () => {
    // 未激活 specSession(停在 intent tab):状态点仍只挂在 specSession 标签内。
    const w = mountTabs({ specSessionStatusDot: 'running' })
    const dots = w.findAll('[data-testid="intent-detail-spec-session-status"]')
    expect(dots).toHaveLength(1)
    expect(
      w.find('.intent-detail-tab[data-tab="specSession"]').find('.session-status').exists(),
    ).toBe(true)
    expect(w.find('.intent-detail-tab[data-tab="intent"]').find('.session-status').exists()).toBe(
      false,
    )

    // 激活 specSession 后同样只有一个点,且不牵动另外两类会话点。
    await w.setProps({ activeTab: 'specSession' })
    expect(w.findAll('[data-testid="intent-detail-spec-session-status"]')).toHaveLength(1)
    expect(w.find('[data-testid="intent-detail-intent-session-status"]').exists()).toBe(false)
    expect(w.find('[data-testid="intent-detail-work-session-status"]').exists()).toBe(false)
  })
})
