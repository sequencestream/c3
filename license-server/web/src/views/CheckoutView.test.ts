import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { License, Plan, PlanTier, TierCapability } from '../lib/api'
import { i18n, setLocale } from '../i18n'

// Tier labels and front-end cells are localized; pin the UI language to zh so the
// Chinese-text assertions below (and tierLabel via the shared i18n singleton) are
// deterministic regardless of the test environment's navigator.language.
beforeEach(() => {
  setLocale('zh')
})

// The view talks to the /v1 JSON API via lib/api; mock those helpers so each test
// drives the component purely from canned plans/licenses/tiers payloads.
const getJSON = vi.fn()
const postJSON = vi.fn()
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
  return { ...actual, getJSON: (...a: unknown[]) => getJSON(...a), postJSON: (...a: unknown[]) => postJSON(...a) }
})

import CheckoutView from './CheckoutView.vue'

const PAID_PLANS: Plan[] = [
  { planKey: '1m', name: '1 Month', durationMonths: 1, priceCents: 100, currency: 'CNY', tier: 'paid' },
  { planKey: '1y', name: '1 Year', durationMonths: 12, priceCents: 1090, currency: 'CNY', tier: 'paid' },
]
const ENTERPRISE_PLANS: Plan[] = [
  { planKey: 'enterprise-1y', name: 'Enterprise 1 Year', durationMonths: 12, priceCents: 10000, currency: 'CNY', tier: 'enterprise' },
]
const TIERS: PlanTier[] = [
  { tier: 'free', name: '免费版 / Free' },
  { tier: 'paid', name: '付费版 / Paid' },
  { tier: 'enterprise', name: '企业版 / Enterprise' },
]
const CAPABILITIES: TierCapability[] = [
  { label: '启用 sandbox / Sandbox', free: '不可 / No', paid: '可 / Yes', enterprise: '可 / Yes' },
  { label: '权限控制 / Permission controls', free: '基础', paid: '基础', enterprise: '高级' },
]

// Far-future / long-past Unix-seconds term ends, so active-enterprise detection
// (termEnd*1000 > Date.now()) is deterministic regardless of wall clock.
const FUTURE = Math.floor(Date.now() / 1000) + 365 * 24 * 3600
const PAST = Math.floor(Date.now() / 1000) - 24 * 3600

const PAID_LICENSE: License = { licenseId: 1, licenseKey: 'PAID-KEY', status: 'active', tier: 'paid', termEnd: FUTURE, aliveInstallId: null, aliveTime: null }
const ACTIVE_ENT_LICENSE: License = { licenseId: 2, licenseKey: 'ENT-KEY', status: 'active', tier: 'enterprise', termEnd: FUTURE, aliveInstallId: null, aliveTime: null }
const EXPIRED_ENT_LICENSE: License = { licenseId: 3, licenseKey: 'OLD-ENT', status: 'active', tier: 'enterprise', termEnd: PAST, aliveInstallId: null, aliveTime: null }

interface Fixture {
  plans?: Plan[]
  licenses?: License[]
  tiers?: PlanTier[]
  capabilities?: TierCapability[]
}

function ok<T>(data: T): { ok: true; status: 200; data: T; error: '' } {
  return { ok: true, status: 200, data, error: '' }
}

// mountView wires the getJSON mock to the canned fixture and mounts the view,
// returning once onMounted's fetches have flushed.
async function mountView(fx: Fixture = {}): Promise<VueWrapper> {
  const plans = fx.plans ?? [...PAID_PLANS, ...ENTERPRISE_PLANS]
  const licenses = fx.licenses ?? [PAID_LICENSE]
  const tiers = fx.tiers ?? TIERS
  const capabilities = fx.capabilities ?? CAPABILITIES
  getJSON.mockImplementation((url: string) => {
    if (url === '/v1/session') return Promise.resolve(ok({ signedIn: true }))
    if (url === '/v1/plans') return Promise.resolve(ok({ plans }))
    if (url === '/v1/licenses') return Promise.resolve(ok({ licenses }))
    if (url === '/v1/agreement') return Promise.resolve(ok({ title: '协议', version: '1', markdown: '' }))
    if (url === '/v1/plan-tiers') return Promise.resolve(ok({ tiers, capabilities }))
    return Promise.resolve(ok({}))
  })
  const wrapper = mount(CheckoutView, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  getJSON.mockReset()
  postJSON.mockReset()
})

describe('CheckoutView plan classification', () => {
  it('renders paid plans only in the paid column and enterprise plans only in the enterprise column', async () => {
    const wrapper = await mountView()
    const paidCol = wrapper.get('[data-testid="paid-col"]').text()
    const entCol = wrapper.get('[data-testid="enterprise-col"]').text()
    expect(paidCol).toContain('1 Month')
    expect(paidCol).toContain('1 Year')
    expect(paidCol).not.toContain('Enterprise 1 Year')
    expect(entCol).toContain('Enterprise 1 Year')
    expect(entCol).not.toContain('1 Month')
  })

  it('shows a placeholder, not an error, when a column has no plans', async () => {
    const wrapper = await mountView({ plans: [...ENTERPRISE_PLANS] })
    expect(wrapper.get('[data-testid="paid-col"]').text()).toContain('暂无付费套餐')
    expect(wrapper.find('.error').exists()).toBe(false)
  })
})

