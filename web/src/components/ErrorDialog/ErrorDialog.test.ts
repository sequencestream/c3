import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ErrorDialog from './ErrorDialog.vue'

function mountDialog(props: Partial<InstanceType<typeof ErrorDialog>['$props']> = {}) {
  return mount(ErrorDialog, {
    props: {
      open: true,
      title: 'Action failed',
      message: 'The spec has not been written yet.',
      closeLabel: 'Close',
      ...props,
    },
  })
}

describe('ErrorDialog.vue', () => {
  it('open=false 时不渲染任何弹窗', () => {
    expect(mountDialog({ open: false }).find('[data-testid="error-dialog-overlay"]').exists()).toBe(
      false,
    )
  })

  it('渲染标题、正文和关闭按钮', () => {
    const w = mountDialog()
    expect(w.find('.ed-title').text()).toBe('Action failed')
    expect(w.find('.ed-message').text()).toBe('The spec has not been written yet.')
    expect(w.find('[data-testid="error-dialog-close"]').text()).toBe('Close')
  })

  it('关闭按钮、Esc 和遮罩点击均 emit close', async () => {
    const button = mountDialog()
    await button.find('[data-testid="error-dialog-close"]').trigger('click')
    expect(button.emitted('close')).toHaveLength(1)

    const esc = mountDialog()
    await esc.find('[data-testid="error-dialog-overlay"]').trigger('keydown.esc')
    expect(esc.emitted('close')).toHaveLength(1)

    const overlay = mountDialog()
    await overlay.find('[data-testid="error-dialog-overlay"]').trigger('click')
    expect(overlay.emitted('close')).toHaveLength(1)
  })
})
