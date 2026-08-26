/**
 * 「模型提供方」页签。
 *
 * 这里守的是三条不该被顺手破坏的性质:删除一个仍被引用的 provider 必须先说清后果、
 * 手改迁移生成的记录会让它不再可一键撤销、以及迁移与探测这两个动作永远走 emit 而不是
 * 混进草稿的字段编辑里。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { AgentConfig, ModelProvider, ProviderMigrationPlan } from '@ccc/shared/protocol'
import ModelProviders from './ModelProviders.vue'

function provider(over: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: 'p1',
    displayName: 'DeepSeek',
    apiKey: 'sk-1',
    connections: { claude: { baseUrl: 'https://api.deepseek.com/anthropic' } },
    ...over,
  }
}

function agent(over: Record<string, unknown> = {}): AgentConfig {
  return {
    id: 'a1',
    vendor: 'claude',
    configMode: 'custom',
    displayName: 'A1',
    config: { baseUrl: '', apiKey: '', model: '' },
    enabled: true,
    ...over,
  } as AgentConfig
}

function render(props: Record<string, unknown> = {}) {
  return mount(ModelProviders, { props: { providers: [], agents: [], ...props } })
}

describe('provider 列表', () => {
  it('空注册表给出引导而不是一张空表', () => {
    expect(render().find('[data-testid="provider-empty"]').exists()).toBe(true)
  })

  it('从模板新建时带上该模板的端点,并整体替换列表', async () => {
    const w = render()
    await w.find('[data-testid="provider-template"]').setValue('deepseek')
    await w.find('[data-testid="provider-add"]').trigger('click')
    const [list] = w.emitted('change')![0] as [ModelProvider[]]
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      template: 'deepseek',
      connections: { claude: { baseUrl: 'https://api.deepseek.com/anthropic' } },
    })
  })

  it('空白新建不带 template 字段', async () => {
    const w = render()
    await w.find('[data-testid="provider-add"]').trigger('click')
    const [list] = w.emitted('change')![0] as [ModelProvider[]]
    expect(list[0].template).toBeUndefined()
    expect(list[0].connections).toEqual({})
  })

  it('显示有多少 agent 在用它', () => {
    const w = render({ providers: [provider()], agents: [agent({ providerId: 'p1' })] })
    expect(w.find('[data-testid="provider-row"]').text()).toContain('1 agents')
  })
})

describe('删除', () => {
  it('被引用时先说明后果,确认后只删 provider', async () => {
    const w = render({ providers: [provider()], agents: [agent({ providerId: 'p1' })] })
    await w.find('[data-testid="provider-remove"]').trigger('click')
    // 确认框点名受影响的 agent 数,并把主按钮降级为「仍然删除」。
    expect(w.text()).toContain('1 agents still reference it')
    expect(w.text()).toContain('Remove anyway')
    await w.findComponent({ name: 'ConfirmDialog' }).vm.$emit('confirm')
    const [list] = w.emitted('change')![0] as [ModelProvider[]]
    expect(list).toEqual([])
  })

  it('没有引用时不出现「仍然删除」的措辞', async () => {
    const w = render({ providers: [provider()], agents: [] })
    await w.find('[data-testid="provider-remove"]').trigger('click')
    expect(w.text()).not.toContain('Remove anyway')
  })
})

describe('迁移横幅', () => {
  const plan: ProviderMigrationPlan = {
    groups: [
      {
        providerId: 'mp-syn-1',
        reusesExisting: false,
        displayName: 'Deepseek',
        vendor: 'claude',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-1',
        agentIds: ['a1', 'a2'],
      },
    ],
    clearableAgentIds: [],
  }

  it('没有待迁移也没有残留时不出现', () => {
    const w = render({ plan: { groups: [], clearableAgentIds: [] } })
    expect(w.find('[data-testid="provider-migration"]').exists()).toBe(false)
  })

  it('按报告说明规模并上抛 apply', async () => {
    const w = render({ plan })
    expect(w.find('[data-testid="provider-migration"]').text()).toContain('2 agents')
    await w.find('[data-testid="provider-migration-apply"]').trigger('click')
    expect(w.emitted('migrate')![0]).toEqual([{ action: 'apply' }])
  })

  it('清理是二次确认之后才上抛的单向动作', async () => {
    const w = render({
      providers: [provider({ synthesized: true })],
      plan: { groups: [], clearableAgentIds: ['a1'] },
    })
    await w.find('[data-testid="provider-migration-clear"]').trigger('click')
    expect(w.emitted('migrate')).toBeUndefined()
    // 两个确认框:第一个是删除,第二个才是清理。
    await w.findAllComponents({ name: 'ConfirmDialog' })[1].vm.$emit('confirm')
    expect(w.emitted('migrate')![0]).toEqual([{ action: 'clear' }])
  })

  it('只有存在迁移生成的记录时才给「撤销迁移」', () => {
    const withSynth = render({ providers: [provider({ synthesized: true })], plan })
    expect(withSynth.find('[data-testid="provider-migration-revert"]').exists()).toBe(true)
    const handMade = render({ providers: [provider()], plan })
    expect(handMade.find('[data-testid="provider-migration-revert"]').exists()).toBe(false)
  })
})

describe('编辑一条 provider', () => {
  it('改名会清掉 synthesized 标记 —— 它不再是可一键撤销的中间产物', async () => {
    const providers = [provider({ synthesized: true })]
    const w = render({ providers })
    await w.find('[data-testid="provider-name"]').setValue('My gateway')
    expect(providers[0].synthesized).toBeUndefined()
  })

  it('勾选/取消一个 vendor 连接即建立/删除那条连接', async () => {
    const providers = [provider()]
    const w = render({ providers })
    await w.find('[data-testid="provider-row"] .icon-btn').trigger('click')
    await w.find('[data-testid="provider-conn-codex"]').setValue(true)
    expect(providers[0].connections.codex).toEqual({ baseUrl: '', wireApi: 'chat' })
    await w.find('[data-testid="provider-conn-claude"]').setValue(false)
    expect(providers[0].connections.claude).toBeUndefined()
  })

  it('就地标注 base URL 的结构性问题', async () => {
    const providers = [provider({ connections: { claude: { baseUrl: 'http://gw.example' } } })]
    const w = render({ providers })
    await w.find('[data-testid="provider-row"] .icon-btn').trigger('click')
    expect(w.find('.provider-issue').text()).toContain('Plain http')
  })

  it('探测按连接上抛草稿 URL/key,不改任何配置', async () => {
    const w = render({
      providers: [
        provider({
          apiKey: 'account-key',
          connections: { claude: { baseUrl: 'https://draft.example/anthropic', apiKey: '' } },
        }),
      ],
    })
    await w.find('[data-testid="provider-row"] .icon-btn').trigger('click')
    await w.find('[data-testid="provider-probe-claude"]').trigger('click')
    expect(w.emitted('probe')![0]).toEqual([
      {
        providerId: 'p1',
        vendor: 'claude',
        baseUrl: 'https://draft.example/anthropic',
        // 空的 per-vendor 覆盖回落到账户 key —— 与运行时 effectiveApiKey 同规则。
        apiKey: 'account-key',
      },
    ])
    expect(w.emitted('change')).toBeUndefined()
  })

  it('把探测结论渲染成一句话,401 记作「可达但 key 被拒」', async () => {
    const w = render({
      providers: [provider()],
      probes: { 'p1:claude': { reachable: true, status: 401 } },
    })
    await w.find('[data-testid="provider-row"] .icon-btn').trigger('click')
    expect(w.find('.provider-probe-result').text()).toContain('key rejected')
  })
})

describe('非管理员', () => {
  it('每个写入控件都禁用', async () => {
    const w = render({ providers: [provider()], isAdmin: false })
    expect(w.find<HTMLInputElement>('[data-testid="provider-name"]').element.disabled).toBe(true)
    expect(w.find<HTMLButtonElement>('[data-testid="provider-add"]').element.disabled).toBe(true)
    expect(w.find<HTMLButtonElement>('[data-testid="provider-remove"]').element.disabled).toBe(true)
  })
})
