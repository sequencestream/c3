import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Automation } from '@ccc/shared/protocol'
import { isValidCron } from '@ccc/shared/cron'
import AutomationCronEditor from './AutomationCronEditor.vue'

function mountEditor(
  props: Partial<{ open: boolean; automation: Automation | null; cronExpression: string }> = {},
) {
  return mount(AutomationCronEditor, {
    props: { open: true, automation: null, ...props },
  })
}

const freqSelect = '.sce-body select.sce-input'

describe('AutomationCronEditor.vue — 修改时间弹框', () => {
  it('频率选 weekly 时展示周一到周日 7 个星期几选项', async () => {
    const w = mountEditor()
    expect(w.findAll('.sce-day')).toHaveLength(0)
    await w.find(freqSelect).setValue('weekly')
    expect(w.findAll('.sce-day')).toHaveLength(7)
  })

  it('支持多选不相邻的星期几,产出 day-of-week 为 2,6 且 cron 合法', async () => {
    const w = mountEditor()
    await w.find(freqSelect).setValue('weekly')
    // weekly 默认回填工作日 1-5;先全清避免干扰。
    const days = w.findAll('.sce-day')
    for (let i = 0; i < days.length; i++) {
      if (days[i].classes().includes('active')) await days[i].trigger('click')
    }
    await days[2].trigger('click') // Tue
    await days[6].trigger('click') // Sat
    await w.find('.sce-button--primary').trigger('click')

    const saved = w.emitted('save')![0][0] as string
    expect(saved.split(/\s+/)[4]).toBe('2,6')
    expect(isValidCron(saved)).toBe(true)
  })

  it('weekly 且未选任何星期几 → 保存禁用并显示校验提示;选中后恢复', async () => {
    const w = mountEditor()
    await w.find(freqSelect).setValue('weekly')
    // 清空所有默认选中。
    const days = w.findAll('.sce-day')
    for (let i = 0; i < days.length; i++) {
      if (days[i].classes().includes('active')) await days[i].trigger('click')
    }
    const saveBtn = w.find('.sce-button--primary')
    expect(saveBtn.attributes('disabled')).toBeDefined()
    expect(w.find('.sce-warn').exists()).toBe(true)
    // 点保存不发出 save。
    await saveBtn.trigger('click')
    expect(w.emitted('save')).toBeFalsy()

    await days[1].trigger('click') // Mon
    expect(saveBtn.attributes('disabled')).toBeUndefined()
    expect(w.find('.sce-warn').exists()).toBe(false)
  })

  it('回显:0 8 * * 2,6 → 周二与周六为选中态', () => {
    const w = mountEditor({ cronExpression: '0 8 * * 2,6' })
    const days = w.findAll('.sce-day')
    expect(days).toHaveLength(7)
    expect(days[2].classes()).toContain('active') // Tue
    expect(days[6].classes()).toContain('active') // Sat
    expect(days[1].classes()).not.toContain('active') // Mon
  })

  it('回显:区间 1-5 → 周一至周五选中', () => {
    const w = mountEditor({ cronExpression: '0 8 * * 1-5' })
    const days = w.findAll('.sce-day')
    expect(days[0].classes()).not.toContain('active') // Sun
    for (let n = 1; n <= 5; n++) expect(days[n].classes()).toContain('active')
    expect(days[6].classes()).not.toContain('active') // Sat
  })

  it('回显:weekly 但 day-of-week 解析为空时回填工作日默认值,避免一打开即不可保存', () => {
    // day-of-week 非 `*`(判为 weekly)但解析不出有效星期几时,回填 1-5。
    const w = mountEditor({ cronExpression: '0 8 * * 7' }) // 7 越界 → 解析为空
    const days = w.findAll('.sce-day')
    for (let n = 1; n <= 5; n++) expect(days[n].classes()).toContain('active')
    expect(days[0].classes()).not.toContain('active')
    expect(days[6].classes()).not.toContain('active')
  })

  it('提交:改星期几后确认,save 表达式携带修改后的 day-of-week', async () => {
    const w = mountEditor({ cronExpression: '0 8 * * 1-5' })
    const days = w.findAll('.sce-day')
    await days[6].trigger('click') // 追加 Sat → 1,2,3,4,5,6
    await days[0].trigger('click') // 追加 Sun → 全选
    await w.find('.sce-button--primary').trigger('click')

    const saved = w.emitted('save')![0][0] as string
    expect(saved.split(/\s+/)[4]).toBe('0,1,2,3,4,5,6')
    expect(isValidCron(saved)).toBe(true)
  })

  it('切到非 weekly(daily/hourly)频率,星期几选择不出现也不参与产出', async () => {
    const w = mountEditor({ cronExpression: '0 8 * * 2,6' })
    expect(w.findAll('.sce-day')).toHaveLength(7)
    await w.find(freqSelect).setValue('daily')
    expect(w.findAll('.sce-day')).toHaveLength(0)
    expect(w.find('.sce-warn').exists()).toBe(false)
    await w.find('.sce-button--primary').trigger('click')
    const saved = w.emitted('save')![0][0] as string
    expect(saved.split(/\s+/)[4]).toBe('*') // day-of-week 不参与
    expect(isValidCron(saved)).toBe(true)
  })
})

