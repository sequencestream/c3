import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NewSessionModal from './NewSessionModal.vue'
import { VENDOR_IDS } from '@ccc/shared/protocol'
import type { AgentConfig, VendorId, VendorRuntimeStatus } from '@ccc/shared/protocol'

/** A claude + a codex + a cursor agent, all enabled, for the picker roster. */
const AGENTS: AgentConfig[] = [
  {
    id: 'claude-a',
    vendor: 'claude',
    configMode: 'system',
    displayName: 'Claude A',
    enabled: true,
    config: { baseUrl: '', apiKey: '', model: '' },
  },
  {
    id: 'codex-a',
    vendor: 'codex',
    configMode: 'custom',
    displayName: 'Codex A',
    enabled: true,
    config: { baseUrl: '', apiKey: '', model: '', wireApi: 'chat' },
  },
  {
    id: 'cursor-a',
    vendor: 'cursor',
    configMode: 'system',
    displayName: 'Cursor A',
    enabled: true,
    config: { apiKey: '', model: '' },
  },
]

/** 全部 vendor 可用的中立可用性表;`unavailable` 里列出的 vendor 判为不可用。 */
function availability(unavailable: VendorId[] = []): Record<VendorId, VendorRuntimeStatus> {
  const out = {} as Record<VendorId, VendorRuntimeStatus>
  for (const vendor of VENDOR_IDS) {
    out[vendor] = unavailable.includes(vendor)
      ? { vendor, available: false, runtime: 'host-cli', reason: 'host-cli-missing' }
      : { vendor, available: true, runtime: 'host-cli' }
  }
  return out
}

function mountModal(props: Partial<Record<string, unknown>> = {}) {
  return mount(NewSessionModal, {
    props: {
      open: true,
      agents: AGENTS,
      defaultAgentId: 'claude-a',
      vendorAvailability: availability(),
      ...props,
    },
  })
}

function vendorOption(w: ReturnType<typeof mountModal>, vendor: VendorId) {
  return w
    .find('[data-testid="new-session-vendor"]')
    .findAll('option')
    .find((o) => o.element.value === vendor)
}

describe('NewSessionModal.vue — 新建会话 vendor/agent 选择', () => {
  it('默认 Auto:创建时 emit confirm(null)', async () => {
    const w = mountModal()
    await w.find('[data-testid="new-session-create"]').trigger('click')
    expect(w.emitted('confirm')).toEqual([[null]])
  })

  it('Auto 时显示「继承默认 agent」提示,不显示 agent 下拉', () => {
    const w = mountModal()
    expect(w.find('[data-testid="new-session-auto-hint"]').exists()).toBe(true)
    expect(w.find('[data-testid="new-session-agent"]').exists()).toBe(false)
  })

  it('选定 vendor 后默认选首个 agent,创建 emit confirm(agentId)', async () => {
    const w = mountModal()
    await w.find('[data-testid="new-session-vendor"]').setValue('codex')
    // agent 下拉出现并默认选中该 vendor 的首个 agent。
    expect(w.find('[data-testid="new-session-agent"]').exists()).toBe(true)
    await w.find('[data-testid="new-session-create"]').trigger('click')
    expect(w.emitted('confirm')).toEqual([['codex-a']])
  })

  it('cursor agent 可被选中并作为绑定 agent 建会话', async () => {
    const w = mountModal()
    await w.find('[data-testid="new-session-vendor"]').setValue('cursor')
    expect(w.find('[data-testid="new-session-agent"]').exists()).toBe(true)
    await w.find('[data-testid="new-session-create"]').trigger('click')
    expect(w.emitted('confirm')).toEqual([['cursor-a']])
  })

  it('运行时不可用的 vendor 在下拉里被禁用', () => {
    const w = mountModal({ vendorAvailability: availability(['codex']) })
    expect(vendorOption(w, 'codex')?.attributes('disabled')).toBeDefined()
    expect(vendorOption(w, 'claude')?.attributes('disabled')).toBeUndefined()
  })

  it('cursor SDK 不可解析时 cursor 选项禁用并标注原因', () => {
    const runtime = availability()
    runtime.cursor = {
      vendor: 'cursor',
      available: false,
      runtime: 'embedded-sdk',
      runtimeId: '@cursor/sdk',
      reason: 'sdk-unresolved',
    }
    const w = mountModal({ vendorAvailability: runtime })
    const option = vendorOption(w, 'cursor')
    expect(option?.attributes('disabled')).toBeDefined()
    // 原因就写在选项文本上,不需要用户去别处查。
    expect(option?.text()).toContain('—')
    expect(option?.text()).not.toBe('Cursor')
  })

  it('存在不可用 vendor 时给出「前往检测面板」入口 → emit goto-settings', async () => {
    const w = mountModal({ vendorAvailability: availability(['codex']) })
    const link = w.find('[data-testid="new-session-goto-settings"]')
    expect(link.exists()).toBe(true)
    await link.trigger('click')
    expect(w.emitted('goto-settings')).toBeTruthy()
  })

  it('全部 vendor 就绪时不显示缺失提示', () => {
    const w = mountModal()
    expect(w.find('[data-testid="new-session-missing"]').exists()).toBe(false)
  })
  it('默认 agent 是虚拟组时,Auto 提示显示组引用而不是「无默认」', () => {
    // 组引用不在 agents 里,按 id 查必然落空 —— 这里正是回归点。
    const grouped = AGENTS.map((a) =>
      a.vendor === 'codex' ? { ...a, group: 'fast' } : a,
    ) as AgentConfig[]
    const w = mountModal({ agents: grouped, defaultAgentId: '_c3_codex_fast' })
    const hint = w.find('[data-testid="new-session-auto-hint"]')
    expect(hint.text()).toContain('_c3_codex_fast')
    // 色点取组内首个 enabled 成员的 vendor(codex),而不是留空。
    expect(w.find('.vendor-dot').exists()).toBe(true)
  })

  it('组默认里没有可用成员时回到「无默认」文案', () => {
    const w = mountModal({ defaultAgentId: '_c3_codex_fast' })
    const hint = w.find('[data-testid="new-session-auto-hint"]')
    expect(hint.text()).not.toContain('_c3_codex_fast')
  })
})
