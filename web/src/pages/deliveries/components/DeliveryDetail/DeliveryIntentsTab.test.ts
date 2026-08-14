/*
 * DeliveryIntentsTab —— 关联意图列表 / 关联入口 / 解除关联。
 *
 * 最要紧的一条:第三列必须是「该意图对本交付的 PR 状态」。构造同一意图对两个交付
 * 各一条 PR、状态不同的场景,分别挂载两个交付的行数据,验证各自显示自己的那条。
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  AssociatedIntent,
  Delivery,
  Intent,
  IntentPr,
  IntentStatus,
} from '@ccc/shared/protocol'
import ConfirmDialog from '@/components/ConfirmDialog/ConfirmDialog.vue'
import DeliveryIntentsTab from './DeliveryIntentsTab.vue'

/** 意图七态,与 `IntentStatus` 同步 —— 少一态就少一条分色断言。 */
const INTENT_STATUSES: IntentStatus[] = [
  'draft',
  'todo',
  'in_progress',
  'done',
  'cancelled',
  'blocked',
  'failed',
]

function delivery(over: Partial<Delivery> = {}): Delivery {
  return {
    id: 'd1',
    workspaceName: 'w1',
    title: 'Sprint 3',
    description: '',
    status: 'integrating',
    startDate: null,
    endDate: null,
    branchName: 'delivery/sprint-3',
    baseBranch: 'main',
    branchReady: true,
    integration: { total: 1, merged: 0 },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function row(over: Partial<AssociatedIntent> = {}): AssociatedIntent {
  return {
    id: 'i1',
    title: 'Alpha',
    status: 'todo',
    prStatus: null,
    headBranch: null,
    prNumber: null,
    prUrl: null,
    ...over,
  }
}

function intent(over: Partial<Intent> = {}): Intent {
  return {
    id: 'i9',
    title: 'Free intent',
    status: 'todo',
    linkedDeliveries: [],
    prs: [],
    ...over,
  } as unknown as Intent
}

/** 一条 PR 台账行,只有 `status` 参与候选判定,其余字段填占位值。 */
function pr(over: Partial<IntentPr> = {}): IntentPr {
  return {
    id: 'pr-1',
    intentId: 'i9',
    deliveryId: null,
    forge: null,
    repo: null,
    number: '1',
    url: null,
    status: 'reviewing',
    headBranch: null,
    baseBranch: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

function mountTab(over: { rows?: AssociatedIntent[]; intents?: Intent[] } = {}) {
  return mount(DeliveryIntentsTab, {
    props: {
      delivery: delivery(),
      associatedIntents: over.rows ?? [],
      intents: over.intents ?? [],
    },
  })
}

describe('DeliveryIntentsTab', () => {
  it('renders the empty state when nothing is linked', () => {
    const w = mountTab()
    expect(w.find('[data-testid="delivery-intents-empty"]').exists()).toBe(true)
  })

  it('renders one row per linked intent', () => {
    const w = mountTab({ rows: [row(), row({ id: 'i2', title: 'Beta' })] })
    expect(w.find('[data-testid="delivery-intents-empty"]').exists()).toBe(false)
    expect(w.findAll('[data-testid^="delivery-intent-row-"]').length).toBe(2)
  })

  it('renders the title as a focusable button that emits open-intent with the row id', async () => {
    const w = mountTab({ rows: [row(), row({ id: 'i2', title: 'Beta' })] })
    const title = w.find('[data-testid="delivery-intent-title-i2"]')
    expect(title.exists()).toBe(true)
    expect(title.element.tagName).toBe('BUTTON')
    expect(title.attributes('type')).toBe('button')

    await title.trigger('click')
    expect(w.emitted('open-intent')).toEqual([['i2']])
  })

  it('clicking a non-title cell does not emit open-intent', async () => {
    const w = mountTab({ rows: [row({ prStatus: 'reviewing' })] })
    await w.find('[data-testid="delivery-intent-pr-i1"]').trigger('click')
    expect(w.emitted('open-intent')).toBeUndefined()
  })

  it('clicking the unlink button does not emit open-intent', async () => {
    const w = mountTab({ rows: [row({ prStatus: 'reviewing' })] })
    await w.find('[data-testid="delivery-intent-unlink-i1"]').trigger('click')
    expect(w.emitted('open-intent')).toBeUndefined()
    // 解除关联仍走既有 ConfirmDialog 流程,不因标题可点而改变。
    expect(w.findComponent(ConfirmDialog).props('open')).toBe(true)
  })

  it("shows THIS delivery's PR status — the same intent reads differently per delivery", () => {
    // One intent, two PRs against two different bases. Each delivery's own list
    // carries its own row; the tab must render exactly what it was handed.
    const towardD1 = mountTab({ rows: [row({ prStatus: 'merged', headBranch: 'feat/x' })] })
    const towardD2 = mountTab({ rows: [row({ prStatus: 'reviewing', headBranch: 'feat/x' })] })

    expect(towardD1.find('[data-testid="delivery-intent-pr-status-i1"]').classes()).toContain(
      'req-pr-status--merged',
    )
    expect(towardD2.find('[data-testid="delivery-intent-pr-status-i1"]').classes()).toContain(
      'req-pr-status--reviewing',
    )
    expect(towardD1.find('[data-testid="delivery-intent-pr-status-i1"]').classes()).not.toContain(
      'req-pr-status--reviewing',
    )
  })

  it('renders the PR number as a new-window forge link when the row carries a url', () => {
    const w = mountTab({
      rows: [
        row({ prStatus: 'reviewing', prNumber: '42', prUrl: 'https://forge.test/o/r/pull/42' }),
      ],
    })
    const link = w.find('[data-testid="delivery-intent-pr-link-i1"]')
    expect(link.element.tagName).toBe('A')
    expect(link.attributes('href')).toBe('https://forge.test/o/r/pull/42')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener noreferrer')
    expect(link.text()).toContain('#42')
    // 编号旁边仍有状态徽标,编号本身不承担状态语义。
    expect(w.find('[data-testid="delivery-intent-pr-status-i1"]').exists()).toBe(true)
  })

  it('renders the PR number as plain text when there is no url', () => {
    const w = mountTab({ rows: [row({ prStatus: 'reviewing', prNumber: '7', prUrl: null })] })
    expect(w.find('[data-testid="delivery-intent-pr-link-i1"]').exists()).toBe(false)
    const number = w.find('[data-testid="delivery-intent-pr-number-i1"]')
    expect(number.exists()).toBe(true)
    expect(number.text()).toContain('#7')
  })

  it('renders the no-PR placeholder — no number, no status badge — when the row has none', () => {
    const w = mountTab({ rows: [row()] })
    const cell = w.find('[data-testid="delivery-intent-pr-i1"]')
    expect(cell.exists()).toBe(true)
    expect(cell.text()).toBeTruthy()
    expect(w.find('[data-testid="delivery-intent-pr-status-i1"]').exists()).toBe(false)
    expect(w.find('[data-testid="delivery-intent-pr-link-i1"]').exists()).toBe(false)
    expect(w.find('[data-testid="delivery-intent-pr-number-i1"]').exists()).toBe(false)
  })

  it('colours the intent status badge per status, including blocked / failed', () => {
    for (const status of INTENT_STATUSES) {
      const w = mountTab({ rows: [row({ status })] })
      const badge = w.find('[data-testid="delivery-intent-status-i1"]')
      expect(badge.exists(), status).toBe(true)
      // 私有徽标类 + 状态值类:全局 .req-status 不参与,意图主列表样式不受牵动。
      expect(badge.classes(), status).toContain('delivery-intents-status')
      expect(badge.classes(), status).toContain(status)
      expect(badge.classes(), status).not.toContain('req-status')
    }
  })

  it('drops the unlink button entirely on a merged row and keeps it live otherwise', () => {
    const merged = mountTab({ rows: [row({ prStatus: 'merged' })] })
    expect(merged.find('[data-testid="delivery-intent-unlink-i1"]').exists()).toBe(false)

    const open = mountTab({ rows: [row({ prStatus: 'reviewing' })] })
    expect(open.find('[data-testid="delivery-intent-unlink-i1"]').exists()).toBe(true)
    expect(open.find('[data-testid="delivery-intent-unlink-i1"]').attributes('disabled')).toBe(
      undefined,
    )
  })

  it('asks for confirmation before emitting an unlink', async () => {
    const w = mountTab({ rows: [row({ prStatus: 'reviewing' })] })
    expect(w.findComponent(ConfirmDialog).props('open')).toBe(false)

    await w.find('[data-testid="delivery-intent-unlink-i1"]').trigger('click')
    expect(w.findComponent(ConfirmDialog).props('open')).toBe(true)
    expect(w.emitted('unlink')).toBeUndefined()

    w.findComponent(ConfirmDialog).vm.$emit('confirm')
    expect(w.emitted('unlink')).toEqual([['i1']])
  })

  it('cancelling the confirmation emits nothing', async () => {
    const w = mountTab({ rows: [row({ prStatus: 'reviewing' })] })
    await w.find('[data-testid="delivery-intent-unlink-i1"]').trigger('click')
    w.findComponent(ConfirmDialog).vm.$emit('cancel')
    await w.vm.$nextTick()
    expect(w.emitted('unlink')).toBeUndefined()
    expect(w.findComponent(ConfirmDialog).props('open')).toBe(false)
  })

  it('offers only intents that belong to NO delivery (no multi-delivery entry point)', async () => {
    const w = mountTab({
      intents: [
        intent({ id: 'free', title: 'Free' }),
        intent({ id: 'taken', title: 'Taken', linkedDeliveries: [{ id: 'dX', title: 'Other' }] }),
      ],
    })
    await w.find('[data-testid="delivery-intents-link"]').trigger('click')
    const options = w.findAll('[data-testid="delivery-intents-picker"] option')
    expect(options.map((o) => o.attributes('value'))).toEqual(['free'])

    await w.find('[data-testid="delivery-intents-link-confirm"]').trigger('click')
    expect(w.emitted('link')).toEqual([['free']])
  })

  it('drops cancelled intents from the picker — abandoned work is not delivery material', async () => {
    const w = mountTab({
      intents: [
        intent({ id: 'live', title: 'Live', status: 'todo' }),
        intent({ id: 'dead', title: 'Dead', status: 'cancelled' }),
      ],
    })
    await w.find('[data-testid="delivery-intents-link"]').trigger('click')
    const options = w.findAll('[data-testid="delivery-intents-picker"] option')
    expect(options.map((o) => o.attributes('value'))).toEqual(['live'])
  })

  it('drops intents carrying a merged PR — including one with no delivery binding', async () => {
    const w = mountTab({
      intents: [
        intent({ id: 'open', title: 'Open', prs: [pr({ status: 'reviewing' })] }),
        // 无交付归属的历史 PR 同样计入:改动已落地,再挂进一条新交付无从交付。
        intent({
          id: 'landed',
          title: 'Landed',
          prs: [pr({ status: 'merged', deliveryId: null })],
        }),
      ],
    })
    await w.find('[data-testid="delivery-intents-link"]').trigger('click')
    const options = w.findAll('[data-testid="delivery-intents-picker"] option')
    expect(options.map((o) => o.attributes('value'))).toEqual(['open'])
  })

  it('drops an intent whose PRs mix merged and reviewing — no aggregate ladder to hide behind', async () => {
    // deriveIntentPrAggregate 会把这组压成 `reviewing`;候选判定按单条 PR 字面
    // 取值,所以这条意图必须被排除。
    const w = mountTab({
      intents: [
        intent({
          id: 'mixed',
          title: 'Mixed',
          prs: [pr({ id: 'a', status: 'merged' }), pr({ id: 'b', status: 'reviewing' })],
        }),
      ],
    })
    await w.find('[data-testid="delivery-intents-link"]').trigger('click')
    expect(w.find('[data-testid="delivery-intents-picker-empty"]').exists()).toBe(true)
  })

  it('keeps intents whose PRs are closed / rejected / failed — they can still be re-opened', async () => {
    const w = mountTab({
      intents: [
        intent({ id: 'closed', title: 'Closed', prs: [pr({ status: 'closed' })] }),
        intent({ id: 'rejected', title: 'Rejected', prs: [pr({ status: 'rejected' })] }),
        intent({ id: 'failed', title: 'Failed', prs: [pr({ status: 'failed' })] }),
      ],
    })
    await w.find('[data-testid="delivery-intents-link"]').trigger('click')
    const options = w.findAll('[data-testid="delivery-intents-picker"] option')
    expect(options.map((o) => o.attributes('value'))).toEqual(['closed', 'rejected', 'failed'])
  })

  it('links an intent that is unlinked, not cancelled and free of merged PRs', async () => {
    const w = mountTab({ intents: [intent({ id: 'free', prs: [pr({ status: 'closed' })] })] })
    await w.find('[data-testid="delivery-intents-link"]').trigger('click')
    await w.find('[data-testid="delivery-intents-link-confirm"]').trigger('click')
    expect(w.emitted('link')).toEqual([['free']])
  })

  it('shows the picker empty state when every intent is linked, cancelled or merged', async () => {
    const w = mountTab({
      intents: [
        intent({ id: 'taken', linkedDeliveries: [{ id: 'dX', title: 'Other' }] }),
        intent({ id: 'dead', status: 'cancelled' }),
        intent({ id: 'landed', prs: [pr({ status: 'merged' })] }),
      ],
    })
    await w.find('[data-testid="delivery-intents-link"]').trigger('click')
    expect(w.find('[data-testid="delivery-intents-picker-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="delivery-intents-link-confirm"]').exists()).toBe(false)
  })
})

// ---- 意图状态徽标的配色契约 --------------------------------------------

// happy-dom 不计算样式,配色契约直接对组件源码里的 CSS 规则做断言(与
// DeliveryList / DeliveryDetail 同一范式)。
const tabSrc = readFileSync(
  resolve(
    process.cwd(),
    'web/src/pages/deliveries/components/DeliveryDetail/DeliveryIntentsTab.vue',
  ),
  'utf8',
)

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

describe('DeliveryIntentsTab.vue — 意图状态徽标配色契约', () => {
  it('七态各有一条配色规则且互不相同', () => {
    const bodies = INTENT_STATUSES.map((s) => {
      const body = ruleBody(tabSrc, `.delivery-intents-status.${s}`)
      expect(body, s).toMatch(/color:/)
      expect(body, s).toMatch(/background:/)
      return body.replace(/\s+/g, '')
    })
    expect(new Set(bodies).size).toBe(INTENT_STATUSES.length)
  })

  it('徽标是组件私有 pill,不改写全局 .req-status', () => {
    const base = ruleBody(tabSrc, '.delivery-intents-status')
    expect(base).toMatch(/font-size:\s*var\(--fs-badge\)/)
    expect(base).toMatch(/border-radius:\s*var\(--radius-pill\)/)
    // 组件内没有任何 .req-status 规则:全局那份归意图主列表/详情,本轮不动。
    expect(ruleBody(tabSrc, '.req-status')).toBe('')
  })
})
