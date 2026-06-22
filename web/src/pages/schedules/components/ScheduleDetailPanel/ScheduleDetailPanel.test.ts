import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Schedule, ScheduleExecutionLog } from '@ccc/shared/protocol'
import ScheduleDetailPanel from './ScheduleDetailPanel.vue'

function sched(over: Partial<Schedule> = {}): Schedule {
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

function execLog(over: Partial<ScheduleExecutionLog> = {}): ScheduleExecutionLog {
  return {
    id: 'e1',
    scheduleId: 's1',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    exitCode: 0,
    output: 'done',
    error: null,
    status: 'success',
    sessionId: null,
    ...over,
  }
}

// Stub the inner detail panes (heavy deps) — this test covers the container's
// title bar / tabs / history-dialog wiring, not the inner renderers.
const STUBS = { ScheduleDetail: true, ExecutionDetail: true }

function mountPanel(over: Record<string, unknown> = {}) {
  return mount(ScheduleDetailPanel, {
    props: {
      schedule: sched(),
      toolManifest: {},
      logs: [],
      executionId: null,
      execution: null,
      transcripts: {},
      ...over,
    },
    global: { stubs: STUBS },
  })
}

describe('ScheduleDetailPanel.vue — 右栏容器', () => {
  it('无选中 schedule 时渲染空态', () => {
    const w = mountPanel({ schedule: null })
    expect(w.find('[data-testid="schedule-detail-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="schedule-panel-actions"]').exists()).toBe(false)
  })

  it('标题栏显示选中 schedule 名称', () => {
    const w = mountPanel({ schedule: sched({ config: { command: 'x', name: 'Nightly' } }) })
    expect(w.find('.sched-panel-title').text()).toBe('Nightly')
  })

  it('无 name 时标题回退到 cron 表达式', () => {
    const w = mountPanel({
      schedule: sched({ config: { command: 'x' }, cronExpression: '0 9 * * *' }),
    })
    expect(w.find('.sched-panel-title').text()).toBe('0 9 * * *')
  })

  describe('标题栏操作(迁移自列表行)', () => {
    it('run-now 作用于当前选中 schedule', async () => {
      const w = mountPanel({ schedule: sched({ id: 'sx', status: 'active' }) })
      await w.find('.sp-action--run').trigger('click')
      expect(w.emitted('run-now')?.[0]).toEqual(['sx'])
    })

    it('run-now 在 paused 时可用', async () => {
      const w = mountPanel({ schedule: sched({ status: 'paused' }) })
      const button = w.find('.sp-action--run')
      expect(button.attributes('disabled')).toBeUndefined()
      await button.trigger('click')
      expect(w.emitted('run-now')?.[0]).toEqual(['s1'])
    })

    it('run-now 在 archived 时禁用', () => {
      const w = mountPanel({ schedule: sched({ status: 'archived' }) })
      expect(w.find('.sp-action--run').attributes('disabled')).toBeDefined()
    })

    it('edit emit edit-schedule(携带 schedule)', async () => {
      const s = sched({ id: 'sx' })
      const w = mountPanel({ schedule: s })
      await w.find('.sp-action:not(.sp-action--run):not(.sp-action--delete)').trigger('click')
      expect(w.emitted('edit-schedule')?.[0]).toEqual([s])
    })

    it('toggle emit toggle-enabled:active→false', async () => {
      const w = mountPanel({ schedule: sched({ id: 'sx', status: 'active' }) })
      await w.find('.sp-toggle').trigger('click')
      expect(w.emitted('toggle-enabled')?.[0]).toEqual(['sx', false])
    })

    it('toggle emit toggle-enabled:paused→true', async () => {
      const w = mountPanel({ schedule: sched({ id: 'sx', status: 'paused' }) })
      await w.find('.sp-toggle').trigger('click')
      expect(w.emitted('toggle-enabled')?.[0]).toEqual(['sx', true])
    })

    it('delete 经 ConfirmDialog 二次确认后才 emit delete-schedule', async () => {
      const w = mountPanel({
        schedule: sched({ id: 'sx', config: { command: 'x', name: 'Nightly' } }),
      })
      expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(false)

      await w.find('.sp-action--delete').trigger('click')
      const overlay = w.find('[data-testid="confirm-overlay"]')
      expect(overlay.exists()).toBe(true)
      expect(overlay.text()).toContain('Nightly')
      expect(w.emitted('delete-schedule')).toBeUndefined()

      await w.find('[data-testid="confirm-accept"]').trigger('click')
      expect(w.emitted('delete-schedule')?.[0]).toEqual(['sx'])
      expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(false)
    })

    it('delete 取消则不 emit', async () => {
      const w = mountPanel()
      await w.find('.sp-action--delete').trigger('click')
      await w.find('[data-testid="confirm-cancel"]').trigger('click')
      expect(w.emitted('delete-schedule')).toBeUndefined()
    })
  })

  describe('详情 / 历史 Tab', () => {
    it('默认渲染详情 Tab(ScheduleDetail)', () => {
      const w = mountPanel()
      const tabs = w.findAll('.sched-panel-tab')
      expect(tabs[0].classes()).toContain('active')
      expect(w.findComponent({ name: 'ScheduleDetail' }).exists()).toBe(true)
    })

    it('切到历史 Tab:无执行记录时显示提示,不渲染 ExecutionDetail', async () => {
      const w = mountPanel()
      await w.findAll('.sched-panel-tab')[1].trigger('click')
      expect(w.find('.sched-history-empty').exists()).toBe(true)
      expect(w.findComponent({ name: 'ExecutionDetail' }).exists()).toBe(false)
    })

    it('切到历史 Tab 时自动选择最近一笔执行', async () => {
      const latest = execLog({ id: 'latest', startedAt: 1_700_000_002_000 })
      const older = execLog({ id: 'older', startedAt: 1_700_000_001_000 })
      const w = mountPanel({ logs: [latest, older] })

      await w.findAll('.sched-panel-tab')[1].trigger('click')

      expect(w.emitted('select-execution')).toEqual([['latest']])
    })

    it('历史 Tab 已打开时，日志到达后自动选择最近一笔执行', async () => {
      const w = mountPanel()
      await w.findAll('.sched-panel-tab')[1].trigger('click')
      expect(w.emitted('select-execution')).toBeUndefined()

      await w.setProps({ logs: [execLog({ id: 'latest' })] })

      expect(w.emitted('select-execution')).toEqual([['latest']])
    })

    it('历史 Tab 已有选择时不覆盖用户选择', async () => {
      const w = mountPanel({
        logs: [execLog({ id: 'latest' }), execLog({ id: 'selected' })],
        executionId: 'selected',
        execution: execLog({ id: 'selected' }),
      })

      await w.findAll('.sched-panel-tab')[1].trigger('click')

      expect(w.emitted('select-execution')).toBeUndefined()
    })

    it('历史 Tab 选中执行时渲染 ExecutionDetail', async () => {
      const w = mountPanel({ executionId: 'e1', execution: execLog() })
      await w.findAll('.sched-panel-tab')[1].trigger('click')
      expect(w.findComponent({ name: 'ExecutionDetail' }).exists()).toBe(true)
      expect(w.find('.sched-history-empty').exists()).toBe(false)
    })

    it('历史栏显示当前选中执行的 ID 和开始时间，并随选择切换', async () => {
      const first = execLog({ id: 'first-execution', startedAt: 1_700_000_000_000 })
      const second = execLog({ id: 'second-execution', startedAt: 1_700_000_002_000 })
      const w = mountPanel({ executionId: first.id, execution: first })
      await w.findAll('.sched-panel-tab')[1].trigger('click')

      const summary = () => w.find('[data-testid="history-selected-execution"]')
      expect(summary().text()).toContain(first.id)
      expect(summary().text()).toContain('2023')

      await w.setProps({ executionId: second.id, execution: second })
      expect(summary().text()).toContain(second.id)
      expect(summary().text()).not.toContain(first.id)
    })

    it('切换选中 schedule 后复位到详情 Tab', async () => {
      const w = mountPanel({ executionId: 'e1', execution: execLog() })
      await w.findAll('.sched-panel-tab')[1].trigger('click')
      expect(w.findAll('.sched-panel-tab')[1].classes()).toContain('active')

      await w.setProps({ schedule: sched({ id: 's2' }) })
      expect(w.findAll('.sched-panel-tab')[0].classes()).toContain('active')
    })
  })

  describe('历史选择弹框', () => {
    it('历史 Tab 的 Browse 按钮打开弹框', async () => {
      const w = mountPanel({ logs: [execLog()] })
      await w.findAll('.sched-panel-tab')[1].trigger('click')
      expect(w.find('[data-testid="history-dialog-overlay"]').exists()).toBe(false)

      await w.find('[data-testid="history-browse"]').trigger('click')
      expect(w.find('[data-testid="history-dialog-overlay"]').exists()).toBe(true)
    })

    it('弹框选一笔执行 emit select-execution 并关闭弹框', async () => {
      const w = mountPanel({ logs: [execLog({ id: 'ex' })] })
      await w.findAll('.sched-panel-tab')[1].trigger('click')
      await w.find('[data-testid="history-browse"]').trigger('click')
      await w.find('[data-testid="history-dialog-item"]').trigger('click')

      expect(w.emitted('select-execution')?.[0]).toEqual(['ex'])
      expect(w.find('[data-testid="history-dialog-overlay"]').exists()).toBe(false)
    })
  })
})
