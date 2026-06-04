import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Schedule } from '@ccc/shared/protocol'
import { isValidCron } from '@ccc/shared/cron'
import ScheduleForm from './ScheduleForm.vue'

function mountForm(
  props: Partial<{
    open: boolean
    schedule: Schedule | null
    workspacePath: string
    timezone: string
  }> = {},
) {
  return mount(ScheduleForm, {
    props: {
      open: true,
      schedule: null,
      workspacePath: '/home/proj',
      timezone: 'UTC',
      ...props,
    },
  })
}

function sched(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 's1',
    type: 'command',
    config: { command: 'pnpm build', name: 'legacy name' },
    workspacePath: '/home/proj',
    cronExpression: '0 8 * * *',
    nextRunAt: null,
    status: 'active',
    mcpMode: 'sandboxed',
    toolAllowlist: [],
    toolDenylist: [],
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
    expect(input.workspacePath).toBe('/home/proj')
    expect(input.mcpMode).toBe('sandboxed')
    expect(isValidCron(input.cronExpression as string)).toBe(true)
    expect(input.config).toEqual({ command: 'pnpm build' })
    expect(input.config).not.toHaveProperty('name')
    expect(input.config).not.toHaveProperty('description')
  })

  it('create(llm):切换任务类型后 config 仅含 prompt', async () => {
    const w = mountForm()
    const segs = w.findAll('.sf-seg')
    await segs[1].trigger('click') // LLM prompt
    await w.find('textarea').setValue('Run a security audit')
    await w.find('.sf-btn.primary').trigger('click')

    const input = w.emitted('create')![0][0] as Record<string, unknown>
    expect(input.type).toBe('llm')
    expect(input.config).toEqual({ prompt: 'Run a security audit' })
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

  it('update:payload 含 config/cronExpression/mcpMode,不含 name/description', async () => {
    const w = mountForm({ schedule: sched() })
    // 既有 legacy config.name 不应回流到 payload
    await w.find('.sf-btn.primary').trigger('click')

    const updated = w.emitted('update')
    expect(updated).toBeTruthy()
    const [id, input] = updated![0] as [string, Record<string, unknown>]
    expect(id).toBe('s1')
    expect(input.mcpMode).toBe('sandboxed')
    expect(isValidCron(input.cronExpression as string)).toBe(true)
    expect(input.config).toEqual({ command: 'pnpm build' })
    expect(input.config).not.toHaveProperty('name')
    expect(input.config).not.toHaveProperty('description')
    expect(input).not.toHaveProperty('type')
  })
})
