import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import type {
  AgentConfig,
  Automation,
  ToolManifestEntry,
  VendorHostStatus,
} from '@ccc/shared/protocol'
import { isValidCron } from '@ccc/shared/cron'
import AutomationForm from './AutomationForm.vue'

const HOST_PRESENT: VendorHostStatus[] = [
  {
    vendor: 'claude',
    present: true,
    binary: 'claude',
    path: '/usr/local/bin/claude',
    installHint: '',
  },
  {
    vendor: 'codex',
    present: true,
    binary: 'codex',
    path: '/usr/local/bin/codex',
    installHint: '',
  },
]

const READ_TOOLS: ToolManifestEntry[] = [
  { name: 'Read', isWrite: false },
  { name: 'Grep', isWrite: false },
]
const WRITE_TOOLS: ToolManifestEntry[] = [
  { name: 'Write', isWrite: true },
  { name: 'Edit', isWrite: true },
]
const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS]
const AGENTS: AgentConfig[] = [
  {
    id: 'claude-default',
    vendor: 'claude',
    configMode: 'system',
    displayName: 'Claude default',
    config: { baseUrl: '', apiKey: '', model: '' },
  },
]

function mountForm(
  props: Partial<{
    open: boolean
    automation: Automation | null
    workspaceId: string
    timezone: string
    toolManifest: Record<string, ToolManifestEntry[] | null>
    toolManifestLoading: boolean
    toolManifestError: string | null
    hostStatus: VendorHostStatus[]
    agents: AgentConfig[]
    automationAgentId: string
    defaultAgentId: string
  }> = {},
) {
  return mount(AutomationForm, {
    props: {
      open: true,
      automation: null,
      workspacePath: 'ws-proj',
      timezone: 'UTC',
      toolManifest: {},
      toolManifestLoading: false,
      toolManifestError: null,
      hostStatus: HOST_PRESENT,
      agents: AGENTS,
      automationAgentId: '',
      defaultAgentId: '',
      ...props,
    },
  })
}

function sched(over: Partial<Automation> = {}): Automation {
  return {
    id: 's1',
    type: 'command',
    config: { command: 'pnpm build', name: 'legacy name' },
    maxWallClockMs: null,
    workspaceId: '/home/proj',
    triggerType: 'cron',
    cronExpression: '0 8 * * *',
    nextRunAt: null,
    eventFilter: null,
    status: 'active',
    mode: 'sandboxed',
    toolAllowlist: [],
    toolDenylist: [],
    vendor: 'claude',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  }
}

