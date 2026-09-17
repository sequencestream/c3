/**
 * 「模型提供方」页签。
 *
 * 这里守的是几条不该被顺手破坏的性质:删除一个仍被引用的 provider 必须先说清后果,
 * 探测这个动作永远走 emit 而不是混进草稿的字段编辑里,以及改 Model Vendor 只换内置模型建议,
 * 连接字段与用户自己的模型条目一概不动;
 * 以及按厂商补默认端点只补空槽,任何已填的 URL 都不被它改写。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { AgentConfig, ModelProvider, SpeedTestActiveRun } from '@ccc/shared/protocol'
import { modelVendorDefaultUrls, modelVendorModels } from '@ccc/shared'
import ModelProviders from './ModelProviders.vue'
import { emptySpeedTestState } from '@/lib/model-provider-speed-test'

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

/** 服务端此刻持有的那一轮;state 决定它是「在跑」还是「已收束但没提交」。 */
function activeRun(over: Partial<SpeedTestActiveRun> = {}): SpeedTestActiveRun {
  return {
    runId: 'r1',
    providerId: 'p1',
    providerDisplayName: 'DeepSeek',
    protocolType: 'openai',
    apiDialect: 'chat',
    model: 'm1',
    plannedCount: 10,
    completedCount: 10,
    successCount: 10,
    failureCount: 0,
    startedAt: 1,
    state: 'running',
    ...over,
  }
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

describe('按厂商与协议补默认端点', () => {
  /** 展开第一条 provider —— 协议槽与 vendor 下拉都在展开后才渲染。 */
  async function expand(w: ReturnType<typeof render>) {
    await w.find('[data-testid="provider-row"] .icon-btn').trigger('click')
    return w
  }

  it('先选厂商再勾协议:两种协议都填入该厂商的默认端点', async () => {
    const providers = [provider({ vendor: 'custom', urls: {} })]
    const w = await expand(render({ providers }))
    await w.find('[data-testid="provider-vendor"]').setValue('deepseek')
    await w.find('[data-testid="provider-conn-openai"]').setValue(true)
    await w.find('[data-testid="provider-conn-anthropic"]').setValue(true)
    expect(providers[0].urls).toEqual(modelVendorDefaultUrls('deepseek'))
    // 只带 URL,不顺手套用模板的 wireApi:勾选 openai 仍是既有缺省。
    expect(providers[0].wireApi).toBe('chat')
  })

  it('先勾协议再换厂商:空槽被新厂商的默认端点补上', async () => {
    const providers = [provider({ vendor: 'custom', urls: {} })]
    const w = await expand(render({ providers }))
    await w.find('[data-testid="provider-conn-anthropic"]').setValue(true)
    expect(providers[0].urls.anthropic).toBe('')
    await w.find('[data-testid="provider-vendor"]').setValue('moonshot')
    expect(providers[0].urls.anthropic).toBe('https://api.moonshot.cn/anthropic')
  })

  it('换厂商只补已勾选的空槽:未勾选的协议不会凭空多出一条 URL', async () => {
    const providers = [provider({ vendor: 'custom', urls: { openai: '' } })]
    const w = await expand(render({ providers }))
    await w.find('[data-testid="provider-vendor"]').setValue('deepseek')
    expect(providers[0].urls).toEqual({ openai: 'https://api.deepseek.com' })
  })

  it('一槽已填、一槽为空时只补空的那个', async () => {
    const providers = [
      provider({ vendor: 'custom', urls: { openai: 'https://house.example/v1', anthropic: '' } }),
    ]
    const w = await expand(render({ providers }))
    await w.find('[data-testid="provider-vendor"]').setValue('zhipu')
    expect(providers[0].urls).toEqual({
      openai: 'https://house.example/v1',
      anthropic: 'https://open.bigmodel.cn/api/anthropic',
    })
  })

  it('勾选一个协议只动那一个槽,另一槽已填的 URL 原样留下', async () => {
    const providers = [
      provider({ vendor: 'deepseek', urls: { anthropic: 'https://house.example' } }),
    ]
    const w = await expand(render({ providers }))
    await w.find('[data-testid="provider-conn-openai"]').setValue(true)
    expect(providers[0].urls).toEqual({
      anthropic: 'https://house.example',
      openai: 'https://api.deepseek.com',
    })
  })

  it('厂商没有该协议的预设时保持空槽,而不是塞一个猜出来的端点', async () => {
    const providers = [provider({ vendor: 'custom', urls: {} })]
    const w = await expand(render({ providers }))
    await w.find('[data-testid="provider-vendor"]').setValue('google')
    await w.find('[data-testid="provider-conn-openai"]').setValue(true)
    expect(providers[0].urls.openai).toBe('')
    // doubao 只有 openai 预设,anthropic 槽仍留空。
    await w.find('[data-testid="provider-conn-anthropic"]').setValue(true)
    await w.find('[data-testid="provider-vendor"]').setValue('doubao')
    expect(providers[0].urls).toEqual({
      openai: 'https://ark.cn-beijing.volces.com/api/v3',
      anthropic: '',
    })
  })

  it('自动填入之后仍是普通字段:手改能生效,且不会被回填', async () => {
    const providers = [provider({ vendor: 'qwen', urls: {} })]
    const w = await expand(render({ providers }))
    await w.find('[data-testid="provider-conn-openai"]').setValue(true)
    await w.find('[data-testid="provider-baseurl-openai"]').setValue('https://proxy.example/v1')
    expect(providers[0].urls.openai).toBe('https://proxy.example/v1')
    await w.find('[data-testid="provider-vendor"]').setValue('qwen')
    expect(providers[0].urls.openai).toBe('https://proxy.example/v1')
  })

  it('换厂商不改写已有的 wireApi', async () => {
    const providers = [provider({ vendor: 'custom', urls: { openai: '' }, wireApi: 'responses' })]
    const w = await expand(render({ providers }))
    await w.find('[data-testid="provider-vendor"]').setValue('deepseek')
    expect(providers[0].wireApi).toBe('responses')
  })

  it('打开面板本身不补任何东西', async () => {
    const providers = [provider({ vendor: 'deepseek', urls: { openai: '' } })]
    await expand(render({ providers }))
    expect(providers[0].urls).toEqual({ openai: '' })
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

describe('Model Vendor', () => {
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
    expect(shipped).toEqual(modelVendorModels('moonshot').map((m) => m.id))
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
    expect(shipped).toEqual(modelVendorModels('doubao').map((m) => m.id))
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

describe('测速入口', () => {
  it('每行的「测速」「报告」都带上这一行的 providerId 上抛意图', async () => {
    const w = render({ providers: [provider()], savedProviders: [provider()] })
    await w.find('[data-testid="provider-speed-test"]').trigger('click')
    expect(w.emitted('speedTest')).toEqual([[{ kind: 'open', providerId: 'p1' }]])

    await w.find('[data-testid="provider-speed-report"]').trigger('click')
    expect(w.emitted('speedTest')?.[1]).toEqual([{ kind: 'openReport', providerId: 'p1' }])
  })

  it('不在已提交快照里的 provider 不能测速:服务端只按已保存的配置拨号', async () => {
    // 草稿里有、已保存的快照里没有 —— 正是「新建还没保存」的样子。
    const w = render({ providers: [provider()], savedProviders: [] })
    const button = w.find('[data-testid="provider-speed-test"]')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('title')).toBe(
      'Save this provider first: the server only dials a saved configuration.',
    )
    await button.trigger('click')
    expect(w.emitted('speedTest')).toBeUndefined()
    // 报告是只读的历史,不受「有没有保存」影响。
    expect(w.find('[data-testid="provider-speed-report"]').attributes('disabled')).toBeUndefined()
  })

  it('「历史报告」总入口不带 providerId:候选由服务端按历史记录给出', async () => {
    const w = render({ providers: [provider()] })
    await w.find('[data-testid="provider-speed-history"]').trigger('click')
    expect(w.emitted('speedTest')).toEqual([[{ kind: 'listProviders' }]])
  })

  it('「对比」入口同样不带 providerId:它看的是所有有记录的提供方', async () => {
    const w = render({ providers: [provider()] })
    await w.find('[data-testid="provider-speed-compare"]').trigger('click')
    expect(w.emitted('speedTest')).toEqual([[{ kind: 'openCompare' }]])
  })

  it('非管理员打不开对比视图', async () => {
    const w = render({ providers: [provider()], isAdmin: false })
    expect(w.find('[data-testid="provider-speed-compare"]').attributes('disabled')).toBeDefined()
  })

  it('对比视图只在自己打开时挂载', () => {
    const closed = render({ providers: [provider()] })
    expect(closed.find('[data-testid="speed-test-compare-overlay"]').exists()).toBe(false)

    const open = render({
      providers: [provider()],
      speedTest: { ...emptySpeedTestState(), compareOpen: true, compare: [] },
    })
    expect(open.find('[data-testid="speed-test-compare-overlay"]').exists()).toBe(true)
  })

  it('非管理员一个测速动作都发不出去', async () => {
    const w = render({ providers: [provider()], savedProviders: [provider()], isAdmin: false })
    expect(w.find('[data-testid="provider-speed-test"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="provider-speed-report"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="provider-speed-history"]').attributes('disabled')).toBeDefined()
  })

  it('对话框与报告只在各自打开时挂载', async () => {
    const closed = render({ providers: [provider()], savedProviders: [provider()] })
    expect(closed.find('[data-testid="speed-test-overlay"]').exists()).toBe(false)
    expect(closed.find('[data-testid="speed-test-report-overlay"]').exists()).toBe(false)

    const dialog = render({
      providers: [provider()],
      savedProviders: [provider()],
      speedTest: { ...emptySpeedTestState(), dialogProviderId: 'p1' },
    })
    expect(dialog.find('[data-testid="speed-test-overlay"]').exists()).toBe(true)

    // 总入口先开面板、还没选中任何一条时,报告也必须能立起来。
    const report = render({
      providers: [provider()],
      savedProviders: [provider()],
      speedTest: { ...emptySpeedTestState(), reportOpen: true },
    })
    expect(report.find('[data-testid="speed-test-report-overlay"]').exists()).toBe(true)
    expect(report.find('[data-testid="speed-test-report-empty"]').text()).toBe(
      'Pick a provider to see its history.',
    )
  })

  it('对话框的候选只取已保存快照:草稿里的新端点不作为可测目标', async () => {
    const saved = provider({ displayName: 'Saved', urls: { openai: 'https://saved.example/v1' } })
    const draft = provider({ displayName: 'Draft', urls: { openai: 'https://draft.example/v1' } })
    const w = render({
      providers: [draft],
      savedProviders: [saved],
      speedTest: { ...emptySpeedTestState(), dialogProviderId: 'p1' },
    })
    expect(w.find('[data-testid="speed-test-overlay"]').text()).toContain('Saved')
    expect(w.find('[data-testid="speed-test-draft-note"]').exists()).toBe(true)
  })

  it('模型目录为空时仍可留空开始,也可手输目录外模型', async () => {
    const saved = provider({ urls: { openai: 'https://saved.example/v1' }, models: [] })
    const w = render({
      providers: [saved],
      savedProviders: [saved],
      speedTest: { ...emptySpeedTestState(), dialogProviderId: 'p1' },
    })
    const model = w.find('[data-testid="speed-test-model"]')
    const start = w.find('[data-testid="speed-test-start"]')
    expect((model.element as HTMLInputElement).value).toBe('')
    expect(model.attributes('disabled')).toBeUndefined()
    expect(start.attributes('disabled')).toBeUndefined()
    expect(w.find('[data-testid="speed-test-model-note"]').exists()).toBe(true)

    await model.setValue('  gateway/new-model  ')
    await start.trigger('click')
    expect(w.emitted('speedTest')).toEqual([
      [
        {
          kind: 'start',
          providerId: 'p1',
          protocolType: 'openai',
          model: '  gateway/new-model  ',
          requestCount: 10,
        },
      ],
    ])
  })

  it('模型目录仍作为可输入控件的预设候选,但打开时不自动填首项', () => {
    const saved = provider({
      urls: { openai: 'https://saved.example/v1' },
      models: [{ id: 'preset-model' }],
    })
    const w = render({
      providers: [saved],
      savedProviders: [saved],
      speedTest: { ...emptySpeedTestState(), dialogProviderId: 'p1' },
    })
    expect((w.find('[data-testid="speed-test-model"]').element as HTMLInputElement).value).toBe('')
    expect(w.find('datalist option').attributes('value')).toBe('preset-model')
  })

  it('服务端仍持有的未提交轮次,重开对话框后照样给得出「重试保存」', async () => {
    // 样本已经付过费:对话框关掉再打开(或整页刷新)只是重新问了一次 active,
    // 入口必须从服务端的回答里长出来,而不是靠「当时收到过那一帧」。
    const w = render({
      providers: [provider()],
      savedProviders: [provider()],
      speedTest: {
        ...emptySpeedTestState(),
        dialogProviderId: 'p1',
        active: activeRun({ state: 'save_failed' }),
      },
    })
    const retry = w.find('[data-testid="speed-test-retry-save"]')
    expect(retry.exists()).toBe(true)
    await retry.trigger('click')
    expect(w.emitted('speedTest')).toEqual([[{ kind: 'retrySave', runId: 'r1' }]])
    // 这一轮占着提供方,「开始」只会换来 busy:不给这个按钮,免得它把注意力
    // 从真正该做的动作上引开。
    expect(w.find('[data-testid="speed-test-start"]').exists()).toBe(false)
  })

  it('没有待提交轮次时不出现「重试保存」', () => {
    const w = render({
      providers: [provider()],
      savedProviders: [provider()],
      speedTest: {
        ...emptySpeedTestState(),
        dialogProviderId: 'p1',
        active: activeRun({ state: 'running' }),
      },
    })
    expect(w.find('[data-testid="speed-test-unsaved"]').exists()).toBe(false)
  })

  it('对话框开着时快照换掉了当前协议槽:开始被挡住,不静默改选另一个端点', async () => {
    const saved = provider({ urls: { openai: 'https://a.example/v1' }, models: [{ id: 'm1' }] })
    const w = render({
      providers: [saved],
      savedProviders: [saved],
      speedTest: { ...emptySpeedTestState(), dialogProviderId: 'p1' },
    })
    const start = () => w.find('[data-testid="speed-test-start"]')
    expect(start().attributes('disabled')).toBeUndefined()

    // 同一个 id 的已提交快照在别处被改过:openai 槽没了。
    await w.setProps({
      savedProviders: [
        provider({ urls: { anthropic: 'https://a.example/anthropic' }, models: [{ id: 'm1' }] }),
      ],
    })
    expect(start().attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="speed-test-blocker"]').text()).toBe(
      'The selected protocol is unavailable. Refresh the configuration and choose again.',
    )
  })
})
