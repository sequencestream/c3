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
