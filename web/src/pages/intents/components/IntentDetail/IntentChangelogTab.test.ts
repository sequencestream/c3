import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { IntentLog } from '@ccc/shared/protocol'
import IntentChangelogTab from './IntentChangelogTab.vue'

function log(over: Partial<IntentLog> & { id: string }): IntentLog {
  return {
    intentId: 'i1',
    operationType: 'status_changed',
    summary: 'Moved to todo',
    actor: 'alice',
    createdAt: 1,
    ...over,
    id: over.id,
  }
}

function mountLogs(intentLogs: IntentLog[], intentLogsLoading = false) {
  return mount(IntentChangelogTab, { props: { intentLogs, intentLogsLoading } })
}

describe('IntentChangelogTab.vue', () => {
  it('renders the loading placeholder only while empty and loading', () => {
    const w = mountLogs([], true)
    expect(w.find('.intent-detail-empty').text()).toBeTruthy()
    expect(w.find('[data-testid="intent-detail-changelog-list"]').exists()).toBe(false)
  })

  it('renders the empty placeholder when there are no logs', () => {
    const w = mountLogs([])
    expect(w.find('[data-testid="intent-detail-changelog-empty"]').exists()).toBe(true)
  })

  it('renders one localized row per log with summary and actor', () => {
    const w = mountLogs([
      log({ id: '1', operationType: 'spec_approved', summary: 'Approved', actor: 'bob' }),
      log({ id: '2', operationType: 'pr_created', summary: 'PR #4', actor: 'carol' }),
    ])
    const rows = w.findAll('.req-changelog-row')
    expect(rows).toHaveLength(2)
    expect(rows[0].find('.req-changelog-op').text()).toBeTruthy()
    expect(rows[0].text()).toContain('Approved')
    expect(rows[0].text()).toContain('bob')
    expect(rows[1].find('.req-changelog-op').classes()).toContain('req-changelog-op--pr_created')
  })
})
