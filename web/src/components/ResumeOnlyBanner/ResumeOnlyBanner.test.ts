import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ResumeOnlyBanner from './ResumeOnlyBanner.vue'
import type { CapabilityState, VendorId } from '@ccc/shared/protocol'

function mountBanner(props: { vendor?: VendorId | null; read?: CapabilityState } = {}) {
  return mount(ResumeOnlyBanner, { props })
}

describe('ResumeOnlyBanner.vue — read=none 详情横幅', () => {
  it("read='none' 且有 vendor 时渲染横幅,含品牌名", () => {
    const w = mountBanner({ vendor: 'codex', read: 'none' })
    const banner = w.find('[data-testid="resume-only-banner"]')
    expect(banner.exists()).toBe(true)
    // 品牌名 do-not-translate,经 VENDOR_LABEL 注入文案。
    expect(banner.text()).toContain('Codex')
  })

  it("read='full' 时不渲染(可回读 vendor 无横幅)", () => {
    const w = mountBanner({ vendor: 'claude', read: 'full' })
    expect(w.find('[data-testid="resume-only-banner"]').exists()).toBe(false)
  })

  it('read 未知(能力态未到)时不渲染', () => {
    const w = mountBanner({ vendor: 'codex' })
    expect(w.find('[data-testid="resume-only-banner"]').exists()).toBe(false)
  })

  it("vendor 缺失时即便 read='none' 也不渲染(无品牌名不显)", () => {
    const w = mountBanner({ vendor: null, read: 'none' })
    expect(w.find('[data-testid="resume-only-banner"]').exists()).toBe(false)
  })

  it("partial / temporarily-unavailable 不命中(仅 'none' 触发)", () => {
    expect(
      mountBanner({ vendor: 'codex', read: 'partial' })
        .find('[data-testid="resume-only-banner"]')
        .exists(),
    ).toBe(false)
    expect(
      mountBanner({ vendor: 'opencode', read: 'temporarily-unavailable' })
        .find('[data-testid="resume-only-banner"]')
        .exists(),
    ).toBe(false)
  })
})
