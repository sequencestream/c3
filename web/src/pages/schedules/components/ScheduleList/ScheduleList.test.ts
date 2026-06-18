import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Schedule } from '@ccc/shared/protocol'
import { VENDOR_LABEL, VENDOR_COLOR } from '@/lib/vendor'
import ScheduleList from './ScheduleList.vue'

function sched(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 's1',
    type: 'command',
    config: { command: 'pnpm build', name: 'Build' },
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

function mountList(schedules: Schedule[], timezone = 'UTC') {
  return mount(ScheduleList, { props: { schedules, activeId: null, timezone } })
}

describe('ScheduleList.vue — 左栏列表交互', () => {
  it('点击行展开行内摘要,再次点击收起(accordion)', async () => {
    const w = mountList([sched({ id: 'a' })])
    const main = w.find('.sched-item-main')
    expect(w.find('.sched-detail-inline').exists()).toBe(false)

    await main.trigger('click')
    expect(w.find('.sched-detail-inline').exists()).toBe(true)

    await main.trigger('click')
    expect(w.find('.sched-detail-inline').exists()).toBe(false)
  })

  it('展开新行自动收起旧行(单开)', async () => {
    const w = mountList([sched({ id: 'a' }), sched({ id: 'b' })])
    const mains = w.findAll('.sched-item-main')

    await mains[0].trigger('click')
    expect(w.findAll('.sched-detail-inline')).toHaveLength(1)

    await mains[1].trigger('click')
    const open = w.findAll('.sched-detail-inline')
    expect(open).toHaveLength(1)
    // 展开的是第二行:其所在 item 的 main aria-expanded 为 true,首行为 false。
    expect(mains[0].attributes('aria-expanded')).toBe('false')
    expect(mains[1].attributes('aria-expanded')).toBe('true')
  })

  it('展开行同时 emit select(联动右栏)', async () => {
    const w = mountList([sched({ id: 'a' })])
    await w.find('.sched-item-main').trigger('click')
    expect(w.emitted('select')?.[0]).toEqual(['a'])
  })

  it('开关 emit toggle-enabled:active→false,paused→true', async () => {
    const w = mountList([
      sched({ id: 'a', status: 'active' }),
      sched({ id: 'b', status: 'paused' }),
    ])
    const toggles = w.findAll('.sched-toggle')

    await toggles[0].trigger('click')
    expect(w.emitted('toggle-enabled')?.[0]).toEqual(['a', false])

    await toggles[1].trigger('click')
    expect(w.emitted('toggle-enabled')?.[1]).toEqual(['b', true])
  })

  it('开关点击不触发行展开(stop propagation)', async () => {
    const w = mountList([sched({ id: 'a', status: 'active' })])
    await w.find('.sched-toggle').trigger('click')
    expect(w.find('.sched-detail-inline').exists()).toBe(false)
    expect(w.emitted('select')).toBeUndefined()
  })

  it('+ 号 emit new-schedule', async () => {
    const w = mountList([])
    await w.find('.sched-new-btn').trigger('click')
    expect(w.emitted('new-schedule')).toHaveLength(1)
  })

  describe('删除二次确认', () => {
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('确认后 emit delete-schedule(携带 id),且确认文案含任务名', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
      const w = mountList([sched({ id: 'a', config: { command: 'x', name: 'Nightly Build' } })])

      await w.find('.sched-delete-btn').trigger('click')

      expect(confirm).toHaveBeenCalledTimes(1)
      // 二次确认提示包含任务名,便于用户确认删除对象。
      expect(confirm.mock.calls[0][0]).toContain('Nightly Build')
      expect(w.emitted('delete-schedule')?.[0]).toEqual(['a'])
    })

    it('取消则不 emit(无副作用)', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false)
      const w = mountList([sched({ id: 'a' })])

      await w.find('.sched-delete-btn').trigger('click')

      expect(w.emitted('delete-schedule')).toBeUndefined()
    })

    it('删除按钮点击不触发行展开/select(stop propagation)', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false)
      const w = mountList([sched({ id: 'a' })])

      await w.find('.sched-delete-btn').trigger('click')

      expect(w.find('.sched-detail-inline').exists()).toBe(false)
      expect(w.emitted('select')).toBeUndefined()
    })
  })

  // 时区显示:upcoming runs 与固定时间戳均按配置时区(props.timezone)格式化,
  // 与 cron 计算口径一致,消除「显示 19:00 但 cron 写 11」的错位。
  // 例外:此处断言可见时间文本(而非 testid/结构),因为「按时区渲染」正是被测行为。
  describe('按配置时区显示', () => {
    it('upcoming runs:Asia/Shanghai + `0 11 * * *` 显示 11:00(cron 字面一致)', async () => {
      const w = mountList([sched({ id: 'a', cronExpression: '0 11 * * *' })], 'Asia/Shanghai')
      await w.find('.sched-item-main').trigger('click')
      const times = w.findAll('.sched-upcoming-time')
      expect(times.length).toBeGreaterThan(0)
      // 每个 upcoming 时刻在配置时区下都落在 11:00。
      for (const t of times) expect(t.text()).toContain('11:00')
    })

    it('同一固定时间戳随配置时区变化(证明格式化用 props.timezone,与机器时区无关)', async () => {
      // createdAt = 1_700_000_000_000 → 2023-11-14T22:13:20Z
      //   Asia/Shanghai(+08): 06:13   |   UTC: 22:13
      const sh = mountList([sched({ id: 'a' })], 'Asia/Shanghai')
      await sh.find('.sched-item-main').trigger('click')
      expect(sh.html()).toContain('06:13')
      expect(sh.html()).not.toContain('22:13')

      const utc = mountList([sched({ id: 'a' })], 'UTC')
      await utc.find('.sched-item-main').trigger('click')
      expect(utc.html()).toContain('22:13')
      expect(utc.html()).not.toContain('06:13')
    })
  })

  describe('vendor 与工具摘要', () => {
    it('展开后显示 vendor 色点 + 品牌名', async () => {
      const w = mountList([sched({ id: 'a', vendor: 'codex' })])
      await w.find('.sched-item-main').trigger('click')

      // vendor dot 存在且颜色正确
      const dot = w.find('.sched-detail-inline .vendor-dot')
      expect(dot.exists()).toBe(true)
      expect(dot.attributes('style')).toContain(VENDOR_COLOR.codex)

      // 品牌名出现
      expect(w.text()).toContain(VENDOR_LABEL.codex)
    })

    it('空 toolAllowlist 显示 "All tools unrestricted"', async () => {
      const w = mountList([sched({ id: 'a', toolAllowlist: [] })])
      await w.find('.sched-item-main').trigger('click')
      // 摘要是纯文本,通过全文检索确认文案出现
      const html = w.text()
      expect(html).toContain('All tools unrestricted')
    })

    it('非空 toolAllowlist 显示工具数量', async () => {
      const w = mountList([
        sched({ id: 'a', toolAllowlist: ['read-file', 'write-file', 'search-code'] }),
      ])
      await w.find('.sched-item-main').trigger('click')
      const html = w.text()
      expect(html).toContain('3 tools allowed')
    })
  })
})
