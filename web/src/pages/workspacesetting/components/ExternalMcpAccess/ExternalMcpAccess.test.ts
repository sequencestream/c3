/**
 * The seventh workspace-settings tab, now a read-only answer to "who can reach
 * this workspace".
 *
 * Most of what is asserted here is ABSENCE: no create, reset, revoke, tool-scope
 * or Save control. The tab used to administer credentials, so leaving one behind
 * would be worse than never having moved them — it would look like the authority
 * still lives here.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ExternalMcpAccess from './ExternalMcpAccess.vue'

const WORKSPACE = 'ws-1'

function render(props: Record<string, unknown> = {}) {
  return mount(ExternalMcpAccess, {
    props: { workspaceName: WORKSPACE, accessors: ['root', 'alice'], isAdmin: true, ...props },
  })
}

describe('the effective accessor list', () => {
  it('lists every subject the server resolved, in the order it sent them', () => {
    const w = render()
    const rows = w.findAll('[data-testid="workspace-external-mcp-accessor"]')
    expect(rows.map((r) => r.text())).toEqual(['root', 'alice'])
  })

  it('tells "not loaded yet" apart from "nobody can reach it"', () => {
    const loading = render({ accessors: null })
    expect(loading.find('[data-testid="workspace-external-mcp-loading"]').exists()).toBe(true)
    expect(loading.find('[data-testid="workspace-external-mcp-empty"]').exists()).toBe(false)

    const empty = render({ accessors: [] })
    expect(empty.find('[data-testid="workspace-external-mcp-empty"]').exists()).toBe(true)
    expect(empty.find('[data-testid="workspace-external-mcp-loading"]').exists()).toBe(false)
    expect(empty.findAll('[data-testid="workspace-external-mcp-accessor"]')).toHaveLength(0)
  })

  it('asks the parent to re-read the list rather than deriving one locally', async () => {
    const w = render()
    await w.get('[data-testid="workspace-external-mcp-reload"]').trigger('click')
    expect(w.emitted('reload')).toHaveLength(1)
  })
})

describe('what the tab deliberately no longer offers', () => {
  it('has no key lifecycle, tool-scope or Save control at all', () => {
    const w = render()
    for (const testid of [
      'workspace-external-mcp-create-open',
      'workspace-external-mcp-create-form',
      'workspace-external-mcp-create-submit',
      'workspace-external-mcp-edit',
      'workspace-external-mcp-edit-form',
      'workspace-external-mcp-edit-save',
      'workspace-external-mcp-revoke',
      'workspace-external-mcp-reveal',
      'workspace-external-mcp-plaintext',
      'workspace-external-mcp-key-row',
    ]) {
      expect(w.find(`[data-testid="${testid}"]`).exists()).toBe(false)
    }
    // No plain <input> either: nothing on this tab is editable.
    expect(w.findAll('input')).toHaveLength(0)
  })

  it('points the administrator at where access is actually edited', async () => {
    const w = render()
    await w.get('[data-testid="workspace-external-mcp-goto"]').trigger('click')
    expect(w.emitted('gotoSystemSettings')).toHaveLength(1)
  })

  it('offers no such jump to a non-admin, who could not use it', () => {
    const w = render({ isAdmin: false })
    expect(w.find('[data-testid="workspace-external-mcp-goto"]').exists()).toBe(false)
    // The list itself is still shown — it is not a secret from someone who is
    // already inside this workspace.
    expect(w.findAll('[data-testid="workspace-external-mcp-accessor"]')).toHaveLength(2)
  })
})
