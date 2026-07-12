import { describe, it, expect } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import type { AgentConfig } from '@ccc/shared/protocol'
import AutomationImportDialog from './AutomationImportDialog.vue'

const AGENTS = [
  { id: 'claude-1', vendor: 'claude', configMode: 'system', displayName: 'C', enabled: true },
] as unknown as AgentConfig[]

function mountDialog(agents = AGENTS) {
  return mount(AutomationImportDialog, {
    props: { open: true, agents, workspacePath: '/home/proj' },
    attachTo: document.body,
  })
}

// Simulate choosing a file with the given text content.
async function chooseFile(w: VueWrapper, text: string): Promise<void> {
  const file = new File([text], 'import.json', { type: 'application/json' })
  const input = w.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await flushPromises()
}

const validFile = (automations: unknown[]) => JSON.stringify({ version: 1, automations })

describe('AutomationImportDialog.vue', () => {
  it('shows an i18n error for invalid JSON and never enters the review state', async () => {
    const w = mountDialog()
    await chooseFile(w, '{not json')
    expect(w.find('.ie-error').exists()).toBe(true)
    expect(w.find('.ie-list').exists()).toBe(false)
  })

  it('shows an i18n error for the wrong version', async () => {
    const w = mountDialog()
    await chooseFile(w, JSON.stringify({ version: 2, automations: [] }))
    expect(w.find('.ie-error').exists()).toBe(true)
  })

  it('lists file automations, default-selects them, and confirm emits the mapped inputs', async () => {
    const w = mountDialog()
    await chooseFile(
      w,
      validFile([
        { type: 'command', config: { command: 'echo a', name: 'A' }, cronExpression: '0 0 * * *' },
        { type: 'command', config: { command: 'echo b', name: 'B' } },
      ]),
    )
    const rows = w.findAll('.ie-list .ie-row')
    expect(rows).toHaveLength(2)
    const checks = w.findAll<HTMLInputElement>('.ie-list input[type="checkbox"]')
    expect(checks.every((c) => (c.element as HTMLInputElement).checked)).toBe(true)

    await w.find('.ie-btn-primary').trigger('click')
    const emitted = w.emitted('confirm')
    expect(emitted).toHaveLength(1)
    const inputs = emitted![0][0] as Array<Record<string, unknown>>
    expect(inputs).toHaveLength(2)
    // Every mapped input is paused and owned by the current workspace.
    expect(inputs.every((i) => i.initialStatus === 'paused')).toBe(true)
    expect(inputs.every((i) => i.workspaceId === '/home/proj')).toBe(true)
    expect(inputs[0].initialName).toBe('A')
  })

  it('deselecting a row narrows the imported set', async () => {
    const w = mountDialog()
    await chooseFile(
      w,
      validFile([
        { type: 'command', config: { command: 'a', name: 'A' } },
        { type: 'command', config: { command: 'b', name: 'B' } },
      ]),
    )
    await w.findAll('.ie-list input[type="checkbox"]')[0].setValue(false)
    await w.find('.ie-btn-primary').trigger('click')
    const inputs = w.emitted('confirm')![0][0] as Array<Record<string, unknown>>
    expect(inputs).toHaveLength(1)
    expect(inputs[0].initialName).toBe('B')
  })

  it('shows an empty state for a valid file with no automations', async () => {
    const w = mountDialog()
    await chooseFile(w, validFile([]))
    expect(w.find('.ie-empty').exists()).toBe(true)
    // No confirm button in an empty review.
    expect(w.find('.ie-btn-primary').exists()).toBe(false)
  })

  it('blocks an llm item with no compatible agent and excludes it from the import', async () => {
    const w = mountDialog([])
    await chooseFile(
      w,
      validFile([{ type: 'llm', vendor: 'claude', config: { prompt: 'do', name: 'LLM' } }]),
    )
    const blocked = w.find('.ie-row-blocked')
    expect(blocked.exists()).toBe(true)
    // Its checkbox is disabled, and confirm is disabled (nothing importable selected).
    expect(blocked.find('input[type="checkbox"]').attributes('disabled')).toBeDefined()
    expect(w.find('.ie-btn-primary').attributes('disabled')).toBeDefined()
  })

  it('confirm is guarded against double submission', async () => {
    const w = mountDialog()
    await chooseFile(w, validFile([{ type: 'command', config: { command: 'a', name: 'A' } }]))
    await w.find('.ie-btn-primary').trigger('click')
    await w.find('.ie-btn-primary').trigger('click')
    expect(w.emitted('confirm')).toHaveLength(1)
  })
})
