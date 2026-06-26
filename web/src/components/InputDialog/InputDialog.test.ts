import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import InputDialog from './InputDialog.vue'

const baseProps = {
  title: '添加工作区',
  placeholder: '/path/to/workspace',
  confirmLabel: '添加',
  cancelLabel: '取消',
}

describe('InputDialog.vue', () => {
  it('open=false → 不渲染', () => {
    const w = mount(InputDialog, { props: { open: false, ...baseProps } })
    expect(w.find('[data-testid="input-overlay"]').exists()).toBe(false)
  })

  it('渲染标题/输入框/按钮;空输入时确认按钮 disabled', () => {
    const w = mount(InputDialog, { props: { open: true, ...baseProps } })
    expect(w.find('.id-title').text()).toBe('添加工作区')
    expect(w.find('[data-testid="input-field"]').exists()).toBe(true)
    expect((w.find('[data-testid="input-accept"]').element as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  it('输入文字后确认 → emit confirm(trim 后文本)', async () => {
    const w = mount(InputDialog, { props: { open: true, ...baseProps } })
    await w.find('[data-testid="input-field"]').setValue('  /home/proj  ')
    expect((w.find('[data-testid="input-accept"]').element as HTMLButtonElement).disabled).toBe(
      false,
    )
    await w.find('[data-testid="input-accept"]').trigger('click')
    expect(w.emitted('confirm')).toEqual([['/home/proj']])
  })

  it('Enter 提交 → emit confirm', async () => {
    const w = mount(InputDialog, { props: { open: true, ...baseProps } })
    const field = w.find('[data-testid="input-field"]')
    await field.setValue('/home/proj')
    await field.trigger('keydown.enter')
    expect(w.emitted('confirm')).toEqual([['/home/proj']])
  })

  it('空输入时 Enter 不提交', async () => {
    const w = mount(InputDialog, { props: { open: true, ...baseProps } })
    await w.find('[data-testid="input-field"]').trigger('keydown.enter')
    expect(w.emitted('confirm')).toBeUndefined()
  })

  it('取消按钮 / 遮罩 / Esc → emit cancel', async () => {
    const w = mount(InputDialog, { props: { open: true, ...baseProps } })
    await w.find('[data-testid="input-cancel"]').trigger('click')
    await w.find('[data-testid="input-overlay"]').trigger('click')
    await w.find('[data-testid="input-overlay"]').trigger('keydown.esc')
    expect(w.emitted('cancel')).toHaveLength(3)
  })

  it('每次打开时清空上次输入', async () => {
    const w = mount(InputDialog, { props: { open: true, ...baseProps } })
    await w.find('[data-testid="input-field"]').setValue('/old')
    await w.setProps({ open: false })
    await w.setProps({ open: true })
    expect((w.find('[data-testid="input-field"]').element as HTMLInputElement).value).toBe('')
  })
})
