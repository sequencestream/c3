/**
 * The personal key section. The two properties worth protecting here are that a
 * destructive action always goes through a confirmation, and that the one-time
 * plaintext really is one-time: it is rendered from a prop the owner clears, and
 * nothing in this component keeps a second copy.
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import type { McpApiKeyMeta } from '@ccc/shared/protocol'
import McpApiKeys from './McpApiKeys.vue'

function key(over: Partial<McpApiKeyMeta> = {}): McpApiKeyMeta {
  return {
    id: 'key-1',
    name: 'work laptop',
    createdAt: 1,
    lastUsedAt: null,
    // A self-service key is filed under no workspace at all.
    workspaceName: null,
    unavailable: false,
    tools: ['find_intents'],
    displayPrefix: 'c3k_key-1',
    ...over,
  }
}

function render(props: Record<string, unknown> = {}) {
  return mount(McpApiKeys, {
    props: { baseUrl: 'http://192.168.1.10:3000', mcpApiKeys: [key()], created: null, ...props },
  })
}

describe('the roster', () => {
  it('lists my keys by name and non-secret prefix, and says so when there are none', () => {
    const w = render()
    expect(w.findAll('[data-testid="personal-mcp-keys-key-row"]')).toHaveLength(1)
    expect(w.get('[data-testid="personal-mcp-keys-key-prefix"]').text()).toContain('c3k_key-1')

    const empty = render({ mcpApiKeys: [] })
    expect(empty.find('[data-testid="personal-mcp-keys-empty"]').exists()).toBe(true)
  })

  it('marks a key whose owner this deployment no longer recognizes', () => {
    const w = render({ mcpApiKeys: [key({ unavailable: true })] })
    expect(w.find('[data-testid="personal-mcp-keys-unavailable"]').exists()).toBe(true)
  })

  it('offers no tool-scope editor — scope is not the holder’s to change', () => {
    const w = render()
    expect(w.find('[data-testid="personal-mcp-keys-edit"]').exists()).toBe(false)
    expect(w.findAll('input[type="checkbox"]')).toHaveLength(0)
  })
})

describe('create', () => {
  it('needs a name before it will submit', async () => {
    const w = render()
    await w.get('[data-testid="personal-mcp-keys-create-open"]').trigger('click')
    const submit = w.get('[data-testid="personal-mcp-keys-create-submit"]')
    expect((submit.element as HTMLButtonElement).disabled).toBe(true)

    await w.get('[data-testid="personal-mcp-keys-new-name"]').setValue('  phone  ')
    await submit.trigger('click')
    // Trimmed, and no workspace or tool list is proposed — the server decides both.
    expect(w.emitted('create')).toEqual([[{ name: 'phone' }]])
  })
})

describe('reset', () => {
  it('confirms before emitting, because the old secret dies immediately', async () => {
    const w = render()
    await w.get('[data-testid="personal-mcp-keys-reset"]').trigger('click')
    expect(w.emitted('reset')).toBeUndefined()

    await w.get('[data-testid="confirm-accept"]').trigger('click')
    expect(w.emitted('reset')).toEqual([['key-1']])
  })

  it('emits nothing when the confirmation is cancelled', async () => {
    const w = render()
    await w.get('[data-testid="personal-mcp-keys-reset"]').trigger('click')
    await w.get('[data-testid="confirm-cancel"]').trigger('click')
    expect(w.emitted('reset')).toBeUndefined()
  })
})

describe('revoke', () => {
  it('confirms before emitting', async () => {
    const w = render()
    await w.get('[data-testid="personal-mcp-keys-revoke"]').trigger('click')
    expect(w.emitted('revoke')).toBeUndefined()

    await w.get('[data-testid="confirm-accept"]').trigger('click')
    expect(w.emitted('revoke')).toEqual([['key-1']])
  })
})

describe('the one-time reveal', () => {
  const created = { meta: key({ id: 'key-new', name: 'phone' }), key: 'c3k_key-new_PLAINTEXT' }

  it('shows the plaintext, the endpoint and a command that never inlines the key', () => {
    const w = render({ created })
    expect(w.get('[data-testid="personal-mcp-keys-plaintext"]').text()).toBe(
      'c3k_key-new_PLAINTEXT',
    )
    expect(w.get('[data-testid="personal-mcp-keys-url"]').text()).toBe(
      'http://192.168.1.10:3000/mcp',
    )
    // The command references the key through an env var: pasting the plaintext in
    // would leave a second copy in shell history.
    const command = w.get('[data-testid="personal-mcp-keys-command"]').text()
    expect(command).toContain('$C3_MCP_KEY')
    expect(command).not.toContain('PLAINTEXT')
  })

  it('asks the owner to drop it, and renders nothing once the prop is cleared', async () => {
    const w = render({ created })
    await w.get('[data-testid="personal-mcp-keys-dismiss"]').trigger('click')
    expect(w.emitted('dismissReveal')).toHaveLength(1)

    // The owner clears the prop; the component keeps no copy of its own, so the
    // plaintext is gone from the DOM entirely.
    await w.setProps({ created: null })
    expect(w.find('[data-testid="personal-mcp-keys-reveal"]').exists()).toBe(false)
    expect(w.html()).not.toContain('PLAINTEXT')
  })

  it('still reveals the key when no public address is configured', () => {
    const w = render({ created, baseUrl: null })
    expect(w.find('[data-testid="personal-mcp-keys-no-base-url"]').exists()).toBe(true)
    expect(w.get('[data-testid="personal-mcp-keys-plaintext"]').text()).toBe(
      'c3k_key-new_PLAINTEXT',
    )
    // Nothing to copy that would be wrong: the endpoint is omitted, not guessed.
    expect(w.find('[data-testid="personal-mcp-keys-url"]').exists()).toBe(false)
    expect(w.find('[data-testid="personal-mcp-keys-endpoint-url"]').exists()).toBe(false)
  })
})

describe('the always-on endpoint', () => {
  it('lists the MCP address below the key roster when baseUrl is set', () => {
    const w = render()
    expect(w.get('[data-testid="personal-mcp-keys-endpoint-url"]').text()).toBe(
      'http://192.168.1.10:3000/mcp',
    )
  })

  it('says the public address is missing instead of guessing the browser Host', () => {
    const w = render({ baseUrl: null })
    expect(w.find('[data-testid="personal-mcp-keys-no-base-url"]').exists()).toBe(true)
    expect(w.find('[data-testid="personal-mcp-keys-endpoint-url"]').exists()).toBe(false)
  })
})