describe('CheckoutView capability comparison', () => {
  it('renders the free / paid / enterprise capability differences', async () => {
    const wrapper = await mountView()
    const table = wrapper.get('[data-testid="tier-compare"]')
    const text = table.text()
    expect(text).toContain('启用 sandbox / Sandbox')
    expect(text).toContain('不可 / No') // free cell
    expect(text).toContain('可 / Yes') // paid + enterprise cells
    expect(text).toContain('高级') // enterprise-only capability value
    // The first heading is the localized "capability" label (zh); the three tier
    // headings come from the server fixture's PlanTier.name and stay as-is.
    const heads = table.findAll('th').map((th) => th.text())
    expect(heads).toEqual(['权益', '免费版 / Free', '付费版 / Paid', '企业版 / Enterprise'])
  })

  it('shows a free column in the picker with no selectable plans', async () => {
    const wrapper = await mountView()
    const freeCol = wrapper.get('[data-testid="free-col"]')
    expect(freeCol.findAll('input[name="plan"]')).toHaveLength(0)
    expect(freeCol.text()).toContain('免费版无需购买')
  })

  it('labels each renewal-target license with its Chinese tier name', async () => {
    const wrapper = await mountView({ licenses: [PAID_LICENSE, ACTIVE_ENT_LICENSE] })
    const tags = wrapper.findAll('[data-testid="lic-tier"]').map((t) => t.text())
    expect(tags).toEqual(['付费版', '企业版'])
  })
})

describe('CheckoutView single-selection constraint', () => {
  it('keeps at most one plan selected across both columns', async () => {
    const wrapper = await mountView()
    const radios = wrapper.findAll('input[name="plan"]')
    await radios[0].setValue() // first paid plan
    await radios[2].setValue() // enterprise plan
    const checked = wrapper.findAll('input[name="plan"]').filter((r) => (r.element as HTMLInputElement).checked)
    expect(checked).toHaveLength(1)
    expect((checked[0].element as HTMLInputElement).value).toBe('enterprise-1y')
  })
})

describe('CheckoutView enterprise-target gate', () => {
  it('disables the paid column when the target license is an active enterprise license', async () => {
    const wrapper = await mountView({ licenses: [ACTIVE_ENT_LICENSE] })
    expect(wrapper.get('[data-testid="paid-col"]').classes()).toContain('is-disabled')
    expect(wrapper.find('[data-testid="paid-disabled-hint"]').exists()).toBe(true)
    const paidRadios = wrapper.get('[data-testid="paid-col"]').findAll('input[name="plan"]')
    expect(paidRadios.every((r) => (r.element as HTMLInputElement).disabled)).toBe(true)
    // Enterprise plans stay selectable.
    const entRadios = wrapper.get('[data-testid="enterprise-col"]').findAll('input[name="plan"]')
    expect(entRadios.every((r) => (r.element as HTMLInputElement).disabled)).toBe(false)
  })

  it('clears a previously selected paid plan and blocks submitting it when switching to an enterprise target', async () => {
    const wrapper = await mountView({ licenses: [PAID_LICENSE, ACTIVE_ENT_LICENSE] })
    // Start on the paid target, pick a paid plan.
    const paidRadio = wrapper.get('[data-testid="paid-col"]').findAll('input[name="plan"]')[0]
    await paidRadio.setValue()
    expect((paidRadio.element as HTMLInputElement).checked).toBe(true)
    // Switch the renewal target to the active enterprise license.
    const licRadios = wrapper.findAll('input[name="lic"]')
    await licRadios[1].setValue()
    await flushPromises()
    // The paid selection is cleared and the order button is disabled (no plan).
    const noneChecked = wrapper.findAll('input[name="plan"]').every((r) => !(r.element as HTMLInputElement).checked)
    expect(noneChecked).toBe(true)
    expect(wrapper.get('button').attributes('disabled')).toBeDefined()
  })

  it('treats an expired enterprise license as non-blocking (paid column stays selectable)', async () => {
    const wrapper = await mountView({ licenses: [EXPIRED_ENT_LICENSE] })
    expect(wrapper.get('[data-testid="paid-col"]').classes()).not.toContain('is-disabled')
    const paidRadios = wrapper.get('[data-testid="paid-col"]').findAll('input[name="plan"]')
    expect(paidRadios.every((r) => (r.element as HTMLInputElement).disabled)).toBe(false)
  })
})

describe('CheckoutView non-enterprise target flow', () => {
  it('lets a paid-target user pick a paid plan and submits the unchanged payload', async () => {
    postJSON.mockResolvedValue(ok({ orderNo: 'NO-1', qrDataUri: '' }))
    const wrapper = await mountView({ licenses: [PAID_LICENSE] })
    await wrapper.get('[data-testid="paid-col"]').findAll('input[name="plan"]')[1].setValue() // pick 1y
    await wrapper.get('input[type="checkbox"]').setValue(true) // accept agreement
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(postJSON).toHaveBeenCalledWith('/v1/checkout', { planKey: '1y', licenseId: 1, accept: true })
  })

  it('re-enables the paid column when switching from an enterprise target back to a paid target', async () => {
    const wrapper = await mountView({ licenses: [ACTIVE_ENT_LICENSE, PAID_LICENSE] })
    expect(wrapper.get('[data-testid="paid-col"]').classes()).toContain('is-disabled')
    await wrapper.findAll('input[name="lic"]')[1].setValue() // switch to paid target
    await flushPromises()
    expect(wrapper.get('[data-testid="paid-col"]').classes()).not.toContain('is-disabled')
    const paidRadios = wrapper.get('[data-testid="paid-col"]').findAll('input[name="plan"]')
    expect(paidRadios.every((r) => (r.element as HTMLInputElement).disabled)).toBe(false)
  })
})
