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
    props: { automation, toolManifest, agents: AGENTS },
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

  it('事件触发展示通用事件类型及状态筛选', () => {
    const w = mountDetail(
      sched({
        triggerType: 'event',
        cronExpression: '',
        eventFilter: { type: 'run:settled', statuses: ['complete', 'error'] },
        eventSessionKindFilter: ['work'],
      }),
    )
    // The generic detail renders the raw event type + its status list verbatim.
    expect(w.text()).toContain('run:settled')
    expect(w.text()).toContain('complete · error')
  })

  it('PR 事件触发展示类型、状态及 metadata 条件', () => {
    const w = mountDetail(
      sched({
        triggerType: 'event',
        cronExpression: '',
        eventFilter: {
          type: 'pr:operation',
          statuses: ['failure'],
          metadata: {
            conditions: [
              { key: 'operation', value: 'merge' },
              { key: 'operation', value: 'comment' },
            ],
            combinator: 'OR',
          },
        },
      }),
    )
    expect(w.text()).toContain('pr:operation')
    expect(w.text()).toContain('failure')
    // Metadata conditions render as key=value joined by the OR combinator label.
    expect(w.text()).toContain('operation=merge')
    expect(w.text()).toContain('operation=comment')
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
