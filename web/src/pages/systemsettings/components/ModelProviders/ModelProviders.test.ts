/**
 * 「模型提供方」页签。
 *
 * 这里守的是几条不该被顺手破坏的性质:删除一个仍被引用的 provider 必须先说清后果,
 * 探测这个动作永远走 emit 而不是混进草稿的字段编辑里,以及改 Provider Vendor 只换内置模型建议,
 * 连接字段与用户自己的模型条目一概不动。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { AgentConfig, ModelProvider } from '@ccc/shared/protocol'
import { providerVendorModels } from '@ccc/shared'
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
      vendor: 'deepseek',
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
    expect(list[0].vendor).toBe('custom')
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

describe('编辑一条 provider', () => {
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

describe('模型目录', () => {
  it('每条只展示名称与删除,且在同一行容器里', async () => {
    const w = render({
      providers: [provider({ models: [{ id: 'gpt-4o', contextWindow: 128000 }] })],
    })
    await w.find('[data-testid="provider-row"] .icon-btn').trigger('click')
    const row = w.find('[data-testid="provider-model-row"]')
    expect(row.find('[data-testid="provider-model-name"]').exists()).toBe(true)
    expect(row.find('[data-testid="provider-model-remove"]').exists()).toBe(true)
    expect(row.findAll('input')).toHaveLength(1)
    expect((row.element as HTMLElement).classList.contains('provider-model')).toBe(true)
  })

  it('删除一条模型只改草稿,不发 change', async () => {
    const providers = [provider({ models: [{ id: 'a' }, { id: 'b' }] })]
    const w = render({ providers })
    await w.find('[data-testid="provider-row"] .icon-btn').trigger('click')
    await w.findAll('[data-testid="provider-model-remove"]')[0]!.trigger('click')
    expect(providers[0].models).toEqual([{ id: 'b' }])
    expect(w.emitted('change')).toBeUndefined()
  })
})

describe('Provider Vendor', () => {
  /** 展开第一条 provider —— 编辑面板里的字段都在展开后才渲染。 */
  async function expand(w: ReturnType<typeof render>) {
    await w.find('[data-testid="provider-row"] .icon-btn').trigger('click')
    return w
  }

  it('收缩时标题行就标出身份;缺失的 vendor 读成 Custom', () => {
    const w = render({ providers: [provider()] })
    expect(w.find('[data-testid="provider-vendor-badge"]').text()).toBe('Custom')
  })

  it('未知 vendor(更新版 c3 写下的)退化为 Custom,而不是空白', () => {
    // 只有手改配置或更新版 c3 写得出这个值,类型上不存在 —— 断言的正是它不该炸。
    const w = render({ providers: [provider({ vendor: 'from-the-future' as never })] })
    expect(w.find('[data-testid="provider-vendor-badge"]').text()).toBe('Custom')
  })

  it('选中的 vendor 决定内置模型清单,并与自定义条目分开展示', async () => {
    const w = await expand(
      render({ providers: [provider({ vendor: 'moonshot', models: [{ id: 'house-model' }] })] }),
    )
    const shipped = w.findAll('[data-testid="provider-shipped-model"]').map((n) => n.text())
    expect(shipped).toEqual(providerVendorModels('moonshot').map((m) => m.id))
    expect(shipped).not.toContain('house-model')
    const custom = w
      .findAll('[data-testid="provider-model-name"]')
      .map((n) => (n.element as HTMLInputElement).value)
    expect(custom).toEqual(['house-model'])
  })

  it('没有内置模型的 vendor 说明情况,而不是留一片空白', async () => {
    const w = await expand(render({ providers: [provider({ vendor: 'custom' })] }))
    expect(w.find('[data-testid="provider-shipped-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="provider-shipped-model"]').exists()).toBe(false)
  })

  it('改 vendor 只换内置那一半:连接字段、账户 key、暂停位、自定义条目都不动', async () => {
    const providers = [
      provider({
        displayName: 'House gateway',
        vendor: 'anthropic',
        apiKey: 'sk-secret',
        models: [{ id: 'house-model' }],
        paused: true,
      }),
    ]
    const w = await expand(render({ providers }))
    await w.find('[data-testid="provider-vendor"]').setValue('doubao')
    expect(providers[0]).toMatchObject({
      vendor: 'doubao',
      displayName: 'House gateway',
      apiKey: 'sk-secret',
      urls: { anthropic: 'https://api.deepseek.com/anthropic' },
      models: [{ id: 'house-model' }],
      paused: true,
    })
    const shipped = w.findAll('[data-testid="provider-shipped-model"]').map((n) => n.text())
    expect(shipped).toEqual(providerVendorModels('doubao').map((m) => m.id))
  })

  it('非管理员看得到身份与两份清单,但一个都改不了', async () => {
    const w = await expand(
      render({
        providers: [provider({ vendor: 'deepseek', models: [{ id: 'house-model' }] })],
        isAdmin: false,
      }),
    )
    expect(w.find('[data-testid="provider-vendor"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="provider-vendor-badge"]').text()).toBe('DeepSeek')
    expect(w.find('[data-testid="provider-shipped-model"]').exists()).toBe(true)
    expect(w.find('[data-testid="provider-model-name"]').attributes('disabled')).toBeDefined()
  })
})
