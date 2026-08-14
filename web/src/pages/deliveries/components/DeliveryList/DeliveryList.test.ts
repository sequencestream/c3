import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DELIVERY_STATUSES, type Delivery } from '@ccc/shared/protocol'
import DeliveryList from './DeliveryList.vue'

const STORAGE_KEY = 'c3.deliveryListCollapsed'

// happy-dom here may expose no localStorage; install a minimal in-memory stub so the
// usePersistentToggle persistence path actually runs.
function installLocalStorage(): void {
  const store = new Map<string, string>()
  const stub = {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size
    },
  }
  ;(globalThis as { localStorage?: unknown }).localStorage = stub
}

function delivery(over: Partial<Delivery> = {}): Delivery {
  return {
    id: 'd1',
    workspaceName: 'w1',
    title: 'Sprint 3',
    description: '',
    status: 'planned',
    startDate: null,
    endDate: null,
    branchName: null,
    baseBranch: 'main',
    branchReady: false,
    integration: { total: 0, merged: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

describe('DeliveryList', () => {
  beforeEach(() => {
    installLocalStorage()
  })

  afterEach(() => {
    ;(globalThis as { localStorage?: unknown }).localStorage = undefined
  })

  it('renders rows with the N/M aggregate inline (no separate progress bar)', () => {
    const w = mount(DeliveryList, {
      props: { deliveries: [delivery()], activeId: null },
    })
    expect(w.find('[data-testid="delivery-list-empty"]').exists()).toBe(false)
    const rows = w.findAll('[data-testid^="delivery-row-"]')
    expect(rows.length).toBeGreaterThan(0)
    expect(w.find('[data-testid="delivery-row-ready"]').exists()).toBe(true)
    // 无独立进度条/统计卡。
    expect(w.find('[data-testid="delivery-progress"]').exists()).toBe(false)
    expect(w.find('[data-testid="delivery-timeline"]').exists()).toBe(false)
  })

  it('emits open on row click', async () => {
    const w = mount(DeliveryList, {
      props: { deliveries: [delivery()], activeId: null },
    })
    await w.find('[data-testid^="delivery-row-"]').trigger('click')
    expect(w.emitted('open')?.[0]).toEqual(['d1'])
  })

  it('shows the empty state when there are no deliveries', () => {
    const w = mount(DeliveryList, { props: { deliveries: [], activeId: null } })
    expect(w.find('[data-testid="delivery-list-empty"]').exists()).toBe(true)
  })

  it('renders a status badge carrying its own status class, one per status', () => {
    for (const status of DELIVERY_STATUSES) {
      const w = mount(DeliveryList, {
        props: { deliveries: [delivery({ status })], activeId: null },
      })
      const badge = w.find(`[data-testid="delivery-status-${status}"]`)
      expect(badge.exists(), status).toBe(true)
      // 状态值即 CSS class —— 逐态配色靠它,是纯展示的 span 而非动作。
      expect(badge.classes(), status).toContain(status)
      expect(badge.classes(), status).toContain('delivery-row-status')
      expect(badge.element.tagName, status).toBe('SPAN')
    }
  })

  it('emits create with title/description/dates from the create dialog', async () => {
    const w = mount(DeliveryList, { props: { deliveries: [], activeId: null } })
    await w.find('[data-testid="delivery-new-btn"]').trigger('click')
    await w.find('[data-testid="delivery-create-title"]').setValue('Release X')
    await w.find('[data-testid="delivery-create-desc"]').setValue('the batch')
    await w.find('[data-testid="delivery-create-start"]').setValue('2026-08-06')
    await w.find('[data-testid="delivery-create-submit"]').trigger('click')
    const created = w.emitted('create')?.[0]?.[0] as {
      title: string
      description: string
      startDate: number | null
    }
    expect(created.title).toBe('Release X')
    expect(created.description).toBe('the batch')
    expect(created.startDate).toBe(Number(new Date('2026-08-06T00:00:00Z').getTime()))
  })
})

// ---- 头部:折叠按钮 + 「+」新建按钮 -------------------------------------

describe('DeliveryList — 头部折叠与「+」新建', () => {
  beforeEach(() => {
    installLocalStorage()
  })

  afterEach(() => {
    ;(globalThis as { localStorage?: unknown }).localStorage = undefined
  })

  it('折叠按钮位于头部最左,点击在两栏正常与窄条间切换并持久化', async () => {
    const w = mount(DeliveryList, { props: { deliveries: [delivery()], activeId: null } })

    // 头部最左第一个元素就是折叠按钮。
    const head = w.find('.delivery-list-head')
    expect(head.element.firstElementChild?.firstElementChild).toBe(
      w.find('[data-testid="delivery-collapse-btn"]').element,
    )

    // 展开态:无 collapsed 类,头部标题与行内 N/M 都在。
    expect(w.find('[data-testid="delivery-list"]').classes()).not.toContain('collapsed')
    expect(w.find('.delivery-list-title').exists()).toBe(true)
    expect(w.find('[data-testid="delivery-row-ready"]').exists()).toBe(true)
    expect(w.find('[data-testid="delivery-collapse-btn"]').attributes('aria-pressed')).toBe('false')

    // 收缩:加 collapsed 类,头部标题与行内次要信息不渲染,状态徽标保留。
    await w.find('[data-testid="delivery-collapse-btn"]').trigger('click')
    expect(w.find('[data-testid="delivery-list"]').classes()).toContain('collapsed')
    expect(w.find('.delivery-list-title').exists()).toBe(false)
    expect(w.find('[data-testid="delivery-row-ready"]').exists()).toBe(false)
    expect(w.find('[data-testid="delivery-status-planned"]').exists()).toBe(true)
    expect(w.find('[data-testid="delivery-collapse-btn"]').attributes('aria-pressed')).toBe('true')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true')

    // 再点回展开。
    await w.find('[data-testid="delivery-collapse-btn"]').trigger('click')
    expect(w.find('[data-testid="delivery-list"]').classes()).not.toContain('collapsed')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false')
  })

  it('折叠态跨挂载保持(读 localStorage 初始值)', () => {
    localStorage.setItem(STORAGE_KEY, 'true')
    const w = mount(DeliveryList, { props: { deliveries: [delivery()], activeId: null } })
    expect(w.find('[data-testid="delivery-list"]').classes()).toContain('collapsed')
    expect(w.find('[data-testid="delivery-collapse-btn"]').attributes('aria-pressed')).toBe('true')
  })

  it('窄条态下行仍可点击切换选中,选中高亮不受影响', async () => {
    localStorage.setItem(STORAGE_KEY, 'true')
    const w = mount(DeliveryList, {
      props: {
        deliveries: [delivery(), delivery({ id: 'd2', title: 'Sprint 4' })],
        activeId: 'd2',
      },
    })
    const rows = w.findAll('[data-testid^="delivery-row-"]')
    expect(rows[1].classes()).toContain('active')
    expect(rows[0].classes()).not.toContain('active')
    await rows[0].trigger('click')
    expect(w.emitted('open')?.[0]).toEqual(['d1'])
  })

  it('新建按钮位于头部最右、为纯「+」图标,tooltip 与 aria-label 走 i18n', async () => {
    const w = mount(DeliveryList, { props: { deliveries: [], activeId: null } })
    const head = w.find('.delivery-list-head')
    const newBtn = w.find('[data-testid="delivery-new-btn"]')
    expect(head.element.lastElementChild).toBe(newBtn.element)
    expect(newBtn.text()).toBe('+')
    // i18n 已解析(非 key 原样回显),且 title 与 aria-label 同源。
    const title = newBtn.attributes('title')
    expect(title).toBeTruthy()
    expect(title).not.toContain('delivery.action.create')
    expect(newBtn.attributes('aria-label')).toBe(title)

    // 打开的是弹窗,而非把表单塞进列表(旧的内联表单钩子彻底消失)。
    expect(w.find('[data-testid="delivery-create-dialog"]').exists()).toBe(false)
    expect(w.find('[data-testid="delivery-create-form"]').exists()).toBe(false)
    await newBtn.trigger('click')
    expect(w.find('[data-testid="delivery-create-dialog"]').exists()).toBe(true)
    expect(w.find('[data-testid="delivery-create-form"]').exists()).toBe(false)
  })
})

// ---- 新建交付弹窗 ------------------------------------------------------

describe('DeliveryList — 新建交付弹窗', () => {
  beforeEach(() => {
    installLocalStorage()
  })

  afterEach(() => {
    ;(globalThis as { localStorage?: unknown }).localStorage = undefined
  })

  async function openCreate() {
    const w = mount(DeliveryList, {
      props: { deliveries: [delivery()], activeId: null },
      attachTo: document.body,
    })
    await w.find('[data-testid="delivery-new-btn"]').trigger('click')
    await nextTick()
    return w
  }

  it('「+」打开的是模态弹窗:有 dialog 语义与本地化可访问名,标题输入获得焦点', async () => {
    const w = await openCreate()
    const dialog = w.find('[data-testid="delivery-create-dialog"]')
    expect(dialog.exists()).toBe(true)
    expect(dialog.attributes('role')).toBe('dialog')
    expect(dialog.attributes('aria-modal')).toBe('true')
    // i18n 已解析(非 key 原样回显)。
    const name = dialog.attributes('aria-label')
    expect(name).toBeTruthy()
    expect(name).not.toContain('delivery.action.createTitle')

    expect(document.activeElement).toBe(w.find('[data-testid="delivery-create-title"]').element)
    w.unmount()
  })

  it('标题去空白后为空时提交禁用', async () => {
    const w = await openCreate()
    // 初始空标题即禁用。
    expect(w.find('[data-testid="delivery-create-submit"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="delivery-create-title"]').setValue('   ')
    expect(w.find('[data-testid="delivery-create-submit"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="delivery-create-title"]').setValue('Release X')
    expect(w.find('[data-testid="delivery-create-submit"]').attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('提交一次 create:标题/描述去空白,填了的日期落 UTC 零点、留空落 null,并关闭弹窗', async () => {
    const w = await openCreate()
    await w.find('[data-testid="delivery-create-title"]').setValue('  Release X  ')
    await w.find('[data-testid="delivery-create-desc"]').setValue('  the batch  ')
    await w.find('[data-testid="delivery-create-start"]').setValue('2026-08-06')
    await w.find('[data-testid="delivery-create-end"]').setValue('')
    await w.find('[data-testid="delivery-create-submit"]').trigger('click')

    expect(w.emitted('create')).toHaveLength(1)
    expect(w.emitted('create')?.[0]).toEqual([
      {
        title: 'Release X',
        description: 'the batch',
        startDate: Date.parse('2026-08-06T00:00:00Z'),
        endDate: null,
      },
    ])
    expect(w.find('[data-testid="delivery-create-dialog"]').exists()).toBe(false)
    w.unmount()
  })

  it('取消按钮/遮罩/Esc 三路等价:都关闭弹窗、都不 emit create', async () => {
    for (const dismiss of [
      (w: VueWrapper) => w.find('[data-testid="delivery-create-cancel"]').trigger('click'),
      (w: VueWrapper) => w.find('[data-testid="delivery-create-overlay"]').trigger('click'),
      (w: VueWrapper) => w.find('[data-testid="delivery-create-overlay"]').trigger('keydown.esc'),
    ]) {
      const w = await openCreate()
      await w.find('[data-testid="delivery-create-title"]').setValue('draft')
      await dismiss(w)
      expect(w.emitted('create')).toBeFalsy()
      expect(w.find('[data-testid="delivery-create-dialog"]').exists()).toBe(false)
      // 取消不改动列表已有数据(仍是那一条 Sprint 3,没有多出草稿行)。
      const rows = w.findAll('[data-testid="delivery-row-planned"]')
      expect(rows).toHaveLength(1)
      expect(rows[0].text()).toContain('Sprint 3')
      w.unmount()
    }
  })

  it('重新打开清空草稿:四个字段全空', async () => {
    const w = await openCreate()
    await w.find('[data-testid="delivery-create-title"]').setValue('draft never submitted')
    await w.find('[data-testid="delivery-create-desc"]').setValue('draft desc')
    await w.find('[data-testid="delivery-create-start"]').setValue('2026-08-06')
    await w.find('[data-testid="delivery-create-end"]').setValue('2026-08-07')
    await w.find('[data-testid="delivery-create-cancel"]').trigger('click')

    await w.find('[data-testid="delivery-new-btn"]').trigger('click')
    for (const id of ['title', 'desc', 'start', 'end']) {
      const el = w.find(`[data-testid="delivery-create-${id}"]`).element as
        HTMLInputElement | HTMLTextAreaElement
      expect(el.value, id).toBe('')
    }
    w.unmount()
  })
})

// ---- 宽度样式契约 ------------------------------------------------------

// happy-dom 不计算布局,样式契约直接对组件源码里的 CSS 规则做断言。
const listSrc = readFileSync(
  resolve(process.cwd(), 'web/src/pages/deliveries/components/DeliveryList/DeliveryList.vue'),
  'utf8',
)

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

describe('DeliveryList.vue — 列宽样式契约', () => {
  it('列表有固定基础宽度、折叠态收窄,且不被 flex 压缩', () => {
    const base = ruleBody(listSrc, '.delivery-list')
    expect(base).toMatch(/width:\s*960px/)
    expect(base).toMatch(/flex-shrink:\s*0/)
    expect(ruleBody(listSrc, '.delivery-list.collapsed')).toMatch(/width:\s*480px/)
  })

  it('状态徽标是 pill 徽标,六态各有一条配色规则且互不相同', () => {
    const base = ruleBody(listSrc, '.delivery-row-status')
    // 与 .req-status 同款 pill:badge 字号 + pill 圆角,不再是描边小方块。
    expect(base).toMatch(/font-size:\s*var\(--fs-badge\)/)
    expect(base).toMatch(/border-radius:\s*var\(--radius-pill\)/)
    expect(base).not.toMatch(/border:/)

    const bodies = DELIVERY_STATUSES.map((s) => {
      const body = ruleBody(listSrc, `.delivery-row-status.${s}`)
      expect(body, s).toMatch(/color:/)
      expect(body, s).toMatch(/background:/)
      return body.replace(/\s+/g, '')
    })
    // 六态可区分:没有两态落在同一条配色上。
    expect(new Set(bodies).size).toBe(DELIVERY_STATUSES.length)
  })

  it('移动端两态均满宽,不横向溢出', () => {
    const mobile = /@media \(max-width: 767px\) \{([\s\S]*?)\n\}/.exec(listSrc)?.[1] ?? ''
    expect(mobile).toContain('.delivery-list,')
    expect(mobile).toContain('.delivery-list.collapsed')
    expect(mobile).toMatch(/width:\s*100%/)
    expect(mobile).toMatch(/min-width:\s*0/)
  })

  it('内联创建表单的样式已随交互一并移除', () => {
    expect(listSrc).not.toMatch(/\.delivery-create-form/)
    expect(listSrc).not.toMatch(/\.delivery-form-field/)
    expect(listSrc).not.toMatch(/\.delivery-create-submit/)
  })
})

// ---- 新建弹窗样式契约 --------------------------------------------------

const createDialogSrc = readFileSync(
  resolve(
    process.cwd(),
    'web/src/pages/deliveries/components/DeliveryList/DeliveryCreateDialog.vue',
  ),
  'utf8',
)

describe('DeliveryCreateDialog.vue — 弹窗宽度契约', () => {
  it('桌面端默认宽度为页面宽度的二分之一,上下限与编辑弹窗同一对值', () => {
    const modal = ruleBody(createDialogSrc, '.dc-modal')
    expect(modal).toMatch(/width:\s*50vw/)
    expect(modal).toMatch(/min-width:\s*420px/)
    expect(modal).toMatch(/max-width:\s*860px/)
  })

  it('移动端退化为全屏 sheet:满宽、撑满视高、去边框圆角、安全区留白、日期竖排、页脚吸底', () => {
    const mobile = /@media \(max-width: 767px\) \{([\s\S]*?)\n\}/.exec(createDialogSrc)?.[1] ?? ''
    const modal = ruleBody(mobile, '.dc-modal')
    expect(modal).toMatch(/width:\s*100vw/)
    expect(modal).toMatch(/min-width:\s*0/)
    expect(modal).toMatch(/max-width:\s*none/)
    expect(modal).toMatch(/min-height:\s*100dvh/)
    expect(modal).toMatch(/border:\s*0/)
    expect(modal).toMatch(/border-radius:\s*0/)
    expect(modal).toMatch(/env\(safe-area-inset-/)
    // 起止日期由并排改为竖排。
    expect(ruleBody(mobile, '.dc-row')).toMatch(/flex-direction:\s*column/)
    expect(ruleBody(mobile, '.dc-foot')).toMatch(/margin-top:\s*auto/)
  })
})
