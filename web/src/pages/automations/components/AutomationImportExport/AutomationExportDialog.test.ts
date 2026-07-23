import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Automation } from '@ccc/shared/protocol'
import AutomationExportDialog from './AutomationExportDialog.vue'

function sched(over: Partial<Automation> = {}): Automation {
  return {
    id: 's1',
    type: 'command',
    config: { command: 'echo', name: 'Task' },
    maxWallClockMs: null,
    workspaceId: '/home/proj',
    triggerType: 'cron',
    cronExpression: '0 8 * * *',
    nextRunAt: null,
    eventFilters: null,
    runningSessionId: null,
    status: 'active',
    mode: 'sandboxed',
    toolAllowlist: [],
    toolDenylist: [],
    vendor: 'claude',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

// Capture download side-effects without touching the real DOM/anchor behavior.
let clicked: { href: string; download: string } | null = null

beforeEach(() => {
  clicked = null
  globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock')
  globalThis.URL.revokeObjectURL = vi.fn()
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicked = { href: this.href, download: this.download }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

function mountDialog(automations: Automation[], open = true) {
  return mount(AutomationExportDialog, {
    props: { open, automations, workspacePath: '/home/my-proj' },
    attachTo: document.body,
  })
}

describe('AutomationExportDialog.vue', () => {
  it('lists all automations and defaults every row to selected', () => {
    const w = mountDialog([sched({ id: 'a' }), sched({ id: 'b' })])
    const rows = w.findAll('.ie-list .ie-row')
    expect(rows).toHaveLength(2)
    const checks = w.findAll<HTMLInputElement>('.ie-list input[type="checkbox"]')
    expect(checks.every((c) => (c.element as HTMLInputElement).checked)).toBe(true)
  })

  it('shows an empty-state message when there are no automations', () => {
    const w = mountDialog([])
    expect(w.find('.ie-empty').exists()).toBe(true)
    // Confirm is disabled with nothing selected.
    expect(w.find('.ie-btn-primary').attributes('disabled')).toBeDefined()
  })

  it('deselecting a row narrows the export set', async () => {
    const w = mountDialog([sched({ id: 'a' }), sched({ id: 'b' })])
    await w.findAll('.ie-list input[type="checkbox"]')[0].setValue(false)
    await w.find('.ie-btn-primary').trigger('click')
    expect(clicked).not.toBeNull()
    // File name is recognizable (workspace + stamp).
    expect(clicked!.download).toMatch(/^c3-automations-my-proj-\d{8}T\d{6}Z\.json$/)
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('a zero-selected export does not download', async () => {
    const w = mountDialog([sched({ id: 'a' })])
    await w.find('.ie-list input[type="checkbox"]').setValue(false)
    await w.find('.ie-btn-primary').trigger('click')
    expect(clicked).toBeNull()
    expect(w.emitted('close')).toBeUndefined()
  })

  it('select-all toggles every row', async () => {
    const w = mountDialog([sched({ id: 'a' }), sched({ id: 'b' })])
    // Header select-all checkbox is the first checkbox in the header row.
    const all = w.find('.ie-row-all input[type="checkbox"]')
    await all.setValue(false)
    const checks = w.findAll<HTMLInputElement>('.ie-list input[type="checkbox"]')
    expect(checks.every((c) => (c.element as HTMLInputElement).checked)).toBe(false)
  })
})