const winStart = '.sce-window-start'
const winEnd = '.sce-window-end'
const confirmBtn = '.sce-button--primary'

function selected(w: ReturnType<typeof mountEditor>, selector: string): string {
  return (w.find(selector).element as HTMLSelectElement).value
}

async function save(w: ReturnType<typeof mountEditor>): Promise<string | undefined> {
  await w.find(confirmBtn).trigger('click')
  return w.emitted('save')?.[0]?.[0] as string | undefined
}

describe('AutomationCronEditor.vue — 执行时段', () => {
  it('仅 minutely / hourly 展示时段控件;daily / weekly 不展示', async () => {
    const w = mountEditor({ cronExpression: '0 8 * * *' })
    expect(w.find(winStart).exists()).toBe(false)
    await w.find(freqSelect).setValue('minutely')
    expect(w.find(winStart).exists()).toBe(true)
    await w.find(freqSelect).setValue('weekly')
    expect(w.find(winStart).exists()).toBe(false)
  })

  it('默认全天:合成表达式与引入时段前逐字一致', async () => {
    const minutely = mountEditor({ cronExpression: '*/5 * * * *' })
    expect(selected(minutely, winStart)).toBe('0')
    expect(selected(minutely, winEnd)).toBe('24')
    expect(await save(minutely)).toBe('*/5 * * * *')

    const hourly = mountEditor({ cronExpression: '0 */2 * * *' })
    expect(selected(hourly, winStart)).toBe('0')
    expect(selected(hourly, winEnd)).toBe('24')
    expect(await save(hourly)).toBe('0 */2 * * *')
  })

  it('08:00–18:00:分钟频率与小时频率各自合成 hour 字段', async () => {
    const minutely = mountEditor({ cronExpression: '*/5 * * * *' })
    await minutely.find(winStart).setValue('8')
    await minutely.find(winEnd).setValue('18')
    expect(await save(minutely)).toBe('*/5 8-17 * * *')

    const hourly = mountEditor({ cronExpression: '0 */2 * * *' })
    await hourly.find(winStart).setValue('8')
    await hourly.find(winEnd).setValue('18')
    expect(await save(hourly)).toBe('0 8-17/2 * * *')
  })

  it('跨午夜 22:00–次日 08:00:两段各自步进,不出现错位', async () => {
    const minutely = mountEditor({ cronExpression: '*/5 * * * *' })
    await minutely.find(winStart).setValue('22')
    await minutely.find(winEnd).setValue('8')
    expect(await save(minutely)).toBe('*/5 22-23,0-7 * * *')

    const hourly = mountEditor({ cronExpression: '0 */2 * * *' })
    await hourly.find(winStart).setValue('22')
    await hourly.find(winEnd).setValue('8')
    expect(await save(hourly)).toBe('0 22-23/2,0-7/2 * * *')
  })

  it('小时频率间隔为 1 时省略 /1,与全天形态的 */1 区分', async () => {
    const w = mountEditor({ cronExpression: '0 */1 * * *' })
    await w.find(winStart).setValue('8')
    await w.find(winEnd).setValue('18')
    expect(await save(w)).toBe('0 8-17 * * *')
  })

  it('起 = 止 时禁用保存并提示;改回不等即恢复', async () => {
    const w = mountEditor({ cronExpression: '*/5 * * * *' })
    await w.find(winStart).setValue('8')
    await w.find(winEnd).setValue('8')
    expect(w.find(confirmBtn).attributes('disabled')).toBeDefined()
    expect(w.find('.sce-warn').exists()).toBe(true)
    expect(await save(w)).toBeUndefined()

    await w.find(winEnd).setValue('9')
    expect(w.find(confirmBtn).attributes('disabled')).toBeUndefined()
    expect(w.find('.sce-warn').exists()).toBe(false)
    expect(await save(w)).toBe('*/5 8-8 * * *') // [08:00, 09:00)
  })

  it('起 0 止 24 视作全天:合成 * 并按全天显示', async () => {
    const w = mountEditor({ cronExpression: '*/5 8-17 * * *' })
    expect(w.find('.sce-warn').exists()).toBe(false)
    await w.find(winStart).setValue('0')
    await w.find(winEnd).setValue('24')
    expect(w.find('.sce-hint').text()).toBe('All day')
    expect(await save(w)).toBe('*/5 * * * *')
  })

  it('反解回填:当日区间 / 跨午夜区间 / 全天', () => {
    const sameDay = mountEditor({ cronExpression: '*/5 8-17 * * *' })
    expect(selected(sameDay, winStart)).toBe('8')
    expect(selected(sameDay, winEnd)).toBe('18')

    const overnight = mountEditor({ cronExpression: '*/5 22-23,0-7 * * *' })
    expect(selected(overnight, winStart)).toBe('22')
    expect(selected(overnight, winEnd)).toBe('8')

    const allDay = mountEditor({ cronExpression: '*/5 0-23 * * *' })
    expect(selected(allDay, winStart)).toBe('0')
    expect(selected(allDay, winEnd)).toBe('24')
    expect(allDay.find('.sce-hint').text()).toBe('All day')
  })

  it('反解回填:小时频率带窗口的形态识别为 hourly + 间隔 + 时段', () => {
    const w = mountEditor({ cronExpression: '0 8-17/2 * * *' })
    expect((w.find(freqSelect).element as HTMLSelectElement).value).toBe('hourly')
    expect((w.find('.sce-interval').element as HTMLInputElement).value).toBe('2')
    expect(selected(w, winStart)).toBe('8')
    expect(selected(w, winEnd)).toBe('18')
  })

  it('反解失败(手写多段)落自定义只读态,保存后 hour 字段原样不变', async () => {
    const w = mountEditor({ cronExpression: '*/5 8-12,14-18 * * *' })
    expect(w.find(winStart).exists()).toBe(false)
    expect(w.find('.sce-custom').text()).toContain('8-12,14-18')
    expect(w.find('.sce-tag').text()).toBe('Custom')
    // 不得回退为全天:那会静默扩大执行范围。
    expect(await save(w)).toBe('*/5 8-12,14-18 * * *')
  })

  it('自定义态:minutely 改间隔仍保留原 hour 字段', async () => {
    const w = mountEditor({ cronExpression: '*/5 8-12,14-18 * * *' })
    await w.find('.sce-interval').setValue(3)
    expect(await save(w)).toBe('*/3 8-12,14-18 * * *')
  })

  it('自定义态:hourly 的步长写在被保留的 hour 字段里,间隔输入锁定', async () => {
    const w = mountEditor({ cronExpression: '0 8-12,14-18 * * *' })
    expect(w.find('.sce-interval').attributes('disabled')).toBeDefined()
    expect(await save(w)).toBe('0 8-12,14-18 * * *')
  })

  it('切换自动化复用同一实例时,不复用上一条的时段', async () => {
    // 弹框常驻挂载,组件实例跨自动化复用:上一条的时段若留在控件里,
    // 「打开再保存」就会把这一条的排期静默收窄(全天每 3 小时 → 8-17 点每 3 小时)。
    const w = mountEditor({ cronExpression: '*/5 8-17 * * *' })
    expect(selected(w, winStart)).toBe('8')
    await w.setProps({ cronExpression: '0 */3 * * *' })
    expect(selected(w, winStart)).toBe('0')
    expect(selected(w, winEnd)).toBe('24')
    expect(await save(w)).toBe('0 */3 * * *')
  })

  it('保留 dom / mon / dow:minutely / hourly 不改写手写的日期约束', async () => {
    // 每时带窗口 + 工作日:引入时段前该形态走 daily/weekly 分支,保住 1-5 却把 hour
    // 变成 0;引入后反过来保住 hour 却会丢 1-5 —— 都是静默改排期,要求原样往返。
    const hourly = mountEditor({ cronExpression: '0 9-17/2 * * 1-5' })
    expect((hourly.find(freqSelect).element as HTMLSelectElement).value).toBe('hourly')
    expect(selected(hourly, winStart)).toBe('9')
    expect(selected(hourly, winEnd)).toBe('18')
    expect(hourly.findAll('.sce-hint').some((h) => h.text().includes('1-5'))).toBe(true)
    expect(await save(hourly)).toBe('0 9-17/2 * * 1-5')

    const minutely = mountEditor({ cronExpression: '*/5 8-17 * * 1-5' })
    expect(minutely.findAll('.sce-hint').some((h) => h.text().includes('1-5'))).toBe(true)
    expect(await save(minutely)).toBe('*/5 8-17 * * 1-5')

    // 自定义 hour 字段与日期约束并存时,两者都按原样保留。
    const custom = mountEditor({ cronExpression: '0 8-12,14-18 * * 1-5' })
    expect(await save(custom)).toBe('0 8-12,14-18 * * 1-5')

    // 默认 `* * *` 不额外提示。
    const allDay = mountEditor({ cronExpression: '*/5 * * * *' })
    expect(allDay.findAll('.sce-hint')).toHaveLength(1)
  })

  it('跨午夜两段步长写法不一致时落自定义态,不被改写', async () => {
    // `22-23/2,0-7` 的两段步长写法不同(后段是每小时),合成只能写成 `22-23/2,0-7/2`,
    // 会丢掉 1/3/5/7 点;反解不出可往返的单个区间时按原样保留。
    const w = mountEditor({ cronExpression: '*/5 22-23/2,0-7 * * *' })
    expect(w.find(winStart).exists()).toBe(false)
    expect(w.find('.sce-custom').text()).toContain('22-23/2,0-7')
    expect(await save(w)).toBe('*/5 22-23/2,0-7 * * *')
  })

  it('hourly 只展示分钟输入,不再显示无效的小时输入框', () => {
    const w = mountEditor({ cronExpression: '0 */2 * * *' })
    expect(w.findAll('.sce-time')).toHaveLength(1)
  })
})
