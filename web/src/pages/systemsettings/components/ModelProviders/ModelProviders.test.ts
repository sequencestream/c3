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
    urls: { anthropic: 'https://api.deepseek.com/anthropic' },
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
      urls: {
        openai: 'https://api.deepseek.com',
        anthropic: 'https://api.deepseek.com/anthropic',
      },
      wireApi: 'chat',
    })
  })

  it('空白新建不带 template 字段', async () => {
    const w = render()
    await w.find('[data-testid="provider-add"]').trigger('click')
    const [list] = w.emitted('change')![0] as [ModelProvider[]]
    expect(list[0].template).toBeUndefined()
    expect(list[0].urls).toEqual({})
  })

  it('显示有多少 agent 在用它', () => {
    const w = render({ providers: [provider()], agents: [agent({ providerId: 'p1' })] })
    expect(w.find('[data-testid="provider-row"]').text()).toContain('1 agents')
  })

  it('收缩时标题行标出已启用的协议', () => {
    const w = render({
      providers: [
        provider({
          urls: {
            openai: 'https://api.example.com',
            anthropic: 'https://api.example.com/anthropic',
          },
        }),
      ],
    })
    const chips = w.find('[data-testid="provider-protocols"]')
    expect(chips.find('[data-testid="provider-protocol-openai"]').text()).toBe('OpenAI')
    expect(chips.find('[data-testid="provider-protocol-anthropic"]').text()).toBe('Anthropic')
  })

  it('收缩时不标未勾选的协议;展开后标题行不再重复', async () => {
    const w = render({ providers: [provider()] })
    expect(w.find('[data-testid="provider-protocol-anthropic"]').exists()).toBe(true)
    expect(w.find('[data-testid="provider-protocol-openai"]').exists()).toBe(false)
    await w.find('[data-testid="provider-row"] .icon-btn').trigger('click')
    expect(w.find('[data-testid="provider-protocols"]').exists()).toBe(false)
  })
})

describe('删除', () => {
  it('被引用时先说明后果,确认后只删 provider', async () => {
    const w = render({ providers: [provider()], agents: [agent({ providerId: 'p1' })] })
    await w.find('[data-testid="provider-remove"]').trigger('click')
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

  it('勾选/取消一个协议槽即建立/删除那条 URL', async () => {
    const providers = [provider()]
    const w = render({ providers })
    await w.find('[data-testid="provider-row"] .icon-btn').trigger('click')
    await w.find('[data-testid="provider-conn-openai"]').setValue(true)
    expect(providers[0].urls.openai).toBe('')
    expect(providers[0].wireApi).toBe('chat')
    await w.find('[data-testid="provider-conn-anthropic"]').setValue(false)
    expect(providers[0].urls.anthropic).toBeUndefined()
  })

  it('协议槽把 type、url、wireApi、测试按钮放在同一行容器里', async () => {
    const w = render({
      providers: [
        provider({
          urls: {
            openai: 'https://api.example.com',
            anthropic: 'https://api.example.com/anthropic',
          },
          wireApi: 'chat',
        }),
      ],
    })
    await w.find('[data-testid="provider-row"] .icon-btn').trigger('click')
    const openai = w.find('[data-testid="provider-conn-row-openai"]')
    expect(openai.find('[data-testid="provider-conn-openai"]').exists()).toBe(true)
    expect(openai.find('[data-testid="provider-baseurl-openai"]').exists()).toBe(true)
    expect(openai.find('[data-testid="provider-wireapi"]').exists()).toBe(true)
    expect(openai.find('[data-testid="provider-probe-openai"]').exists()).toBe(true)
    const anthropic = w.find('[data-testid="provider-conn-row-anthropic"]')
    expect(anthropic.find('[data-testid="provider-baseurl-anthropic"]').exists()).toBe(true)
    expect(anthropic.find('[data-testid="provider-wireapi"]').exists()).toBe(false)
    expect(anthropic.find('[data-testid="provider-probe-anthropic"]').exists()).toBe(true)
  })

  it('就地标注 base URL 的结构性问题', async () => {
    const providers = [provider({ urls: { anthropic: 'http://gw.example' } })]
    const w = render({ providers })
    await w.find('[data-testid="provider-row"] .icon-btn').trigger('click')
    expect(w.find('.provider-issue').text()).toContain('Plain http')
  })

  it('探测按协议槽上抛草稿 URL/key,不改任何配置', async () => {
    const w = render({
      providers: [
        provider({
          apiKey: 'account-key',
          urls: { anthropic: 'https://draft.example/anthropic' },
        }),
      ],
    })
    await w.find('[data-testid="provider-row"] .icon-btn').trigger('click')
    await w.find('[data-testid="provider-probe-anthropic"]').trigger('click')
    expect(w.emitted('probe')![0]).toEqual([
      {
        providerId: 'p1',
        protocolType: 'anthropic',
        baseUrl: 'https://draft.example/anthropic',
        apiKey: 'account-key',
      },
    ])
    expect(w.emitted('change')).toBeUndefined()
  })

  it('把探测结论渲染成一句话,401 记作「可达但 key 被拒」', async () => {
    const w = render({
      providers: [provider()],
      probes: { 'p1:anthropic': { reachable: true, status: 401 } },
    })
    await w.find('[data-testid="provider-row"] .icon-btn').trigger('click')
    expect(w.find('.provider-probe-result').text()).toContain('key rejected')
  })
})

describe('启用滑动开关', () => {
  it('开着=未暂停,关上写入 paused 并改标签', async () => {
    const providers = [provider()]
    const w = render({ providers })
    const sw = w.find('[data-testid="provider-enabled-switch"]')
    expect(sw.attributes('role')).toBe('switch')
    expect((sw.element as HTMLInputElement).checked).toBe(true)
    expect(sw.attributes('aria-checked')).toBe('true')
    expect(w.find('.provider-pause').text()).toContain('Enabled')
    await sw.setValue(false)
    expect(providers[0].paused).toBe(true)
    expect(sw.attributes('aria-checked')).toBe('false')
    expect(w.find('.provider-pause').text()).toContain('Paused')
    await sw.setValue(true)
    expect(providers[0].paused).toBeUndefined()
    expect(w.find('.provider-pause').text()).toContain('Enabled')
  })

  it('已暂停的 provider 开关默认关上', () => {
    const w = render({ providers: [provider({ paused: true })] })
    const sw = w.find<HTMLInputElement>('[data-testid="provider-enabled-switch"]')
    expect(sw.element.checked).toBe(false)
    expect(w.find('.provider-pause').text()).toContain('Paused')
  })
})

describe('非管理员', () => {
  it('每个写入控件都禁用', async () => {
    const w = render({ providers: [provider()], isAdmin: false })
    expect(w.find<HTMLInputElement>('[data-testid="provider-name"]').element.disabled).toBe(true)
    expect(w.find<HTMLButtonElement>('[data-testid="provider-add"]').element.disabled).toBe(true)
    expect(w.find<HTMLButtonElement>('[data-testid="provider-remove"]').element.disabled).toBe(true)
    expect(
      w.find<HTMLInputElement>('[data-testid="provider-enabled-switch"]').element.disabled,
    ).toBe(true)
  })
})