describe('AutomationForm.vue — 创建/编辑表单', () => {
  it('只渲染 Advanced 周期构建器,不再有 Natural language / Presets', () => {
    const w = mountForm()
    expect(w.find('.sf-tab').exists()).toBe(false)
    expect(w.find('.sf-presets').exists()).toBe(false)
    expect(w.find('.sf-advanced').exists()).toBe(true)
    expect(w.text()).not.toContain('Natural language')
    expect(w.text()).not.toContain('Presets')
  })

  it('不收集 name / description,且 canSave 不依赖 name', async () => {
    const w = mountForm()
    // 没有任何名为 name/description 的输入项
    const labels = w.findAll('.sf-label').map((l) => l.text().toLowerCase())
    expect(labels).not.toContain('name')
    expect(labels).not.toContain('description')

    const saveBtn = w.find('.sf-btn.primary')
    // 任务体为空 → 不可保存
    expect(saveBtn.attributes('disabled')).toBeDefined()
    // 仅填命令(无 name)→ 可保存
    await w.find('textarea').setValue('pnpm build')
    expect(saveBtn.attributes('disabled')).toBeUndefined()
  })

  it('create:payload 含核心字段,config 仅任务体,不含 name/description', async () => {
    const w = mountForm()
    await w.find('textarea').setValue('pnpm build')
    await w.find('.sf-btn.primary').trigger('click')

    const created = w.emitted('create')
    expect(created).toBeTruthy()
    const input = created![0][0] as Record<string, unknown>
    expect(input.type).toBe('command')
    expect(input.workspaceId).toBe('ws-proj')
    expect(input.mode).toBe('default')
    expect(isValidCron(input.cronExpression as string)).toBe(true)
    expect(input.config).toEqual({ command: 'pnpm build' })
    expect(input.maxWallClockMs).toBeNull()
    expect(input.config).not.toHaveProperty('name')
    expect(input.config).not.toHaveProperty('description')
  })

  it('create(llm):切换任务类型后 config 仅含 prompt', async () => {
    const w = mountForm()
    const segs = w.findAll('.sf-seg')
    await segs[1].trigger('click') // LLM prompt
    await w.find('.sf-agent-select').setValue('claude-default')
    await w.find('textarea').setValue('Run a security audit')
    await w.find('.sf-btn.primary').trigger('click')

    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(input.type).toBe('llm')
    expect(input.config).toEqual({ prompt: 'Run a security audit' })
    expect(input.maxWallClockMs).toBeNull()
    expect(input.config).not.toHaveProperty('name')
  })

  it('Advanced(weekly + days)产出有效 cronExpression', async () => {
    const w = mountForm()
    await w.find('textarea').setValue('pnpm test')
    // frequency → weekly
    await w.find('select.sf-adv-control').setValue('weekly')
    // 切换一天,确保 days 段参与
    const days = w.findAll('.sf-day')
    await days[6].trigger('click') // Sat
    await w.find('.sf-btn.primary').trigger('click')

    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(isValidCron(input.cronExpression as string)).toBe(true)
  })

  it('edit:展示预填当前名的 Title 输入框;create 无该字段', () => {
    // create:无 Title 字段
    const labelsCreate = mountForm()
      .findAll('.sf-label')
      .map((l) => l.text())
    expect(labelsCreate).not.toContain('Title')

    // edit:Title 输入框预填当前 config.name
    const w = mountForm({ automation: sched() })
    const labelsEdit = w.findAll('.sf-label').map((l) => l.text())
    expect(labelsEdit).toContain('Title')
    const title = w.find('input.sf-input')
    expect((title.element as HTMLInputElement).value).toBe('legacy name')
  })

  it('update:payload 携带编辑后的 config.name(标题),保留 cron/mode', async () => {
    const w = mountForm({ automation: sched() })
    await w.find('input.sf-input').setValue('My Title')
    await w.find('.sf-btn.primary').trigger('click')

    const [id, input] = w.emitted('update')![0] as [string, Record<string, unknown>]
    expect(id).toBe('s1')
    expect(input.mode).toBe('auto')
    expect(isValidCron(input.cronExpression as string)).toBe(true)
    expect(input.config).toEqual({ command: 'pnpm build', name: 'My Title' })
    expect(input.config).not.toHaveProperty('description')
    expect(input).not.toHaveProperty('type')
  })

  it('update:清空标题 → config.name 为空串(服务端据此回退自动命名)', async () => {
    const w = mountForm({ automation: sched() })
    await w.find('input.sf-input').setValue('   ')
    await w.find('.sf-btn.primary').trigger('click')

    const [, input] = w.emitted('update')![0] as [string, Record<string, unknown>]
    expect((input.config as Record<string, unknown>).name).toBe('')
  })

  it('create/update:序列化并回填 maxWallClockMs', async () => {
    const created = mountForm()
    await created.find('textarea').setValue('pnpm build')
    await created.find('.sf-timeout-input').setValue('120000')
    await created.find('.sf-btn.primary').trigger('click')
    expect((created.emitted('create')![0][0] as Record<string, unknown>).maxWallClockMs).toBe(
      120000,
    )

    const edited = mountForm({ automation: sched({ maxWallClockMs: 90000 }) })
    expect((edited.find('.sf-timeout-input').element as HTMLInputElement).value).toBe('90000')
    await edited.find('.sf-btn.primary').trigger('click')
    expect((edited.emitted('update')![0][1] as Record<string, unknown>).maxWallClockMs).toBe(90000)
  })

  it('create(event):切到事件触发 → payload 含 triggerType/eventFilter,cron 为空', async () => {
    const w = mountForm()
    await w.find('textarea').setValue('echo done')
    // 第 2 个 segmented 是 trigger 类型(第 1 个是任务类型);[1] = event。
    const segmenteds = w.findAll('.sf-segmented')
    await segmenteds[1].findAll('.sf-seg')[1].trigger('click')
    // 默认事件类型 run:settled(run-lifecycle),保存前需勾选至少一个 sessionKind。
    // event 模式下 .sf-day 仅为 7 个 sessionKind chip(work 为首)。
    await w.findAll('.sf-day')[0].trigger('click') // work
    await w.find('.sf-btn.primary').trigger('click')

    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(input.triggerType).toBe('event')
    expect(input.cronExpression).toBe('')
    // 默认订阅运行结束,未填 status → 仅 type。
    expect(input.eventFilter).toEqual({ type: 'run:settled' })
    expect(input.eventSessionKindFilter).toEqual(['work'])
  })

  it('未勾选 sessionKind 时 run:settled 事件触发不可保存', async () => {
    const w = mountForm()
    await w.find('textarea').setValue('echo done')
    await w.findAll('.sf-segmented')[1].findAll('.sf-seg')[1].trigger('click') // event
    // 一个 sessionKind 都没选 → 保存按钮禁用,点击不触发 create。
    expect(w.find('.sf-btn.primary').attributes('disabled')).toBeDefined()
    await w.find('.sf-btn.primary').trigger('click')
    expect(w.emitted('create')).toBeUndefined()
  })

  it('create(event/settled):填 status + 勾选 sessionKind → eventFilter.statuses 携带', async () => {
    const w = mountForm()
    await w.find('textarea').setValue('echo done')
    await w.findAll('.sf-segmented')[1].findAll('.sf-seg')[1].trigger('click') // event
    // 增加一个 status 行并填 'error'。
    await w.find('[data-testid="status-add"]').trigger('click')
    await w.find('[data-testid="status-row"]').find('input').setValue('error')
    await w.findAll('.sf-day')[0].trigger('click') // sessionKind 'work'
    await w.find('.sf-btn.primary').trigger('click')

    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(input.eventFilter).toEqual({ type: 'run:settled', statuses: ['error'] })
    expect(input.eventSessionKindFilter).toEqual(['work'])
  })

  it('create(event/settled):metadata 注解 + metadata 条件构建 → payload 携带', async () => {
    const w = mountForm()
    await w.find('textarea').setValue('echo done')
    await w.findAll('.sf-segmented')[1].findAll('.sf-seg')[1].trigger('click') // event
    await w.findAll('.sf-day')[0].trigger('click') // sessionKind 'work'
    // metadata 注解:增行并填 key/value。
    await w.find('[data-testid="metadata-add"]').trigger('click')
    const metaInputs = w.find('[data-testid="metadata-row"]').findAll('input')
    await metaInputs[0].setValue('stage')
    await metaInputs[1].setValue('a')
    // metadata 条件(进入 eventFilter.metadata):增行并填 key/value。
    await w.find('[data-testid="metadata-condition-add"]').trigger('click')
    const condInputs = w.find('[data-testid="metadata-condition-row"]').findAll('input')
    await condInputs[0].setValue('team')
    await condInputs[1].setValue('core')
    await w.find('.sf-btn.primary').trigger('click')

    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(input.metadata).toEqual({ stage: 'a' })
    expect(input.eventFilter).toEqual({
      type: 'run:settled',
      metadata: { conditions: [{ key: 'team', value: 'core' }], combinator: 'AND' },
    })
  })

  it('create(event/pr:operation):事件类型填 pr:operation → 展示 MCP 说明,无需 sessionKind', async () => {
    const w = mountForm()
    await w.find('textarea').setValue('echo done')
    await w.findAll('.sf-segmented')[1].findAll('.sf-seg')[1].trigger('click') // event
    await w.find('[data-testid="event-type-input"]').setValue('pr:operation')
    // 展示「模型自行执行 PR 操作、MCP 仅发布事件」边界说明。
    expect(w.find('.sf-pr-note').exists()).toBe(true)
    await w.find('.sf-btn.primary').trigger('click')

    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(input.triggerType).toBe('event')
    expect(input.cronExpression).toBe('')
    expect(input.eventFilter).toEqual({ type: 'pr:operation' })
    // 非 run-lifecycle 类型不携带 sessionKind 安全边界。
    expect(input.eventSessionKindFilter).toBeNull()
  })

  it('create(event/pr:operation):operation 作为 metadata OR 条件 + result 作为 status', async () => {
    const w = mountForm()
    await w.find('textarea').setValue('echo done')
    await w.findAll('.sf-segmented')[1].findAll('.sf-seg')[1].trigger('click') // event
    await w.find('[data-testid="event-type-input"]').setValue('pr:operation')
    // result → status
    await w.find('[data-testid="status-add"]').trigger('click')
    await w.find('[data-testid="status-row"]').find('input').setValue('success')
    // operation → OR metadata 条件
    await w.find('.sf-combinator').findAll('.sf-seg')[1].trigger('click') // OR
    await w.find('[data-testid="metadata-condition-add"]').trigger('click')
    const cond = w.find('[data-testid="metadata-condition-row"]').findAll('input')
    await cond[0].setValue('operation')
    await cond[1].setValue('merge')
    await w.find('.sf-btn.primary').trigger('click')

    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(input.eventFilter).toEqual({
      type: 'pr:operation',
      statuses: ['success'],
      metadata: { conditions: [{ key: 'operation', value: 'merge' }], combinator: 'OR' },
    })
  })

  it('create(event):自定义(非硬编码)事件类型无需改协议枚举即可保存', async () => {
    const w = mountForm()
    await w.find('textarea').setValue('echo done')
    await w.findAll('.sf-segmented')[1].findAll('.sf-seg')[1].trigger('click') // event
    await w.find('[data-testid="event-type-input"]').setValue('custom:thing')
    await w.find('[data-testid="status-add"]').trigger('click')
    await w.find('[data-testid="status-row"]').find('input').setValue('ok')
    await w.find('.sf-btn.primary').trigger('click')

    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(input.eventFilter).toEqual({ type: 'custom:thing', statuses: ['ok'] })
    expect(input.eventSessionKindFilter).toBeNull()
  })

  it('edit(event/pr:operation):从 automation.eventFilter 回读 type/statuses/metadata', () => {
    const w = mountForm({
      automation: sched({
        triggerType: 'event',
        cronExpression: '',
        eventFilter: {
          type: 'pr:operation',
          statuses: ['failure'],
          metadata: { conditions: [{ key: 'operation', value: 'close' }], combinator: 'OR' },
        },
      }),
    })
    expect((w.find('[data-testid="event-type-input"]').element as HTMLInputElement).value).toBe(
      'pr:operation',
    )
    // status 行回读。
    expect(
      (w.find('[data-testid="status-row"]').find('input').element as HTMLInputElement).value,
    ).toBe('failure')
    // metadata 条件回读。
    const cond = w.find('[data-testid="metadata-condition-row"]').findAll('input')
    expect((cond[0].element as HTMLInputElement).value).toBe('operation')
    expect((cond[1].element as HTMLInputElement).value).toBe('close')
    // PR 说明可见,且非 run-lifecycle 不显示 sessionKind chip。
    expect(w.find('.sf-pr-note').exists()).toBe(true)
    expect(w.findAll('.sf-day')).toHaveLength(0)
  })

  // ---- Sectioned layout ----------------------------------------------------

  it('表单渲染为 5 个带标题的卡片区块', () => {
    const w = mountForm()
    const sections = w.findAll('.sf-section')
    expect(sections).toHaveLength(5)
    const testids = [
      'section-basic',
      'section-trigger',
      'section-metadata',
      'section-execution',
      'section-tools',
    ]
    for (const id of testids) {
      expect(w.find(`[data-testid="${id}"]`).exists()).toBe(true)
    }
    const titles = w.findAll('.sf-section-title').map((s) => s.text())
    expect(titles).toEqual([
      'Basic info',
      'Trigger',
      'Metadata',
      'Execution & permissions',
      'Tool permissions',
    ])
  })

  it('区块归属:任务类型落基本信息、触发落触发条件、工具落工具权限', () => {
    const w = mountForm({ toolManifest: { claude: ALL_TOOLS } })
    const basic = w.find('[data-testid="section-basic"]')
    expect(basic.text()).toContain('Task type')
    const trigger = w.find('[data-testid="section-trigger"]')
    expect(trigger.text()).toContain('Trigger')
    const tools = w.find('[data-testid="section-tools"]')
    expect(tools.find('.sf-tool-item').exists()).toBe(true)
  })

  // ---- Generic event type (free-string) ------------------------------------

  it('event 默认事件类型为 run:settled,显示 sessionKind 选择', async () => {
    const w = mountForm()
    await w.find('textarea').setValue('echo done')
    await w.findAll('.sf-segmented')[1].findAll('.sf-seg')[1].trigger('click') // event
    // 默认事件类型输入框预填 run:settled(run-lifecycle → 显示 7 个 sessionKind chip)。
    expect((w.find('[data-testid="event-type-input"]').element as HTMLInputElement).value).toBe(
      'run:settled',
    )
    expect(w.findAll('.sf-day')).toHaveLength(7)
    await w.findAll('.sf-day')[0].trigger('click') // work
    await w.find('.sf-btn.primary').trigger('click')
    expect((w.emitted('create')![0][0] as Record<string, unknown>).eventFilter).toEqual({
      type: 'run:settled',
    })
  })

  it('event 改类型为 run:started → 仍显示 sessionKind,映射 run:started', async () => {
    const w = mountForm()
    await w.find('textarea').setValue('echo done')
    await w.findAll('.sf-segmented')[1].findAll('.sf-seg')[1].trigger('click') // event
    await w.find('[data-testid="event-type-input"]').setValue('run:started')
    expect(w.findAll('.sf-day')).toHaveLength(7)
    await w.findAll('.sf-day')[0].trigger('click') // work
    await w.find('.sf-btn.primary').trigger('click')
    expect((w.emitted('create')![0][0] as Record<string, unknown>).eventFilter).toEqual({
      type: 'run:started',
    })
  })

  it('event 类型为 intent:lifecycle → 无 sessionKind 边界', async () => {
    const w = mountForm()
    await w.find('textarea').setValue('echo done')
    await w.findAll('.sf-segmented')[1].findAll('.sf-seg')[1].trigger('click') // event
    await w.find('[data-testid="event-type-input"]').setValue('intent:lifecycle')
    // 非 run-lifecycle → 不渲染 sessionKind chip。
    expect(w.findAll('.sf-day')).toHaveLength(0)
    await w.find('.sf-btn.primary').trigger('click')
    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(input.eventFilter).toEqual({ type: 'intent:lifecycle' })
    expect(input.eventSessionKindFilter).toBeNull()
  })

  it('edit 回显:run:started → 事件类型输入预填,sessionKind 回读高亮', () => {
    const w = mountForm({
      automation: sched({
        triggerType: 'event',
        cronExpression: '',
        eventFilter: { type: 'run:started' },
        eventSessionKindFilter: ['work', 'automation'],
      }),
    })
    expect((w.find('[data-testid="event-type-input"]').element as HTMLInputElement).value).toBe(
      'run:started',
    )
    const days = w.findAll('.sf-day')
    expect(days).toHaveLength(7)
    expect(days[0].classes()).toContain('active') // work
    expect(days[3].classes()).toContain('active') // automation
  })

  it('edit 回显:run:settled → 事件类型输入预填,显示 sessionKind chip', () => {
    const w = mountForm({
      automation: sched({
        triggerType: 'event',
        cronExpression: '',
        eventFilter: { type: 'run:settled', statuses: ['error'] },
        eventSessionKindFilter: ['work'],
      }),
    })
    expect((w.find('[data-testid="event-type-input"]').element as HTMLInputElement).value).toBe(
      'run:settled',
    )
    // status 行回读。
    expect(
      (w.find('[data-testid="status-row"]').find('input').element as HTMLInputElement).value,
    ).toBe('error')
    expect(w.findAll('.sf-day')).toHaveLength(7)
  })

  it('edit:cron 显示为紧凑摘要，修改弹框确认后回填并随表单提交', async () => {
    const w = mountForm({ automation: sched({ cronExpression: '0 */1 * * *' }) })
    expect(w.find('.sf-advanced').exists()).toBe(false)
    expect(w.find('.sf-cron-inline').text()).toContain('0 */1 * * *')
    expect(w.find('.sf-cron-inline').text()).toContain('Every 1 hours')

    await w.find('.sf-cron-edit').trigger('click')
    expect(w.find('[role="dialog"]').exists()).toBe(true)
    await w.find('.sce-time:last-of-type').setValue('30')
    await w.find('.sce-button--primary').trigger('click')
    expect(w.find('.sf-cron-inline').text()).toContain('30 */1 * * *')

    await w.find('.sf-btn.primary').trigger('click')
    const [, input] = w.emitted('update')![0] as [string, Record<string, unknown>]
    expect(input.cronExpression).toBe('30 */1 * * *')
  })

  // ---- Vendors -------------------------------------------------------------

  it('渲染 vendor 下拉选择器,两个品牌均可见', () => {
    const w = mountForm()
    const select = w.find('select.sf-select')
    expect(select.exists()).toBe(true)
    const opts = select.findAll('option')
    expect(opts).toHaveLength(2)
    expect(opts[0].text()).toBe('Claude')
    expect(opts[1].text()).toBe('Codex')
  })

  it('host 缺失的 vendor 选项 disabled, host 存在的不 disabled', () => {
    const w = mountForm()
    const opts = w.findAll('select.sf-select option')
    // claude present → enabled
    expect(opts[0].attributes('disabled')).toBeUndefined()
    // codex present → enabled
    expect(opts[1].attributes('disabled')).toBeUndefined()
  })

  it('create payload 默认 vendor=claude,含 toolAllowlist', async () => {
    const w = mountForm({
      toolManifest: { claude: ALL_TOOLS },
    })
    await w.find('textarea').setValue('pnpm build')
    await w.find('.sf-btn.primary').trigger('click')

    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(input.vendor).toBe('claude')
  })

  // ---- default agent seeding (AC-R25) --------------------------------------

  const MULTI_AGENTS: AgentConfig[] = [
    {
      id: 'claude-default',
      vendor: 'claude',
      configMode: 'system',
      displayName: 'Claude default',
      config: { baseUrl: '', apiKey: '', model: '' },
    },
    {
      id: 'codex-custom',
      vendor: 'codex',
      configMode: 'custom',
      displayName: 'Codex custom',
      config: { wireApi: 'chat', baseUrl: '', apiKey: '', model: '' },
    },
  ]

  it('create:automationAgentId 指向 codex agent 时,表单预选 codex + 该 agent', async () => {
    const w = mountForm({ agents: MULTI_AGENTS, automationAgentId: 'codex-custom' })
    // vendor 下拉预选 codex。
    expect((w.find('select.sf-select').element as HTMLSelectElement).value).toBe('codex')
    // 切到 LLM 类型后 agent 下拉预选该 codex agent。
    await w.findAll('.sf-seg')[1].trigger('click')
    expect((w.find('.sf-agent-select').element as HTMLSelectElement).value).toBe('codex-custom')
  })

  it('create:automationAgentId 为空时跟随 defaultAgentId 解析出的 agent', async () => {
    const w = mountForm({
      agents: MULTI_AGENTS,
      automationAgentId: '',
      defaultAgentId: 'codex-custom',
    })
    expect((w.find('select.sf-select').element as HTMLSelectElement).value).toBe('codex')
    await w.findAll('.sf-seg')[1].trigger('click')
    expect((w.find('.sf-agent-select').element as HTMLSelectElement).value).toBe('codex-custom')
  })

  it('edit:已有 automation 使用自身 vendor/agentId,不被系统配置覆盖', () => {
    const w = mountForm({
      agents: MULTI_AGENTS,
      automationAgentId: 'codex-custom',
      automation: sched({ vendor: 'claude', agentId: 'claude-default', type: 'llm' }),
    })
    // 编辑态保留 automation 记录自身的 claude，忽略指向 codex 的系统配置。
    expect((w.find('select.sf-select').element as HTMLSelectElement).value).toBe('claude')
    expect((w.find('.sf-agent-select').element as HTMLSelectElement).value).toBe('claude-default')
  })

  // ---- load-tool-manifest event --------------------------------------------

  it('create:打开表单立即 emit load-tool-manifest(claude)', () => {
    const w = mountForm()
    const events = w.emitted('load-tool-manifest')
    expect(events).toBeTruthy()
    expect(events![0]).toEqual(['claude'])
  })

  it('edit:打开表单立即 emit load-tool-manifest(当前 vendor)', () => {
    const w = mountForm({ automation: sched({ vendor: 'codex' }) })
    const events = w.emitted('load-tool-manifest')
    expect(events).toBeTruthy()
    expect(events![0]).toEqual(['codex'])
  })

  it('edit(claude):默认 vendor 时也能正确 emit', () => {
    const w = mountForm({ automation: sched({ vendor: 'claude' }) })
    const events = w.emitted('load-tool-manifest')
    expect(events).toBeTruthy()
    expect(events![0]).toEqual(['claude'])
  })

  // ---- Tool manifest -------------------------------------------------------

  it('无工具清单时显示空态文案', () => {
    const w = mountForm({
      toolManifest: { claude: null },
    })
    expect(w.text()).toContain('No tools available')
  })

  it('工具加载中显示 loading 态', () => {
    const w = mountForm({
      toolManifestLoading: true,
    })
    expect(w.text()).toContain('Loading tools')
  })

  it('读工具默认勾上,写工具默认不勾', () => {
    const w = mountForm({
      toolManifest: { claude: ALL_TOOLS },
    })
    const checks = w.findAll('.sf-tool-item input[type="checkbox"]')
    // READ_TOOLS: 2 items (Read, Grep) — default checked
    expect((checks[0].element as HTMLInputElement).checked).toBe(true)
    expect((checks[1].element as HTMLInputElement).checked).toBe(true)
    // WRITE_TOOLS: 2 items (Write, Edit) — default unchecked
    expect((checks[2].element as HTMLInputElement).checked).toBe(false)
    expect((checks[3].element as HTMLInputElement).checked).toBe(false)
  })

  it('工具按读写分区展示,两组各正确数量', () => {
    const w = mountForm({
      toolManifest: { claude: ALL_TOOLS },
    })
    const groupLabels = w.findAll('.sf-tools-subtitle')
    expect(groupLabels).toHaveLength(2)
    expect(groupLabels[0].text()).toBe('Read-only')
    expect(groupLabels[1].text()).toBe('Write')

    const items = w.findAll('.sf-tool-item')
    expect(items).toHaveLength(4)
  })

  it('全选/全清按钮工作正确', async () => {
    const w = mountForm({
      toolManifest: { claude: ALL_TOOLS },
    })
    // 默认:读勾写不勾 → 选中 2 个
    expect(w.findAll('.sf-tool-item input:checked')).toHaveLength(2)

    // 全选 → 4 个
    await w.find('.sf-tools-btn').trigger('click') // "Select all"
    expect(w.findAll('.sf-tool-item input:checked')).toHaveLength(4)

    // 全清 → 0 个
    await w.findAll('.sf-tools-btn')[1].trigger('click') // "Clear all"
    expect(w.findAll('.sf-tool-item input:checked')).toHaveLength(0)
  })

  it('手动切换工具的勾选状态', async () => {
    const w = mountForm({
      toolManifest: { claude: ALL_TOOLS },
    })
    const checks = w.findAll('.sf-tool-item input[type="checkbox"]')
    // 默认第 1 个(Read)勾上,点击取消
    expect((checks[0].element as HTMLInputElement).checked).toBe(true)
    await checks[0].trigger('change')
    expect((checks[0].element as HTMLInputElement).checked).toBe(false)
    // 第 3 个(Write)默认没勾,点击勾上
    expect((checks[2].element as HTMLInputElement).checked).toBe(false)
    await checks[2].trigger('change')
    expect((checks[2].element as HTMLInputElement).checked).toBe(true)
  })

  // ---- Save payload with toolAllowlist -------------------------------------

  it('create payload 携带 toolAllowlist', async () => {
    const w = mountForm({
      toolManifest: { claude: ALL_TOOLS },
    })
    await w.find('textarea').setValue('pnpm build')
    // 默认只勾读了;勾上 Write
    const checks = w.findAll('.sf-tool-item input[type="checkbox"]')
    await checks[2].trigger('change') // toggle Write on

    await w.find('.sf-btn.primary').trigger('click')

    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(input.toolAllowlist).toEqual(['Read', 'Grep', 'Write'])
  })

  it('update payload 携带 toolAllowlist', async () => {
    const w = mountForm({
      automation: sched(),
      toolManifest: { claude: ALL_TOOLS },
    })
    await w.find('.sf-btn.primary').trigger('click')

    const [, input] = w.emitted('update')![0] as [string, Record<string, unknown>]
    expect(input).toHaveProperty('toolAllowlist')
  })

  it('编辑回读:从 automation.toolAllowlist 还原勾选', async () => {
    const w = mountForm({
      automation: sched({ toolAllowlist: ['Write', 'Edit'] }),
      toolManifest: { claude: ALL_TOOLS },
    })
    const checks = w.findAll('.sf-tool-item input[type="checkbox"]')
    // Read/Grep 未在 toolAllowlist 中 → 不勾
    expect((checks[0].element as HTMLInputElement).checked).toBe(false)
    expect((checks[1].element as HTMLInputElement).checked).toBe(false)
    // Write/Edit 在 toolAllowlist 中 → 勾上
    expect((checks[2].element as HTMLInputElement).checked).toBe(true)
    expect((checks[3].element as HTMLInputElement).checked).toBe(true)
  })

  // ---- network-access pseudo-entry (codex-only) ----------------------------

  it('network-access 开关仅 codex 可见,claude 隐藏', async () => {
    const w = mountForm({ toolManifest: { claude: ALL_TOOLS, codex: ALL_TOOLS } })
    // 默认 claude → 不渲染
    expect(w.find('[data-testid="network-access"]').exists()).toBe(false)
    // 切到 codex → 渲染,且带 codex-only / workspace-write 提示
    await w.find('select.sf-select').setValue('codex')
    expect(w.find('[data-testid="network-access"]').exists()).toBe(true)
    expect(w.find('[data-testid="network-access"]').text()).toContain('Codex only')
    expect(w.find('[data-testid="network-access"]').text()).toContain('workspace-write')
  })

  it('network-access 默认未勾选', async () => {
    const w = mountForm({
      toolManifest: { codex: ALL_TOOLS },
      automation: sched({ vendor: 'codex' }),
    })
    const cb = w.find('[data-testid="network-access-checkbox"]')
    expect((cb.element as HTMLInputElement).checked).toBe(false)
  })

  it('勾选 network-access 后 create payload 的 toolAllowlist 含伪条目', async () => {
    const w = mountForm({ toolManifest: { claude: ALL_TOOLS, codex: ALL_TOOLS } })
    await w.find('textarea').setValue('pnpm build')
    await w.find('select.sf-select').setValue('codex')
    await w.find('[data-testid="network-access-checkbox"]').trigger('change')
    await w.find('.sf-btn.primary').trigger('click')

    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(input.toolAllowlist as string[]).toContain('network-access')
  })

  it('未勾选 network-access 时 create payload 不含伪条目', async () => {
    const w = mountForm({ toolManifest: { claude: ALL_TOOLS, codex: ALL_TOOLS } })
    await w.find('textarea').setValue('pnpm build')
    await w.find('select.sf-select').setValue('codex')
    await w.find('.sf-btn.primary').trigger('click')

    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(input.toolAllowlist as string[]).not.toContain('network-access')
  })

  it('编辑回读:toolAllowlist 含 network-access → 勾上', () => {
    const w = mountForm({
      automation: sched({ vendor: 'codex', toolAllowlist: ['Read', 'network-access'] }),
      toolManifest: { codex: ALL_TOOLS },
    })
    const cb = w.find('[data-testid="network-access-checkbox"]')
    expect((cb.element as HTMLInputElement).checked).toBe(true)
  })

  it('与「全选工具」互不联动:全选保留已开启的 network-access', async () => {
    const w = mountForm({
      automation: sched({ vendor: 'codex', toolAllowlist: ['network-access'] }),
      toolManifest: { codex: ALL_TOOLS },
    })
    // network 开、无真实工具
    expect(
      (w.find('[data-testid="network-access-checkbox"]').element as HTMLInputElement).checked,
    ).toBe(true)
    // 点「全选」→ 真实工具全进,network 标志保留
    await w.findAll('.sf-tools-btn')[0].trigger('click')
    await w.find('.sf-btn.primary').trigger('click')

    const [, input] = w.emitted('update')![0] as [string, Record<string, unknown>]
    const allow = input.toolAllowlist as string[]
    expect(allow).toContain('network-access')
    expect(allow).toContain('Read')
    expect(allow).toContain('Write')
  })

  it('全选工具(未开 network)不会隐式开启 network-access', async () => {
    const w = mountForm({
      automation: sched({ vendor: 'codex', toolAllowlist: ['Read'] }),
      toolManifest: { codex: ALL_TOOLS },
    })
    await w.findAll('.sf-tools-btn')[0].trigger('click') // selectAll
    await w.find('.sf-btn.primary').trigger('click')

    const [, input] = w.emitted('update')![0] as [string, Record<string, unknown>]
    expect(input.toolAllowlist as string[]).not.toContain('network-access')
  })

  // ---- Permission mode per vendor -----------------------------------------

  it('create(codex):payload 携带 CodexPolicy 对象', async () => {
    const w = mountForm()
    await w.find('textarea').setValue('pnpm build')
    // 切换到 codex vendor
    const vendorSelect = w.find('select.sf-select')
    await vendorSelect.setValue('codex')

    // Codex 的 segmented mode: 默认 sandbox=workspace-write, approval=on-request
    await w.find('.sf-btn.primary').trigger('click')

    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(input.mode).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    })
  })

  it('权限模式控件随 vendor 切换联动', async () => {
    const w = mountForm({
      toolManifest: { claude: ALL_TOOLS },
    })
    const vendorSelect = w.find('select.sf-select')

    // 默认 claude → Claude dropdown 可见 (vendor select + claude mode select)
    const claudeSelects = w.findAll('select.sf-select')
    expect(claudeSelects).toHaveLength(2)

    // 切到 codex → 两个 segmented 组可见
    await vendorSelect.setValue('codex')
    const codexSegs = w.findAll('.sf-segmented')
    // task type + trigger + codex sandbox + codex approval = 4
    expect(codexSegs).toHaveLength(4)
  })
})

