import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import NewSessionModal from './NewSessionModal.vue'
import type { AgentConfig, VendorHostStatus } from '@ccc/shared/protocol'

/** A claude + a codex agent, both enabled, for the picker roster. */
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
    config: { baseUrl: '', apiKey: '', model: '' },
  },
]

function mountModal(props: Partial<Record<string, unknown>> = {}) {
  return mount(NewSessionModal, {
    props: {
      open: true,
      agents: AGENTS,
      defaultAgentId: 'claude-a',
      hostStatus: [] as VendorHostStatus[],
      ...props,
    },
  })
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

  it('host-binary 缺失的 vendor 在下拉里被禁用', () => {
    const w = mountModal({
      hostStatus: [
        { vendor: 'codex', present: false, binary: 'codex', installHint: 'install codex' },
      ] as VendorHostStatus[],
    })
    const codexOption = w
      .find('[data-testid="new-session-vendor"]')
      .findAll('option')
      .find((o) => o.element.value === 'codex')
    expect(codexOption?.attributes('disabled')).toBeDefined()
  })

  it('存在缺失 binary 时给出「前往检测面板」入口 → emit goto-settings', async () => {
    const w = mountModal({
      hostStatus: [
        { vendor: 'codex', present: false, binary: 'codex', installHint: 'install codex' },
      ] as VendorHostStatus[],
    })
    const link = w.find('[data-testid="new-session-goto-settings"]')
    expect(link.exists()).toBe(true)
    await link.trigger('click')
    expect(w.emitted('goto-settings')).toBeTruthy()
  })

  it('host 全部就绪时不显示缺失提示', () => {
    const w = mountModal({
      hostStatus: [
        { vendor: 'claude', present: true, binary: 'claude', installHint: '' },
        { vendor: 'codex', present: true, binary: 'codex', installHint: '' },
      ] as VendorHostStatus[],
    })
    expect(w.find('[data-testid="new-session-missing"]').exists()).toBe(false)
  })
})
