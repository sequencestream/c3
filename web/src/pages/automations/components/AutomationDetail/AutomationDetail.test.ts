import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { AgentConfig, Automation, ToolManifestEntry } from '@ccc/shared/protocol'
import { VENDOR_LABEL, VENDOR_COLOR } from '@/lib/vendor'
import AutomationDetail from './AutomationDetail.vue'

function sched(over: Partial<Automation> = {}): Automation {
  return {
    id: 's1',
    type: 'command',
    config: { command: 'pnpm build', name: 'Build' },
    maxWallClockMs: null,
    workspaceId: '/home/proj',
    triggerType: 'cron',
    cronExpression: '0 8 * * *',
    nextRunAt: null,
    eventTopic: null,
    eventReasonFilter: null,
    eventPrFilter: null,
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

function makeManifest(): ToolManifestEntry[] {
  return [
    { name: 'read-file', isWrite: false },
    { name: 'search-code', isWrite: false },
    { name: 'write-file', isWrite: true },
    { name: 'execute-command', isWrite: true },
  ]
}

const AGENTS: AgentConfig[] = [
  {
    id: 'agent-1',
    displayName: 'Planner',
    vendor: 'claude',
    configMode: 'system',
    config: { baseUrl: '', apiKey: '', model: '' },
    enabled: true,
  },
  {
    id: 'agent-2',
    displayName: 'Reviewer',
    vendor: 'codex',
    configMode: 'custom',
    config: { baseUrl: '', apiKey: '', model: '', wireApi: 'responses' },
    enabled: true,
  },
]

function mountDetail(
  automation: Automation | null,
  toolManifest: Record<string, ToolManifestEntry[] | null> = {},
) {
  return mount(AutomationDetail, {
    props: { automation, toolManifest, agents: AGENTS, simulationResult: null },
  })
}

describe('AutomationDetail.vue — 右栏 automation 详情', () => {
  it('显示 vendor 色点 + 品牌名', () => {
    const w = mountDetail(sched({ vendor: 'codex' }))
    const dot = w.find('.vendor-dot')
    expect(dot.exists()).toBe(true)
    expect(dot.attributes('style')).toContain(VENDOR_COLOR.codex)
    expect(w.text()).toContain(VENDOR_LABEL.codex)
  })

  it('显示绑定 agent 的展示名', () => {
    const w = mountDetail(sched({ type: 'llm', agentId: 'agent-1' }))
    expect(w.text()).toContain('Agent')
    expect(w.text()).toContain('Planner')
  })

  it('未知 agent 回退显示 agentId', () => {
    const w = mountDetail(sched({ type: 'llm', agentId: 'missing-agent' }))
    expect(w.text()).toContain('missing-agent')
  })

  it('显示 mode 原始值（不再走 i18n；remove-exec Identity 后旧 mcpMode key 已移除）', () => {
    const w = mountDetail(sched({ mode: 'read-only' }))
    expect(w.text()).toContain('read-only')
  })

  it('显示类型、命令和超时时间', () => {
    const w = mountDetail(sched({ maxWallClockMs: 120_000 }))
    expect(w.text()).toContain('Task type')
    expect(w.text()).toContain('Command')
    expect(w.text()).toContain('pnpm build')
    expect(w.text()).toContain('120000 ms')
  })

  it('LLM 任务显示提示词，未设置超时时间时显示默认值', () => {
    const w = mountDetail(
      sched({
        type: 'llm',
        config: { prompt: 'Summarize the release notes' },
        maxWallClockMs: null,
      }),
    )
    expect(w.text()).toContain('LLM prompt')
    expect(w.text()).toContain('Summarize the release notes')
    expect(w.text()).toContain('Use task default')
  })

  it('cron 排期只读显示表达式和可读频率', () => {
    const w = mountDetail(sched({ cronExpression: '0 */1 * * *' }))
    expect(w.find('.sd-cron').text()).toBe('0 */1 * * *')
    expect(w.find('.sd-cron-description').text()).toBe('Every 1 hours')
    expect(w.find('.sd-cron-edit').exists()).toBe(false)
    expect(w.find('[role="dialog"]').exists()).toBe(false)
  })

  it('事件触发任务不显示 cron 排期编辑器', () => {
    const w = mountDetail(sched({ triggerType: 'event', cronExpression: '' }))
    expect(w.find('.sd-row--automation').exists()).toBe(false)
  })

  it('事件触发展示主题及运行结果筛选', () => {
    const w = mountDetail(
      sched({
        triggerType: 'event',
        cronExpression: '',
        eventTopic: 'run:settled',
        eventReasonFilter: ['complete', 'error'],
      }),
    )
    expect(w.text()).toContain('On a run event')
    expect(w.text()).toContain('Run finished')
    expect(w.text()).toContain('Completed · Error')
  })

  it('PR 事件触发展示操作和结果筛选', () => {
    const w = mountDetail(
      sched({
        triggerType: 'event',
        cronExpression: '',
        eventTopic: 'pr:operation',
        eventPrFilter: { operations: ['merge', 'comment'], results: ['failure'] },
      }),
    )
    expect(w.text()).toContain('PR operation')
    expect(w.text()).toContain('Merge · Comment')
    expect(w.text()).toContain('Failure')
  })

  it('空 toolAllowlist 显示 "All tools unrestricted"', () => {
    const w = mountDetail(sched({ toolAllowlist: [] }))
    expect(w.text()).toContain('All tools unrestricted')
  })

  it('工具在同一可换行列表中显示', () => {
    const s = sched({
      toolAllowlist: ['read-file', 'write-file', 'search-code'],
    })
    const w = mountDetail(s, { claude: makeManifest() })

    const items = w.findAll('[data-testid="sd-tool-item"]')
    expect(items).toHaveLength(3)
    expect(items.map((item) => item.text())).toEqual(['read-file', 'write-file', 'search-code'])
    expect(w.find('.sd-tool-list').classes()).toContain('sd-tool-list')
  })

  it('无 manifest 缓存时展示原始工具列表', () => {
    const s = sched({
      toolAllowlist: ['read-file', 'write-file'],
    })
    // 空 toolManifest → vendor 的 manifest 不存在,回退到未分类列表
    const w = mountDetail(s, {})
    const rawItems = w.findAll('[data-testid="sd-tool-item"]')
    expect(rawItems).toHaveLength(2)
    expect(rawItems[0].text()).toBe('read-file')
    expect(rawItems[1].text()).toBe('write-file')
  })

  it('automation=null 时隐藏', () => {
    const w = mountDetail(null)
    expect(w.find('.sched-detail-wrap').exists()).toBe(false)
  })
})

describe('AutomationDetail.vue — 模拟触发面板', () => {
  function eventSched(over: Partial<Automation> = {}): Automation {
    return sched({
      triggerType: 'event',
      cronExpression: '',
      eventTopic: 'run:settled',
      eventSessionKindFilter: ['work'],
      metadata: { stage: 'a' },
      ...over,
    })
  }

  function mountWith(
    automation: Automation | null,
    simulationResult: {
      automationId: string
      matched: boolean
      breakdown: { name: string; passed: boolean }[]
    } | null,
  ) {
    return mount(AutomationDetail, {
      props: { automation, toolManifest: {}, agents: AGENTS, simulationResult },
    })
  }

  it('cron automation 不显示模拟触发面板', () => {
    const w = mountWith(sched(), null)
    expect(w.find('[data-testid="automation-simulate"]').exists()).toBe(false)
  })

  it('event automation 点击测试 emit simulate,payload 按 topic 取字段', async () => {
    const w = mountWith(eventSched(), null)
    expect(w.find('[data-testid="automation-simulate"]').exists()).toBe(true)
    await w.find('[data-testid="automation-simulate-run"]').trigger('click')
    const payload = w.emitted('simulate')![0][0] as Record<string, unknown>
    expect(payload.automationId).toBe('s1')
    expect(payload.topic).toBe('run:settled')
    expect(payload.sessionKind).toBe('work')
    expect(payload.reason).toBe('complete')
  })

  it('渲染命中结果与逐项 breakdown', () => {
    const w = mountWith(eventSched(), {
      automationId: 's1',
      matched: true,
      breakdown: [
        { name: 'topic', passed: true },
        { name: 'sessionKind', passed: true },
        { name: 'metadata', passed: false },
      ],
    })
    const verdict = w.find('[data-testid="automation-simulate-verdict"]')
    expect(verdict.exists()).toBe(true)
    const dims = w.findAll('.sd-sim-dim')
    expect(dims).toHaveLength(3)
    expect(dims[2].classes()).not.toContain('pass')
  })

  it('丢弃属于其他 automation 的过期结果', () => {
    const w = mountWith(eventSched(), {
      automationId: 'other',
      matched: true,
      breakdown: [{ name: 'topic', passed: true }],
    })
    expect(w.find('[data-testid="automation-simulate-result"]').exists()).toBe(false)
  })
})
