import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Plan, PlanTier, TierCapability } from '../lib/api'
import { i18n, setLocale } from '../i18n'

beforeEach(() => {
  setLocale('zh')
})

const getJSON = vi.fn()
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, getJSON: (...a: unknown[]) => getJSON(...a) }
})

import PlansView from './PlansView.vue'

const PLANS: Plan[] = [
  { planKey: '1m', name: '1 Month', durationMonths: 1, priceCents: 100, currency: 'CNY', tier: 'paid' },
  { planKey: '6m', name: '6 Months', durationMonths: 6, priceCents: 590, currency: 'CNY', tier: 'paid' },
  { planKey: '1y', name: '1 Year', durationMonths: 12, priceCents: 1090, currency: 'CNY', tier: 'paid' },
  { planKey: 'enterprise-1y', name: 'Enterprise 1 Year', durationMonths: 12, priceCents: 10000, currency: 'CNY', tier: 'enterprise' },
]

const TIERS: PlanTier[] = [
  { tier: 'free', name: '免费版 / Free' },
  { tier: 'paid', name: '付费版 / Paid' },
  { tier: 'enterprise', name: '企业版 / Enterprise' },
]

const CAPABILITIES: TierCapability[] = [
  { label: '注册 workspace 数 / Workspaces', free: '5', paid: '不限 / Unlimited', enterprise: '不限 / Unlimited' },
  { label: '并发活跃 worktree / Active worktrees', free: '1', paid: '不限 / Unlimited', enterprise: '不限 / Unlimited' },
  { label: '单次讨论参与者(不含主持人) / Discussion participants', free: '2', paid: '不限 / Unlimited', enterprise: '不限 / Unlimited' },
  { label: '启用中的 schedule / Enabled schedules', free: '2', paid: '不限 / Unlimited', enterprise: '不限 / Unlimited' },
  { label: '启用 sandbox / Sandbox', free: '不可 / No', paid: '可 / Yes', enterprise: '可 / Yes' },
  { label: '权限控制 / Permission controls', free: '基础 / Basic', paid: '基础 / Basic', enterprise: '更高级的权限控制(预告) / Advanced controls (preview)' },
  { label: '价格 / 期限 / Price / Term', free: '免费、长期 / Free, long-lived', paid: '见购买页 / See checkout', enterprise: '见购买页 / See checkout' },
]

function ok<T>(data: T): { ok: true; status: 200; data: T; error: '' } {
  return { ok: true, status: 200, data, error: '' }
}

async function mountView() {
  getJSON.mockImplementation((url: string) => {
    if (url === '/v1/plan-tiers') return Promise.resolve(ok({ tiers: TIERS, capabilities: CAPABILITIES }))
    if (url === '/v1/plans') return Promise.resolve(ok({ plans: PLANS }))
    return Promise.resolve(ok({}))
  })
  const wrapper = mount(PlansView, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  getJSON.mockReset()
})

describe('PlansView localization', () => {
  it('renders compare plans copy in Chinese without mixed English data strings', async () => {
    const wrapper = await mountView()
    const text = wrapper.text()
    expect(text).toContain('注册 workspace 数')
    expect(text).toContain('不限')
    expect(text).toContain('企业版 1 年')
    expect(text).toContain('付费版')
    expect(text).toContain('¥1.00')
    expect(text).not.toContain('Unlimited')
    expect(text).not.toContain('Enterprise 1 Year')
  })

  it('refreshes compare plans copy to English when the locale changes', async () => {
    const wrapper = await mountView()
    setLocale('en')
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('Registered workspaces')
    expect(text).toContain('Unlimited')
    expect(text).toContain('Enterprise 1 Year')
    expect(text).toContain('Paid')
    expect(text).toContain('¥1.00')
    expect(text).not.toContain('注册')
    expect(text).not.toContain('企业版 1 年')
  })
})
