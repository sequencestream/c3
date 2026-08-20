/**
 * The shared tool permission grid. Both the automation form and the chat-robot
 * form configure an UNATTENDED run with the same question — which tools may the
 * run use — so the grid's contract (and the fact that `network-access` is a
 * capability marker kept OUT of the checklist) is pinned here directly, not just
 * through one form's test.
 *
 * Assertions key off data-testid / emitted values / structure, never visible
 * copy (see i18n-spec §4), so these stay green regardless of locale.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { NETWORK_ACCESS_TOOL } from '@ccc/shared/protocol'
import type { ToolManifestEntry } from '@ccc/shared/protocol'
import ToolPermissionGrid from './ToolPermissionGrid.vue'

const READ_TOOLS: ToolManifestEntry[] = [
  { name: 'Read', isWrite: false },
  { name: 'Grep', isWrite: false },
]
const WRITE_TOOLS: ToolManifestEntry[] = [
  { name: 'Write', isWrite: true },
  { name: 'Edit', isWrite: true },
]
const ALL_TOOLS = [...READ_TOOLS, ...WRITE_TOOLS]

function mountGrid(
  over: Partial<{
    tools: ToolManifestEntry[]
    modelValue: string[]
    loading: boolean
    error: string | null
    showNetworkAccess: boolean
    networkAccessBlocked: boolean
  }> = {},
) {
  return mount(ToolPermissionGrid, {
    props: {
      tools: ALL_TOOLS,
      modelValue: [],
      loading: false,
      error: null,
      showNetworkAccess: false,
      networkAccessBlocked: false,
      ...over,
    },
  })
}

/** The emitted allowlist of the last `update:modelValue` (or [] if none). */
function lastValue(wrapper: ReturnType<typeof mountGrid>): string[] {
  const emitted = wrapper.emitted('update:modelValue')
  return (emitted?.[emitted.length - 1]?.[0] ?? []) as string[]
}

function toolCheckbox(wrapper: ReturnType<typeof mountGrid>, name: string) {
  return wrapper.get(`[data-testid="tool-${name}"]`)
}

describe('ToolPermissionGrid — read/write split', () => {
  it('renders the read-only group then the write group, each with its own tools', () => {
    const w = mountGrid()
    const groupLabels = w.findAll('.sf-tools-subtitle')
    expect(groupLabels).toHaveLength(2)
    const [readGroup, writeGroup] = w.findAll('.sf-tools-group')

    const readNames = readGroup.findAll('.sf-tool-item').map((item) => item.text())
    expect(readNames).toEqual(['Read', 'Grep'])

    const writeNames = writeGroup.findAll('.sf-tool-item').map((item) => item.text())
    expect(writeNames).toEqual(['Write', 'Edit'])
  })

  it('ticks exactly the tools present in modelValue', () => {
    const w = mountGrid({ modelValue: ['Read', 'Write'] })
    expect((toolCheckbox(w, 'Read').element as HTMLInputElement).checked).toBe(true)
    expect((toolCheckbox(w, 'Grep').element as HTMLInputElement).checked).toBe(false)
    expect((toolCheckbox(w, 'Write').element as HTMLInputElement).checked).toBe(true)
    expect((toolCheckbox(w, 'Edit').element as HTMLInputElement).checked).toBe(false)
  })
})

describe('ToolPermissionGrid — loading / error / empty', () => {
  it('loading hides the list but keeps the actions row', () => {
    const w = mountGrid({ loading: true })
    expect(w.findAll('.sf-tools-grid')).toHaveLength(0)
    expect(w.findAll('[data-testid^="tool-"]')).toHaveLength(0)
    // select-all / clear-all stay visible while tools exist.
    expect(w.find('[data-testid="tools-select-all"]').exists()).toBe(true)
  })

  it('a load failure is shown and the list is hidden', () => {
    const w = mountGrid({ error: 'boom' })
    expect(w.text()).toContain('boom')
    expect(w.findAll('.sf-tools-grid')).toHaveLength(0)
    expect(w.findAll('[data-testid^="tool-"]')).toHaveLength(0)
  })

  it('an empty manifest shows the empty state and no controls at all', () => {
    const w = mountGrid({ tools: [] })
    expect(w.findAll('.sf-tools-grid')).toHaveLength(0)
    expect(w.findAll('[data-testid^="tool-"]')).toHaveLength(0)
    expect(w.findAll('.sf-tools-btn')).toHaveLength(0)
  })
})