// ---- Modal width / tool-list height style contract -----------------------

// happy-dom 不计算布局,样式契约直接对组件源码里的 CSS 规则做断言。
const componentSrc = readFileSync(
  resolve(process.cwd(), 'web/src/pages/automations/components/AutomationForm/AutomationForm.vue'),
  'utf8',
)

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

// 抽取移动端全屏断点内部,再在其中定位选择器(桌面/移动同名规则需分区匹配)。
function mobileBlock(css: string): string {
  return /@media \(max-width: 767px\) \{([\s\S]*)\}\s*<\/style>/.exec(css)?.[1] ?? ''
}

describe('AutomationForm.vue — 弹窗宽度 / 工具区高度样式契约', () => {
  it('桌面 .sf-modal 宽度为 min(1080px, 100%)(720px 的 1.5 倍)', () => {
    expect(ruleBody(componentSrc, '.sf-modal')).toMatch(/width:\s*min\(1080px,\s*100%\)/)
  })

  it('移动端全屏断点仍把 .sf-modal 覆盖为 100vw/100dvh', () => {
    const mobile = mobileBlock(componentSrc)
    expect(mobile).not.toBe('')
    const modal = ruleBody(mobile, '.sf-modal')
    expect(modal).toMatch(/width:\s*100vw/)
    expect(modal).toMatch(/height:\s*100dvh/)
  })

  it('工具区无固定高度/强制拉伸:.sf-tools-scroll / .sf-tools-group / .sf-tools-grid 高度随内容', () => {
    for (const sel of ['.sf-tools-scroll', '.sf-tools-group', '.sf-tools-grid']) {
      const block = ruleBody(componentSrc, sel)
      expect(block).not.toMatch(/(?:^|[;{])\s*height:/)
      expect(block).not.toMatch(/min-height:/)
      expect(block).not.toMatch(/max-height:/)
      expect(block).not.toMatch(/flex(?:-grow)?:\s*[1-9]/)
    }
  })

  it('工具网格用 auto-fit 折叠空轨道,避免少量工具时的右侧空白', () => {
    expect(ruleBody(componentSrc, '.sf-tools-grid')).toMatch(
      /grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(240px,\s*1fr\)\)/,
    )
  })

  it('少量工具与多行工具两种 manifest 都完整渲染读写两组与全部工具项', () => {
    const few = mountForm({ toolManifest: { claude: ALL_TOOLS } })
    expect(few.findAll('.sf-tools-subtitle')).toHaveLength(2)
    expect(few.find('.sf-tools-scroll').exists()).toBe(true)
    expect(few.findAll('.sf-tools-grid')).toHaveLength(2)
    expect(few.findAll('.sf-tool-item')).toHaveLength(ALL_TOOLS.length)

    const manyRead: ToolManifestEntry[] = Array.from({ length: 9 }, (_, i) => ({
      name: `Read${i}`,
      isWrite: false,
    }))
    const manyWrite: ToolManifestEntry[] = Array.from({ length: 8 }, (_, i) => ({
      name: `Write${i}`,
      isWrite: true,
    }))
    const many = mountForm({ toolManifest: { claude: [...manyRead, ...manyWrite] } })
    expect(many.findAll('.sf-tools-subtitle')).toHaveLength(2)
    expect(many.findAll('.sf-tool-item')).toHaveLength(manyRead.length + manyWrite.length)
  })
})
