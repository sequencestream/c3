/**
 * AddWorkspaceDialog.vue — 目录点选取代手敲路径后的弹框行为。
 *
 * 一条路径在这里会变成一个工作区的信任根,所以路径默认不可编辑:只能来自服务端
 * 原生目录对话框的回填。围绕这一点要守住的是三种回复的归宿(选中 / 取消 / 调起
 * 失败)、兜底手动输入的进出,以及既有的名称推断与确认载荷一字未改。
 */
import { describe, it, expect } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import AddWorkspaceDialog from './AddWorkspaceDialog.vue'

type Selection = { path: string } | null

const baseProps = {
  open: true,
  pickerPending: false,
  pickerError: null as string | null,
  pickerSelection: null as Selection,
}

const open = (
  overrides: Partial<typeof baseProps> = {},
): VueWrapper<InstanceType<typeof AddWorkspaceDialog>> =>
  mount(AddWorkspaceDialog, { props: { ...baseProps, ...overrides } })

/** 服务端回了 `selected`:控制器每次都换一个新对象,弹框据此回填。 */
const selected = (path: string): { pickerSelection: Selection; pickerPending: boolean } => ({
  pickerSelection: { path },
  pickerPending: false,
})

const pathText = (w: VueWrapper): string => w.find('[data-testid="workspace-path-readonly"]').text()
const nameField = (w: VueWrapper) => w.find('[data-testid="workspace-name-field"]')
const accept = (w: VueWrapper) => w.find('[data-testid="input-accept"]')

describe('路径字段的只读态', () => {
  it('打开时路径只读展示,没有可输入的路径框', () => {
    const w = open()
    expect(w.find('[data-testid="workspace-path-readonly"]').exists()).toBe(true)
    expect(w.find('[data-testid="input-field"]').exists()).toBe(false)
  })

  it('未选目录时确认禁用', () => {
    expect((accept(open()).element as HTMLButtonElement).disabled).toBe(true)
  })

  it('「选择目录」上抛 selectDirectory', async () => {
    const w = open()
    await w.find('[data-testid="select-directory"]').trigger('click')
    expect(w.emitted('selectDirectory')).toHaveLength(1)
  })

  it('请求在飞行中时禁止重复请求与保存', async () => {
    const w = open()
    // 已经选过一个目录,用户又点了一次「选择目录」。
    await w.setProps(selected('/home/proj'))
    await w.setProps({ pickerPending: true })
    expect((w.find('[data-testid="select-directory"]').element as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect((accept(w).element as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('选中目录', () => {
  it('回填绝对路径并按 basename 推断名称', async () => {
    const w = open()
    await w.setProps(selected('/home/dev/proj-c'))
    expect(pathText(w)).toBe('/home/dev/proj-c')
    expect((nameField(w).element as HTMLInputElement).value).toBe('proj-c')
  })

  it('用户改过名称后,再次选目录不覆盖名称', async () => {
    const w = open()
    await w.setProps(selected('/home/dev/proj-c'))
    await nameField(w).setValue('研发 / C')
    await w.setProps(selected('/home/dev/other'))
    expect(pathText(w)).toBe('/home/dev/other')
    expect((nameField(w).element as HTMLInputElement).value).toBe('研发 / C')
  })

  it('确认载荷与既有契约一致,名称 trim 后上抛', async () => {
    const w = open()
    await w.setProps(selected('/home/dev/proj-c'))
    await nameField(w).setValue('  proj-c  ')
    await accept(w).trigger('click')
    expect(w.emitted('confirm')).toEqual([[{ workspaceName: 'proj-c', path: '/home/dev/proj-c' }]])
  })

  it('名称超过 64 个 Unicode 字符时确认禁用', async () => {
    const w = open()
    await w.setProps(selected('/home/dev/proj-c'))
    await nameField(w).setValue('🚀'.repeat(65))
    expect((accept(w).element as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('用户在系统对话框里取消', () => {
  it('保持原状:不报错、不清空已选路径与名称', async () => {
    const w = open()
    await w.setProps(selected('/home/dev/proj-c'))
    await nameField(w).setValue('kept')
    // 再点一次「选择目录」,然后在系统对话框里取消 —— 取消只是把 pending 落回。
    await w.setProps({ pickerPending: true })
    await w.setProps({ pickerPending: false })
    expect(pathText(w)).toBe('/home/dev/proj-c')
    expect((nameField(w).element as HTMLInputElement).value).toBe('kept')
    expect(w.find('[data-testid="picker-error"]').exists()).toBe(false)
    expect((accept(w).element as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('调起失败后的手动输入兜底', () => {
  it('展示本地化说明与「手动输入路径」入口', async () => {
    const w = open({ pickerError: '没有可用的目录选择器' })
    expect(w.find('[data-testid="picker-error"]').text()).toContain('没有可用的目录选择器')
    expect(w.find('[data-testid="use-manual-path"]').exists()).toBe(true)
    // 兜底是显式动作,不是默认态:路径此时仍然只读。
    expect(w.find('[data-testid="input-field"]').exists()).toBe(false)
  })

  it('切到手动输入后路径可编辑,并沿用既有的边打边推断名称', async () => {
    const w = open({ pickerError: 'boom' })
    await w.find('[data-testid="use-manual-path"]').trigger('click')
    await w.find('[data-testid="input-field"]').setValue('/home/manual/proj')
    expect((nameField(w).element as HTMLInputElement).value).toBe('proj')
    await accept(w).trigger('click')
    expect(w.emitted('confirm')).toEqual([[{ workspaceName: 'proj', path: '/home/manual/proj' }]])
  })

  it('手动输入不覆盖用户已编辑的名称', async () => {
    const w = open({ pickerError: 'boom' })
    await w.find('[data-testid="use-manual-path"]').trigger('click')
    await nameField(w).setValue('mine')
    await w.find('[data-testid="input-field"]').setValue('/home/manual/proj')
    expect((nameField(w).element as HTMLInputElement).value).toBe('mine')
  })

  it('兜底期间「选择目录」仍可重试,成功后回到只读态', async () => {
    const w = open({ pickerError: 'boom' })
    await w.find('[data-testid="use-manual-path"]').trigger('click')
    expect(w.find('[data-testid="input-field"]').exists()).toBe(true)
    await w.setProps({ pickerError: null, ...selected('/home/dev/picked') })
    expect(w.find('[data-testid="input-field"]').exists()).toBe(false)
    expect(pathText(w)).toBe('/home/dev/picked')
  })

  it('重新打开弹框回到点选态,不继承上一次的兜底与内容', async () => {
    const w = open({ pickerError: 'boom' })
    await w.find('[data-testid="use-manual-path"]').trigger('click')
    await w.find('[data-testid="input-field"]').setValue('/home/manual/proj')
    await w.setProps({ open: false })
    await w.setProps({ open: true, pickerError: null })
    expect(w.find('[data-testid="input-field"]').exists()).toBe(false)
    expect(w.find('[data-testid="workspace-path-readonly"]').exists()).toBe(true)
    expect((nameField(w).element as HTMLInputElement).value).toBe('')
    expect((accept(w).element as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('关闭入口', () => {
  it('遮罩与取消按钮都只上抛 cancel', async () => {
    const w = open()
    await w.find('[data-testid="input-cancel"]').trigger('click')
    await w.find('[data-testid="input-overlay"]').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(2)
    expect(w.emitted('confirm')).toBeUndefined()
  })

  it('open 为假时不渲染', () => {
    expect(open({ open: false }).find('[data-testid="input-overlay"]').exists()).toBe(false)
  })
})
