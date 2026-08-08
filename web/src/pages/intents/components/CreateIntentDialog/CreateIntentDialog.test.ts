/**
 * CreateIntentDialog — 新增意图弹窗。
 *
 * 这里钉的是弹窗对「一次提交就建好意图并开始会话」的四项承诺:
 *  1. 基准两支互斥,默认停在分支支并预填工作区主分支——「默认」因此是一次显式选择,
 *     提交出去的载荷里能看见它;
 *  2. 交付支只列分支已就绪的交付,因为分支没就绪的交付没有可写入的 base_branch,
 *     服务端会拒——与其让用户提交后碰壁,不如不给选;
 *  3. 必填校验与提交中防重都落在确认按钮上;
 *  4. 草稿只在「打开」这一刻重置。被拒绝时父组件让弹窗保持打开,内容必须还在。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Delivery } from '@ccc/shared/protocol'
import CreateIntentDialog from './CreateIntentDialog.vue'

function delivery(over: Partial<Delivery> = {}): Delivery {
  return {
    id: 'd1',
    workspaceId: 'w1',
    title: 'Sprint 3',
    description: '',
    status: 'integrating',
    startDate: null,
    endDate: null,
    branchName: 'delivery/v1',
    baseBranch: 'main',
    branchReady: true,
    integration: { total: 0, merged: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function mountDialog(
  over: {
    open?: boolean
    deliveries?: Delivery[]
    mainBranch?: string | null
    pending?: boolean
  } = {},
) {
  return mount(CreateIntentDialog, {
    props: {
      open: over.open ?? true,
      deliveries: over.deliveries ?? [delivery()],
      mainBranch: over.mainBranch === undefined ? 'main' : over.mainBranch,
      pending: over.pending ?? false,
    },
  })
}

describe('CreateIntentDialog — 打开/关闭', () => {
  it('open=false 时整个弹窗不渲染', () => {
    const w = mountDialog({ open: false })
    expect(w.find('[data-testid="create-intent-dialog"]').exists()).toBe(false)
  })

  it('点遮罩 emit cancel', async () => {
    const w = mountDialog()
    await w.find('[data-testid="create-intent-overlay"]').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
  })

  it('点取消按钮 emit cancel', async () => {
    const w = mountDialog()
    await w.find('[data-testid="create-intent-cancel"]').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
  })

  it('Esc emit cancel', async () => {
    const w = mountDialog()
    await w.find('[data-testid="create-intent-overlay"]').trigger('keydown.esc')
    expect(w.emitted('cancel')).toHaveLength(1)
  })
})

describe('CreateIntentDialog — 基准来源互斥与默认', () => {
  it('默认停在分支支,并预填工作区主分支', () => {
    const w = mountDialog({ mainBranch: 'develop' })
    const branchRadio = w.find<HTMLInputElement>('[data-testid="create-intent-base-branch"]')
    expect(branchRadio.element.checked).toBe(true)
    expect(w.find<HTMLInputElement>('[data-testid="create-intent-branch"]').element.value).toBe(
      'develop',
    )
    // 分支支时不渲染交付下拉——两支互斥,不是同时可填。
    expect(w.find('[data-testid="create-intent-delivery"]').exists()).toBe(false)
  })

  it('切到交付支后只剩交付下拉,分支输入消失', async () => {
    const w = mountDialog()
    await w.find('[data-testid="create-intent-base-delivery"]').setValue()
    expect(w.find('[data-testid="create-intent-delivery"]').exists()).toBe(true)
    expect(w.find('[data-testid="create-intent-branch"]').exists()).toBe(false)
  })

  it('交付下拉只列分支已就绪且分支名非空的交付', async () => {
    const w = mountDialog({
      deliveries: [
        delivery({ id: 'ready', title: 'Ready', branchName: 'delivery/v1', branchReady: true }),
        delivery({
          id: 'notReady',
          title: 'NotReady',
          branchName: 'delivery/v2',
          branchReady: false,
        }),
        delivery({ id: 'noBranch', title: 'NoBranch', branchName: null, branchReady: true }),
        delivery({ id: 'blank', title: 'Blank', branchName: '   ', branchReady: true }),
      ],
    })
    await w.find('[data-testid="create-intent-base-delivery"]').setValue()
    const values = w
      .find('[data-testid="create-intent-delivery"]')
      .findAll('option')
      .map((o) => o.element.value)
    // 首项是占位空值,其后只有那条就绪的。
    expect(values).toEqual(['', 'ready'])
  })

  it('一条可选交付都没有时给出说明', async () => {
    const w = mountDialog({ deliveries: [delivery({ branchReady: false })] })
    await w.find('[data-testid="create-intent-base-delivery"]').setValue()
    expect(w.find('[data-testid="create-intent-delivery-empty"]').exists()).toBe(true)
  })
})

describe('CreateIntentDialog — 校验与提交', () => {
  const submit = (w: ReturnType<typeof mountDialog>) =>
    w.find<HTMLButtonElement>('[data-testid="create-intent-submit"]')

  it('内容为空 → 不可提交', () => {
    expect(submit(mountDialog()).element.disabled).toBe(true)
  })

  it('只有空白内容 → 仍不可提交', async () => {
    const w = mountDialog()
    await w.find('[data-testid="create-intent-content"]').setValue('   ')
    expect(submit(w).element.disabled).toBe(true)
  })

  it('内容齐全但分支名被清空 → 不可提交', async () => {
    const w = mountDialog()
    await w.find('[data-testid="create-intent-content"]').setValue('CONTENT_ABC')
    await w.find('[data-testid="create-intent-branch"]').setValue('  ')
    expect(submit(w).element.disabled).toBe(true)
  })

  it('切到交付支但未选中任何交付 → 不可提交', async () => {
    const w = mountDialog()
    await w.find('[data-testid="create-intent-content"]').setValue('CONTENT_ABC')
    await w.find('[data-testid="create-intent-base-delivery"]').setValue()
    expect(submit(w).element.disabled).toBe(true)
  })

  it('分支支提交 → 载荷带 trim 后的内容与分支名', async () => {
    const w = mountDialog({ mainBranch: 'develop' })
    await w.find('[data-testid="create-intent-content"]').setValue('  CONTENT_ABC  ')
    await submit(w).trigger('click')
    expect(w.emitted('confirm')?.[0]).toEqual([
      { content: 'CONTENT_ABC', base: { kind: 'branch', branch: 'develop' } },
    ])
  })

  it('交付支提交 → 载荷只带交付 id(分支由服务端解析)', async () => {
    const w = mountDialog()
    await w.find('[data-testid="create-intent-content"]').setValue('CONTENT_ABC')
    await w.find('[data-testid="create-intent-base-delivery"]').setValue()
    await w.find('[data-testid="create-intent-delivery"]').setValue('d1')
    await submit(w).trigger('click')
    expect(w.emitted('confirm')?.[0]).toEqual([
      { content: 'CONTENT_ABC', base: { kind: 'delivery', deliveryId: 'd1' } },
    ])
  })

  it('提交中 → 按钮禁用且再点也不重复 emit', async () => {
    const w = mountDialog({ pending: true })
    await w.find('[data-testid="create-intent-content"]').setValue('CONTENT_ABC')
    expect(submit(w).element.disabled).toBe(true)
    await submit(w).trigger('click')
    expect(w.emitted('confirm')).toBeUndefined()
  })
})

describe('CreateIntentDialog — 草稿生命周期', () => {
  it('保持打开时(提交被拒)草稿原样留着', async () => {
    const w = mountDialog()
    await w.find('[data-testid="create-intent-content"]').setValue('CONTENT_ABC')
    await w.find('[data-testid="create-intent-branch"]').setValue('feature/x')

    // 服务端拒绝:pending 落回 false,但 open 仍为 true——弹窗不重置。
    await w.setProps({ pending: true })
    await w.setProps({ pending: false })

    expect(w.find<HTMLTextAreaElement>('[data-testid="create-intent-content"]').element.value).toBe(
      'CONTENT_ABC',
    )
    expect(w.find<HTMLInputElement>('[data-testid="create-intent-branch"]').element.value).toBe(
      'feature/x',
    )
  })

  it('重新打开 → 草稿清空并回到预填的主分支', async () => {
    const w = mountDialog({ mainBranch: 'develop' })
    await w.find('[data-testid="create-intent-content"]').setValue('CONTENT_ABC')
    await w.find('[data-testid="create-intent-base-delivery"]').setValue()

    await w.setProps({ open: false })
    await w.setProps({ open: true })

    expect(w.find<HTMLTextAreaElement>('[data-testid="create-intent-content"]').element.value).toBe(
      '',
    )
    expect(w.find<HTMLInputElement>('[data-testid="create-intent-branch"]').element.value).toBe(
      'develop',
    )
  })

  it('工作区没有主分支时预填为空,提交仍被必填校验挡住', async () => {
    const w = mountDialog({ mainBranch: null })
    await w.find('[data-testid="create-intent-content"]').setValue('CONTENT_ABC')
    expect(w.find<HTMLInputElement>('[data-testid="create-intent-branch"]').element.value).toBe('')
    expect(w.find<HTMLButtonElement>('[data-testid="create-intent-submit"]').element.disabled).toBe(
      true,
    )
  })
})
