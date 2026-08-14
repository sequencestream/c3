import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ExternalMcpToolDescriptor, McpApiKeyMeta } from '@ccc/shared/protocol'
import ExternalMcpAccess from './ExternalMcpAccess.vue'

const WORKSPACE_ID = 'ws-1'

const CATALOG: ExternalMcpToolDescriptor[] = [
  { name: 'find_intents', access: 'read' },
  { name: 'view_intent', access: 'read' },
  { name: 'find_discussions', access: 'read' },
  { name: 'view_discussion', access: 'read' },
  { name: 'publish_event', access: 'read' },
  { name: 'save_intents', access: 'write' },
  { name: 'submit_spec_review', access: 'write' },
]

const READ_ONLY = CATALOG.filter((t) => t.access === 'read').map((t) => t.name)

function key(over: Partial<McpApiKeyMeta> = {}): McpApiKeyMeta {
  return {
    id: 'key-1',
    name: 'release-bot',
    createdAt: 1,
    lastUsedAt: null,
    workspaceName: WORKSPACE_ID,
    unavailable: false,
    tools: [...READ_ONLY],
    displayPrefix: 'c3k_key-1',
    ...over,
  }
}

function render(props: Record<string, unknown> = {}) {
  return mount(ExternalMcpAccess, {
    props: {
      baseUrl: 'http://192.168.1.10:3000',
      workspaceName: WORKSPACE_ID,
      mcpApiKeys: [key()],
      catalog: CATALOG,
      isAdmin: true,
      ...props,
    },
  })
}

const writeText = vi.fn()

beforeEach(() => {
  writeText.mockReset()
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  })
})

