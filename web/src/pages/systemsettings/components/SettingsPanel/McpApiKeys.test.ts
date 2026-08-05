import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { McpApiKeyMeta, WorkspaceInfo } from '@ccc/shared/protocol'
import McpApiKeys from './McpApiKeys.vue'

const WORKSPACES: WorkspaceInfo[] = [
  { id: 'ws-a', name: 'alpha', path: '/p/alpha', lastAccessed: 2 },
  { id: 'ws-b', name: 'beta', path: '/p/beta', lastAccessed: 1 },
]

function key(over: Partial<McpApiKeyMeta> = {}): McpApiKeyMeta {
  return {
    id: 'key-1',
    name: 'release-bot',
    createdAt: 1_700_000_000_000,
    lastUsedAt: null,
    workspaceIds: ['ws-a'],
    staleWorkspaces: [],
    displayPrefix: 'c3k_key-1',
    ...over,
  }
}

function render(props: Partial<InstanceType<typeof McpApiKeys>['$props']> = {}) {
  return mount(McpApiKeys, {
    props: { keys: [], created: null, workspaces: WORKSPACES, isAdmin: true, ...props },
  })
}

const writeText = vi.fn()

beforeEach(() => {
  writeText.mockReset()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

describe('the roster', () => {
  it('says so plainly when there are no keys', () => {
    expect(render().find('[data-testid="settings-mcp-key-empty"]').exists()).toBe(true)
  })

  it('shows the non-secret prefix, never anything derived from the secret', () => {
    const w = render({ keys: [key()] })
    expect(w.get('[data-testid="settings-mcp-key-prefix"]').text()).toContain('c3k_key-1')
  })

  it('names the granted workspaces rather than their opaque ids', () => {
    const w = render({ keys: [key({ workspaceIds: ['ws-a', 'ws-b'] })] })
    const text = w.get('[data-testid="settings-mcp-key-grant"]').text()
    expect(text).toContain('alpha')
    expect(text).toContain('beta')
    expect(text).not.toContain('ws-a')
  })

  it('flags a grant whose workspace c3 no longer has', () => {
    const w = render({ keys: [key({ staleWorkspaces: ['/p/removed'] })] })
    expect(w.get('[data-testid="settings-mcp-key-stale"]').text()).toContain('/p/removed')
  })

  it('does not render the stale line when there is nothing stale', () => {
    expect(
      render({ keys: [key()] })
        .find('[data-testid="settings-mcp-key-stale"]')
        .exists(),
    ).toBe(false)
  })
})

describe('generating a key', () => {
  it('requires both a name and at least one workspace before it can be submitted', async () => {
    const w = render()
    await w.get('[data-testid="settings-mcp-key-create-open"]').trigger('click')
    const submit = w.get('[data-testid="settings-mcp-key-create-submit"]')
    expect(submit.attributes('disabled')).toBeDefined()

    await w.get('[data-testid="settings-mcp-key-new-name"]').setValue('ci')
    expect(submit.attributes('disabled')).toBeDefined()

    await w
      .findAll('[data-testid="settings-mcp-key-create-form"] input[type="checkbox"]')[0]
      .setValue(true)
    expect(submit.attributes('disabled')).toBeUndefined()
  })

  it('emits the trimmed name and the chosen workspace ids', async () => {
    const w = render()
    await w.get('[data-testid="settings-mcp-key-create-open"]').trigger('click')
    await w.get('[data-testid="settings-mcp-key-new-name"]').setValue('  ci  ')
    await w
      .findAll('[data-testid="settings-mcp-key-create-form"] input[type="checkbox"]')[1]
      .setValue(true)
    await w.get('[data-testid="settings-mcp-key-create-submit"]').trigger('click')

    expect(w.emitted('create')).toEqual([[{ name: 'ci', workspaceIds: ['ws-b'] }]])
  })

  it('warns when c3 has no workspace to grant at all', async () => {
    const w = render({ workspaces: [] })
    await w.get('[data-testid="settings-mcp-key-create-open"]').trigger('click')
    expect(w.find('[data-testid="settings-mcp-key-no-workspaces"]').exists()).toBe(true)
  })
})

describe('the one-time plaintext reveal', () => {
  const created = { meta: key(), key: 'c3k_key-1_SECRET-VALUE' }

  it('shows the plaintext only when a key was just created', () => {
    expect(render().find('[data-testid="settings-mcp-key-reveal"]').exists()).toBe(false)
    const w = render({ created })
    expect(w.get('[data-testid="settings-mcp-key-plaintext"]').text()).toBe(
      'c3k_key-1_SECRET-VALUE',
    )
  })

  it('copies the plaintext and reports it', async () => {
    const w = render({ created })
    await w.get('[data-testid="settings-mcp-key-copy"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith('c3k_key-1_SECRET-VALUE')
  })

  it('asks the parent to drop it — the component never keeps its own copy', async () => {
    const w = render({ created })
    await w.get('[data-testid="settings-mcp-key-dismiss"]').trigger('click')
    expect(w.emitted('dismissReveal')).toHaveLength(1)

    // The parent clearing `created` is what removes it; nothing lingers locally.
    await w.setProps({ created: null })
    expect(w.find('[data-testid="settings-mcp-key-plaintext"]').exists()).toBe(false)
  })

  it('never shows a plaintext for a key that is merely listed', () => {
    const w = render({ keys: [key()] })
    expect(w.html()).not.toContain('SECRET-VALUE')
  })
})

describe('editing the authorized workspaces', () => {
  it('seeds the checkboxes from the key’s current grant', async () => {
    const w = render({ keys: [key({ workspaceIds: ['ws-b'] })] })
    await w.get('[data-testid="settings-mcp-key-edit"]').trigger('click')
    const boxes = w.findAll('[data-testid="settings-mcp-key-edit-form"] input[type="checkbox"]')
    expect((boxes[0].element as HTMLInputElement).checked).toBe(false)
    expect((boxes[1].element as HTMLInputElement).checked).toBe(true)
  })

  it('emits the replacement set', async () => {
    const w = render({ keys: [key()] })
    await w.get('[data-testid="settings-mcp-key-edit"]').trigger('click')
    const boxes = w.findAll('[data-testid="settings-mcp-key-edit-form"] input[type="checkbox"]')
    await boxes[0].setValue(false)
    await boxes[1].setValue(true)
    await w.get('[data-testid="settings-mcp-key-edit-save"]').trigger('click')

    expect(w.emitted('update')).toEqual([[{ id: 'key-1', workspaceIds: ['ws-b'] }]])
  })

  it('allows an empty set — "reaches nothing" is a legitimate choice', async () => {
    const w = render({ keys: [key()] })
    await w.get('[data-testid="settings-mcp-key-edit"]').trigger('click')
    const boxes = w.findAll('[data-testid="settings-mcp-key-edit-form"] input[type="checkbox"]')
    await boxes[0].setValue(false)
    await w.get('[data-testid="settings-mcp-key-edit-save"]').trigger('click')
    expect(w.emitted('update')).toEqual([[{ id: 'key-1', workspaceIds: [] }]])
  })

  it('leaves edit mode once the server-confirmed roster arrives', async () => {
    const w = render({ keys: [key()] })
    await w.get('[data-testid="settings-mcp-key-edit"]').trigger('click')
    expect(w.find('[data-testid="settings-mcp-key-edit-form"]').exists()).toBe(true)

    await w.setProps({ keys: [key({ workspaceIds: ['ws-b'] })] })
    expect(w.find('[data-testid="settings-mcp-key-edit-form"]').exists()).toBe(false)
  })
})

describe('revoking', () => {
  it('confirms before emitting, and emits nothing if cancelled', async () => {
    const w = render({ keys: [key()] })
    await w.get('[data-testid="settings-mcp-key-revoke"]').trigger('click')
    expect(w.emitted('revoke')).toBeUndefined()

    await w.findComponent({ name: 'ConfirmDialog' }).vm.$emit('cancel')
    expect(w.emitted('revoke')).toBeUndefined()
  })

  it('emits the key id once confirmed', async () => {
    const w = render({ keys: [key()] })
    await w.get('[data-testid="settings-mcp-key-revoke"]').trigger('click')
    await w.findComponent({ name: 'ConfirmDialog' }).vm.$emit('confirm')
    expect(w.emitted('revoke')).toEqual([['key-1']])
  })
})

describe('the non-admin view', () => {
  it('disables every action instead of hiding the section', () => {
    const w = render({ keys: [key()], isAdmin: false })
    expect(w.find('[data-testid="settings-mcp-api-keys"]').exists()).toBe(true)
    expect(w.get('[data-testid="settings-mcp-key-edit"]').attributes('disabled')).toBeDefined()
    expect(w.get('[data-testid="settings-mcp-key-revoke"]').attributes('disabled')).toBeDefined()
    expect(
      w.get('[data-testid="settings-mcp-key-create-open"]').attributes('disabled'),
    ).toBeDefined()
  })
})