describe('ToolPermissionGrid — selection operations', () => {
  it('toggling a tool emits the allowlist with it added', async () => {
    const w = mountGrid({ modelValue: ['Read'] })
    await toolCheckbox(w, 'Write').trigger('change')
    expect(lastValue(w)).toEqual(['Read', 'Write'])
  })

  it('toggling a ticked tool emits the allowlist without it', async () => {
    const w = mountGrid({ modelValue: ['Read', 'Grep'] })
    await toolCheckbox(w, 'Read').trigger('change')
    expect(lastValue(w)).toEqual(['Grep'])
  })

  it('select-all emits every real tool', async () => {
    const w = mountGrid({ modelValue: ['Read'] })
    await w.get('[data-testid="tools-select-all"]').trigger('click')
    expect(lastValue(w)).toEqual(['Read', 'Grep', 'Write', 'Edit'])
  })

  it('clear-all emits an empty allowlist', async () => {
    const w = mountGrid({ modelValue: ['Read', 'Write'] })
    await w.get('[data-testid="tools-clear-all"]').trigger('click')
    expect(lastValue(w)).toEqual([])
  })
})

describe('ToolPermissionGrid — network-access marker', () => {
  it('never renders the marker as a tool checkbox', () => {
    const w = mountGrid({ modelValue: [NETWORK_ACCESS_TOOL] })
    expect(w.find('[data-testid="tool-network-access"]').exists()).toBe(false)
    // Only the four real tools appear in the checklist.
    expect(w.findAll('[data-testid^="tool-"]')).toHaveLength(4)
  })

  it('is hidden unless the vendor exposes a network panel', () => {
    const w = mountGrid()
    expect(w.find('[data-testid="network-access"]').exists()).toBe(false)
  })

  it('renders when showNetworkAccess is set and toggling emits the marker', async () => {
    const w = mountGrid({ showNetworkAccess: true })
    const section = w.get('[data-testid="network-access"]')
    expect(w.find('[data-testid="network-access"]').exists()).toBe(true)
    await section.get('[data-testid="network-access-checkbox"]').trigger('change')
    expect(lastValue(w)).toEqual([NETWORK_ACCESS_TOOL])
  })

  it('a stored marker is read back as checked', () => {
    const w = mountGrid({ showNetworkAccess: true, modelValue: [NETWORK_ACCESS_TOOL] })
    expect(
      (w.get('[data-testid="network-access-checkbox"]').element as HTMLInputElement).checked,
    ).toBe(true)
  })

  it('select-all preserves an already-open marker', async () => {
    const w = mountGrid({ modelValue: ['Read', NETWORK_ACCESS_TOOL] })
    await w.get('[data-testid="tools-select-all"]').trigger('click')
    expect(lastValue(w)).toEqual(['Read', 'Grep', 'Write', 'Edit', NETWORK_ACCESS_TOOL])
  })

  it('clear-all preserves an already-open marker', async () => {
    const w = mountGrid({ modelValue: ['Read', 'Write', NETWORK_ACCESS_TOOL] })
    await w.get('[data-testid="tools-clear-all"]').trigger('click')
    expect(lastValue(w)).toEqual([NETWORK_ACCESS_TOOL])
  })

  it('a blocked sandbox disables the switch and its click emits nothing', async () => {
    const w = mountGrid({
      showNetworkAccess: true,
      networkAccessBlocked: true,
      modelValue: [],
    })
    const cb = w.get('[data-testid="network-access-checkbox"]')
    expect((cb.element as HTMLInputElement).disabled).toBe(true)
    // The read-only hint explains why the switch is inert.
    expect(w.find('[data-testid="network-access-readonly-hint"]').exists()).toBe(true)
    await cb.trigger('change')
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })
})
