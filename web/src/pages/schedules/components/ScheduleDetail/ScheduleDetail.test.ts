import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Schedule, ToolManifestEntry } from '@ccc/shared/protocol'
import { VENDOR_LABEL, VENDOR_COLOR } from '@/lib/vendor'
import ScheduleDetail from './ScheduleDetail.vue'

function sched(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 's1',
    type: 'command',
    config: { command: 'pnpm build', name: 'Build' },
    workspacePath: '/home/proj',
    triggerType: 'cron',
    cronExpression: '0 8 * * *',
    nextRunAt: null,
    eventTopic: null,
    eventReasonFilter: null,
    status: 'active',
    mcpMode: 'sandboxed',
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

function mountDetail(
  schedule: Schedule | null,
  toolManifest: Record<string, ToolManifestEntry[] | null> = {},
) {
  return mount(ScheduleDetail, {
    props: { schedule, toolManifest },
  })
}

describe('ScheduleDetail.vue — 右栏 schedule 详情', () => {
  it('显示 vendor 色点 + 品牌名', () => {
    const w = mountDetail(sched({ vendor: 'codex' }))
    const dot = w.find('.vendor-dot')
    expect(dot.exists()).toBe(true)
    expect(dot.attributes('style')).toContain(VENDOR_COLOR.codex)
    expect(w.text()).toContain(VENDOR_LABEL.codex)
  })

  it('显示 mcpMode i18n 标签(非原始协议值)', () => {
    const w = mountDetail(sched({ mcpMode: 'read-only' }))
    expect(w.text()).toContain('Read-only')
  })

  it('空 toolAllowlist 显示 "All tools unrestricted"', () => {
    const w = mountDetail(sched({ toolAllowlist: [] }))
    expect(w.text()).toContain('All tools unrestricted')
  })

  it('有 manifest 时将工具分类为读/写两组', () => {
    const s = sched({
      toolAllowlist: ['read-file', 'write-file', 'search-code'],
    })
    const w = mountDetail(s, { claude: makeManifest() })

    // 读组:2 个只读工具
    const roItems = w.findAll('[data-testid^="sd-tool-ro-"]')
    expect(roItems).toHaveLength(2)
    expect(roItems[0].text()).toBe('read-file')
    expect(roItems[1].text()).toBe('search-code')

    // 写组:1 个写入工具
    const wItems = w.findAll('[data-testid^="sd-tool-w-"]')
    expect(wItems).toHaveLength(1)
    expect(wItems[0].text()).toBe('write-file')
  })

  it('无 manifest 缓存时展示原始工具列表', () => {
    const s = sched({
      toolAllowlist: ['read-file', 'write-file'],
    })
    // 空 toolManifest → vendor 的 manifest 不存在,回退到未分类列表
    const w = mountDetail(s, {})
    const rawItems = w.findAll('[data-testid="sd-tool-unclassified"]')
    expect(rawItems).toHaveLength(2)
    expect(rawItems[0].text()).toBe('read-file')
    expect(rawItems[1].text()).toBe('write-file')
  })

  it('schedule=null 时隐藏', () => {
    const w = mountDetail(null)
    expect(w.find('.sched-detail-wrap').exists()).toBe(false)
  })
})