describe('the created-key reveal', () => {
  const created = { meta: key({ id: 'key-new', name: 'ci' }), key: 'c3k_key-new_TOP-SECRET' }

  it('reveals the plaintext key once, alongside the credential-free endpoint', () => {
    const w = render({ created })
    expect(w.get('[data-testid="workspace-external-mcp-plaintext"]').text()).toBe(created.key)
    const url = w.get('[data-testid="workspace-external-mcp-url"]').text()
    expect(url).toBe('http://192.168.1.10:3000/mcp')
    // The address is the same for every key: it carries no credential at all.
    expect(url).not.toContain(created.key)
  })

  it('offers a one-line command that references the key indirectly', () => {
    const w = render({ created })
    const cmd = w.get('[data-testid="workspace-external-mcp-command"]').text()
    expect(cmd).toContain('claude mcp add')
    expect(cmd).toContain('http://192.168.1.10:3000/mcp')
    expect(cmd).toContain('Authorization: Bearer $C3_MCP_KEY')
    expect(cmd).toContain(`X-C3-Workspace: ${WORKSPACE_ID}`)
    // The plaintext is one copy button away; it does not also go into shell history.
    expect(cmd).not.toContain(created.key)
  })

  it('copies the plaintext key and reports it', async () => {
    const w = render({ created })
    await w.get('[data-testid="workspace-external-mcp-copy-key"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(created.key)
    expect(w.get('[data-testid="workspace-external-mcp-copy-key"]').text()).toContain('Copied')
  })

  it('dismisses the reveal — the plaintext never appears again', async () => {
    const w = render({ created })
    await w.get('[data-testid="workspace-external-mcp-dismiss"]').trigger('click')
    expect(w.emitted('dismissReveal')).toHaveLength(1)
  })

  it('still shows the plaintext when the base URL is unconfigured, but no address', () => {
    const w = render({ created, baseUrl: '' })
    expect(w.get('[data-testid="workspace-external-mcp-plaintext"]').text()).toBe(created.key)
    expect(w.find('[data-testid="workspace-external-mcp-url"]').exists()).toBe(false)
    expect(w.find('[data-testid="workspace-external-mcp-no-base-url"]').exists()).toBe(true)
  })
})

describe('the key roster', () => {
  it('lists metadata only — name, prefix, scope summary, timestamps — never a secret', () => {
    const w = render()
    expect(w.findAll('[data-testid="workspace-external-mcp-key-row"]')).toHaveLength(1)
    expect(w.get('[data-testid="workspace-external-mcp-key-prefix"]').text()).toContain('c3k_key-1')
    expect(w.get('[data-testid="workspace-external-mcp-key-tools"]').text()).toContain('5')
    expect(w.text()).not.toContain('SECRET')
    expect(w.text()).not.toContain('salt')
  })

  it('emits a create for this workspace, and only with a name', async () => {
    const w = render({ mcpApiKeys: [] })
    await w.get('[data-testid="workspace-external-mcp-create-open"]').trigger('click')
    expect(
      w.get('[data-testid="workspace-external-mcp-create-submit"]').attributes('disabled'),
    ).toBeDefined()
    await w.get('[data-testid="workspace-external-mcp-new-name"]').setValue('ci bot')
    await w.get('[data-testid="workspace-external-mcp-create-submit"]').trigger('click')
    expect(w.emitted('create')).toEqual([[{ name: 'ci bot' }]])
  })

  it('edits the tool scope with read and write groups, and confirms a write grant', async () => {
    const w = render()
    await w.get('[data-testid="workspace-external-mcp-edit"]').trigger('click')
    expect(w.find('[data-testid="workspace-external-mcp-edit-form"]').exists()).toBe(true)

    // Tick a write tool.
    const writeBox = w
      .findAll('input[type="checkbox"]')
      .find((el) => el.attributes('value') === 'save_intents')!
    await writeBox.setValue(true)

    await w.get('[data-testid="workspace-external-mcp-edit-save"]').trigger('click')
    // A write grant is not saved without the risk confirmation.
    expect(w.emitted('updateTools')).toBeUndefined()
    expect(w.findComponent({ name: 'ConfirmDialog' }).props('open')).toBe(true)

    w.findComponent({ name: 'ConfirmDialog' }).vm.$emit('confirm')
    await w.vm.$nextTick()
    expect(w.emitted('updateTools')).toEqual([
      [{ id: 'key-1', tools: [...READ_ONLY, 'save_intents'] }],
    ])
  })

  it('saves a read-only scope edit without confirmation', async () => {
    const w = render()
    await w.get('[data-testid="workspace-external-mcp-edit"]').trigger('click')
    // Untick one read tool.
    const readBox = w
      .findAll('input[type="checkbox"]')
      .find((el) => el.attributes('value') === 'view_intent')!
    await readBox.setValue(false)
    await w.get('[data-testid="workspace-external-mcp-edit-save"]').trigger('click')
    expect(w.emitted('updateTools')).toEqual([
      [{ id: 'key-1', tools: READ_ONLY.filter((n) => n !== 'view_intent') }],
    ])
  })

  it('marks an unavailable key (workspace gone) as revoke-only', () => {
    const w = render({ mcpApiKeys: [key({ unavailable: true })] })
    expect(w.find('[data-testid="workspace-external-mcp-unavailable"]').exists()).toBe(true)
    expect(
      w.get('[data-testid="workspace-external-mcp-edit"]').attributes('disabled'),
    ).toBeDefined()
    expect(
      w.get('[data-testid="workspace-external-mcp-revoke"]').attributes('disabled'),
    ).toBeUndefined()
  })

  it('confirms a revoke before emitting it', async () => {
    const w = render()
    await w.get('[data-testid="workspace-external-mcp-revoke"]').trigger('click')
    expect(w.emitted('revoke')).toBeUndefined()
    // Two ConfirmDialogs are mounted: the write-grant one first, the revoke one second.
    const dialogs = w.findAllComponents({ name: 'ConfirmDialog' })
    expect(dialogs).toHaveLength(2)
    dialogs[1].vm.$emit('confirm')
    await w.vm.$nextTick()
    expect(w.emitted('revoke')).toEqual([['key-1']])
  })

  it('disables every mutation for a non-admin, while still showing the roster', () => {
    const w = render({ isAdmin: false })
    expect(
      w.get('[data-testid="workspace-external-mcp-create-open"]').attributes('disabled'),
    ).toBeDefined()
    expect(
      w.get('[data-testid="workspace-external-mcp-revoke"]').attributes('disabled'),
    ).toBeDefined()
  })
})

describe('guidance when something is missing', () => {
  it('says the base URL is unconfigured and offers the jump to system settings', async () => {
    const w = render({ baseUrl: '' })
    expect(w.find('[data-testid="workspace-external-mcp-no-base-url"]').exists()).toBe(true)
    await w.get('[data-testid="workspace-external-mcp-no-base-url"] button').trigger('click')
    expect(w.emitted('gotoSystemSettings')).toHaveLength(1)
  })

  it('explains when the workspace has no key yet', () => {
    const w = render({ mcpApiKeys: [] })
    expect(w.find('[data-testid="workspace-external-mcp-empty"]').exists()).toBe(true)
  })
})
