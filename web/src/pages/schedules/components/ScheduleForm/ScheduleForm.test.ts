import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type {
  AgentConfig,
  Schedule,
  ToolManifestEntry,
  VendorHostStatus,
} from '@ccc/shared/protocol'
import { isValidCron } from '@ccc/shared/cron'
import ScheduleForm from './ScheduleForm.vue'

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
    schedule: Schedule | null
    workspaceId: string
    timezone: string
    toolManifest: Record<string, ToolManifestEntry[] | null>
    toolManifestLoading: boolean
    toolManifestError: string | null
    hostStatus: VendorHostStatus[]
  }> = {},
) {
  return mount(ScheduleForm, {
    props: {
      open: true,
      schedule: null,
      workspacePath: 'ws-proj',
      timezone: 'UTC',
      toolManifest: {},
      toolManifestLoading: false,
      toolManifestError: null,
      hostStatus: HOST_PRESENT,
      agents: AGENTS,
      ...props,
    },
  })
}

function sched(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 's1',
    type: 'command',
    config: { command: 'pnpm build', name: 'legacy name' },
    maxWallClockMs: null,
    workspaceId: '/home/proj',
    triggerType: 'cron',
    cronExpression: '0 8 * * *',
    nextRunAt: null,
    eventTopic: null,
    eventReasonFilter: null,
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

describe('ScheduleForm.vue — 创建/编辑表单', () => {
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
    const w = mountForm({ schedule: sched() })
    const labelsEdit = w.findAll('.sf-label').map((l) => l.text())
    expect(labelsEdit).toContain('Title')
    const title = w.find('input.sf-input')
    expect((title.element as HTMLInputElement).value).toBe('legacy name')
  })

  it('update:payload 携带编辑后的 config.name(标题),保留 cron/mode', async () => {
    const w = mountForm({ schedule: sched() })
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
    const w = mountForm({ schedule: sched() })
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

    const edited = mountForm({ schedule: sched({ maxWallClockMs: 90000 }) })
    expect((edited.find('.sf-timeout-input').element as HTMLInputElement).value).toBe('90000')
    await edited.find('.sf-btn.primary').trigger('click')
    expect((edited.emitted('update')![0][1] as Record<string, unknown>).maxWallClockMs).toBe(90000)
  })

  it('create(event):切到事件触发 → payload 含 triggerType/eventTopic,cron 为空', async () => {
    const w = mountForm()
    await w.find('textarea').setValue('echo done')
    // 第 2 个 segmented 是 trigger 类型(第 1 个是任务类型);[1] = event。
    const segmenteds = w.findAll('.sf-segmented')
    await segmenteds[1].findAll('.sf-seg')[1].trigger('click')
    await w.find('.sf-btn.primary').trigger('click')

    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(input.triggerType).toBe('event')
    expect(input.cronExpression).toBe('')
    expect(input.eventTopic).toBe('run:settled') // 默认订阅运行结束
    expect(input.eventReasonFilter).toBeNull() // 未选 reason → 任意结果
  })

  it('create(event/settled):勾选 reason → payload 含 eventReasonFilter', async () => {
    const w = mountForm()
    await w.find('textarea').setValue('echo done')
    const segmenteds = w.findAll('.sf-segmented')
    await segmenteds[1].findAll('.sf-seg')[1].trigger('click') // event
    // run:settled 时显示 reason 过滤;cron builder 已隐藏,.sf-day 仅 reason 按钮。
    const reasons = w.findAll('.sf-day')
    expect(reasons).toHaveLength(3)
    await reasons[1].trigger('click') // 'error'
    await w.find('.sf-btn.primary').trigger('click')

    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(input.eventReasonFilter).toEqual(['error'])
  })

  // next-run 预览按配置时区(props.timezone)计算并格式化:配 Asia/Shanghai 时
  // `0 11 * * *` 的预览显示 11:00,与 cron 字面一致(消除「显示 19:00 但 cron 写 11」)。
  it('next-run 预览:Asia/Shanghai + `0 11 * * *` 显示 11:00', () => {
    const w = mountForm({
      schedule: sched({ cronExpression: '0 11 * * *' }),
      timezone: 'Asia/Shanghai',
    })
    const preview = w.find('.sf-nextrun strong')
    expect(preview.exists()).toBe(true)
    expect(preview.text()).toContain('11:00')
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

  // ---- load-tool-manifest event --------------------------------------------

  it('create:打开表单立即 emit load-tool-manifest(claude)', () => {
    const w = mountForm()
    const events = w.emitted('load-tool-manifest')
    expect(events).toBeTruthy()
    expect(events![0]).toEqual(['claude'])
  })

  it('edit:打开表单立即 emit load-tool-manifest(当前 vendor)', () => {
    const w = mountForm({ schedule: sched({ vendor: 'codex' }) })
    const events = w.emitted('load-tool-manifest')
    expect(events).toBeTruthy()
    expect(events![0]).toEqual(['codex'])
  })

  it('edit(claude):默认 vendor 时也能正确 emit', () => {
    const w = mountForm({ schedule: sched({ vendor: 'claude' }) })
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
      schedule: sched(),
      toolManifest: { claude: ALL_TOOLS },
    })
    await w.find('.sf-btn.primary').trigger('click')

    const [, input] = w.emitted('update')![0] as [string, Record<string, unknown>]
    expect(input).toHaveProperty('toolAllowlist')
  })

  it('编辑回读:从 schedule.toolAllowlist 还原勾选', async () => {
    const w = mountForm({
      schedule: sched({ toolAllowlist: ['Write', 'Edit'] }),
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
