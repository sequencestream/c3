import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ConfirmDialog from './ConfirmDialog.vue'

function mountDialog(props: Partial<InstanceType<typeof ConfirmDialog>['$props']> = {}) {
  return mount(ConfirmDialog, {
    props: {
      open: true,
      title: 'Delete automation?',
      message: 'Delete "Nightly Build"? This cannot be undone.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      ...props,
    },
  })
}

describe('ConfirmDialog.vue', () => {
  it('open=false 时不渲染任何弹窗', () => {
    const w = mountDialog({ open: false })
    expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(false)
  })

  it('open=true 渲染标题/正文/按钮文案', () => {
    const w = mountDialog()
    expect(w.find('.cd-title').text()).toBe('Delete automation?')
    expect(w.find('.cd-message').text()).toContain('Nightly Build')
    expect(w.find('[data-testid="confirm-accept"]').text()).toBe('Delete')
    expect(w.find('[data-testid="confirm-cancel"]').text()).toBe('Cancel')
  })

  it('点确认按钮 emit confirm', async () => {
    const w = mountDialog()
    await w.find('[data-testid="confirm-accept"]').trigger('click')
    expect(w.emitted('confirm')).toHaveLength(1)
    expect(w.emitted('cancel')).toBeUndefined()
  })

  it('点取消按钮 emit cancel', async () => {
    const w = mountDialog()
    await w.find('[data-testid="confirm-cancel"]').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.emitted('confirm')).toBeUndefined()
  })

  it('点遮罩(self)emit cancel', async () => {
    const w = mountDialog()
    await w.find('[data-testid="confirm-overlay"]').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
  })

  it('按 Esc emit cancel', async () => {
    const w = mountDialog()
    await w.find('[data-testid="confirm-overlay"]').trigger('keydown.esc')
    expect(w.emitted('cancel')).toHaveLength(1)
  })

  it('danger=true 时确认按钮带 danger 类', () => {
    const danger = mountDialog({ danger: true })
    expect(danger.find('[data-testid="confirm-accept"]').classes()).toContain('danger')

    const plain = mountDialog({ danger: false })
    expect(plain.find('[data-testid="confirm-accept"]').classes()).not.toContain('danger')
  })
})
