import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ScheduleExecutionLog } from '@ccc/shared/protocol'
import ExecutionHistoryDialog from './ExecutionHistoryDialog.vue'

function log(over: Partial<ScheduleExecutionLog> = {}): ScheduleExecutionLog {
  return {
    id: 'e1',
    scheduleId: 's1',
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_000,
    exitCode: 0,
    output: '',
    error: null,
    status: 'success',
    sessionId: null,
    ...over,
  }
}

// N logs, newest first (server sorts started_at DESC); id = e0..e{N-1}.
function logs(n: number): ScheduleExecutionLog[] {
  return Array.from({ length: n }, (_, i) =>
    log({ id: `e${i}`, startedAt: 1_700_000_000_000 - i * 1000 }),
  )
}

function mountDialog(over: Record<string, unknown> = {}) {
  return mount(ExecutionHistoryDialog, {
    props: { open: true, logs: logs(12), activeExecutionId: null, ...over },
  })
}

describe('ExecutionHistoryDialog.vue — 历史选择弹框', () => {
  it('open=false 时不渲染', () => {
    const w = mountDialog({ open: false })
    expect(w.find('[data-testid="history-dialog-overlay"]').exists()).toBe(false)
  })

  it('默认显示最近 5 笔(首页),页码 1 / 3', () => {
    const w = mountDialog()
    const items = w.findAll('[data-testid="history-dialog-item"]')
    expect(items).toHaveLength(5)
    // 首页是日志数组前 5 笔(最近)。
    expect(items[0].text()).toContain('success')
    expect(w.find('[data-testid="history-dialog-page"]').text()).toContain('1 / 3')
  })

  it('下一页翻到后续记录,末页禁用 next', async () => {
    const w = mountDialog()
    const buttons = () => w.findAll('.ehd-page-btn')
    // [prev, next]; 首页 prev 禁用。
    expect(buttons()[0].attributes('disabled')).toBeDefined()

    await buttons()[1].trigger('click')
    expect(w.find('[data-testid="history-dialog-page"]').text()).toContain('2 / 3')
    expect(w.findAll('[data-testid="history-dialog-item"]')).toHaveLength(5)

    await buttons()[1].trigger('click')
    expect(w.find('[data-testid="history-dialog-page"]').text()).toContain('3 / 3')
    // 末页 2 笔,next 禁用。
    expect(w.findAll('[data-testid="history-dialog-item"]')).toHaveLength(2)
    expect(buttons()[1].attributes('disabled')).toBeDefined()
  })

  it('上一页回到前一页', async () => {
    const w = mountDialog()
    const buttons = () => w.findAll('.ehd-page-btn')
    await buttons()[1].trigger('click') // → 页2
    await buttons()[0].trigger('click') // ← 页1
    expect(w.find('[data-testid="history-dialog-page"]').text()).toContain('1 / 3')
  })

  it('点选一笔 emit select-execution(携带 id)并 emit close', async () => {
    const w = mountDialog()
    await w.findAll('[data-testid="history-dialog-item"]')[0].trigger('click')
    expect(w.emitted('select-execution')?.[0]).toEqual(['e0'])
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('翻页后选择翻到的那一页的记录', async () => {
    const w = mountDialog()
    await w.findAll('.ehd-page-btn')[1].trigger('click') // 页2: e5..e9
    await w.findAll('[data-testid="history-dialog-item"]')[0].trigger('click')
    expect(w.emitted('select-execution')?.[0]).toEqual(['e5'])
  })

  it('重新打开时复位到首页', async () => {
    const w = mountDialog()
    await w.findAll('.ehd-page-btn')[1].trigger('click') // 页2
    expect(w.find('[data-testid="history-dialog-page"]').text()).toContain('2 / 3')

    await w.setProps({ open: false })
    await w.setProps({ open: true })
    expect(w.find('[data-testid="history-dialog-page"]').text()).toContain('1 / 3')
  })

  it('无日志时显示空态、无分页项', () => {
    const w = mountDialog({ logs: [] })
    expect(w.find('.ehd-empty').exists()).toBe(true)
    expect(w.findAll('[data-testid="history-dialog-item"]')).toHaveLength(0)
    expect(w.find('.ehd-pager').exists()).toBe(false)
  })

  it('点遮罩 emit close', async () => {
    const w = mountDialog()
    await w.find('[data-testid="history-dialog-overlay"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(1)
  })
})
