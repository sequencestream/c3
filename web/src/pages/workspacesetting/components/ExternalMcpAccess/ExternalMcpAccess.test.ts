import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import type { McpApiKeyMeta } from '@ccc/shared/protocol'
import ExternalMcpAccess from './ExternalMcpAccess.vue'

const WORKSPACE_ID = 'ws-1'
const WORKSPACE_PATH = '/Users/alice/projects/c3'

function key(over: Partial<McpApiKeyMeta> = {}): McpApiKeyMeta {
  return {
    id: 'key-1',
    name: 'release-bot',
    createdAt: 1,
    lastUsedAt: null,
    workspaceIds: [WORKSPACE_ID],
    staleWorkspaces: [],
    displayPrefix: 'c3k_key-1',
    ...over,
  }
}

function render(props: Partial<InstanceType<typeof ExternalMcpAccess>['$props']> = {}) {
  return mount(ExternalMcpAccess, {
    props: {
      baseUrl: 'http://192.168.1.10:3000',
      workspacePath: WORKSPACE_PATH,
      workspaceId: WORKSPACE_ID,
      mcpApiKeys: [key()],
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

describe('the access address', () => {
  it('builds the URL from base URL + fixed route + this workspace path', () => {
    const w = render()
    const url = w.get('[data-testid="workspace-external-mcp-url"]').text()
    expect(url).toBe(
      `http://192.168.1.10:3000/mcp/v1?token=<KEY>&workspace=${encodeURIComponent(WORKSPACE_PATH)}`,
    )
  })

  it('shows the <KEY> placeholder unencoded so the copied template stays readable', () => {
    const w = render()
    expect(w.get('[data-testid="workspace-external-mcp-url"]').text()).toContain('token=<KEY>')
    expect(w.get('[data-testid="workspace-external-mcp-url"]').text()).not.toContain('%3CKEY%3E')
  })

  it('offers the one-line client command around the same URL', () => {
    const w = render()
    const cmd = w.get('[data-testid="workspace-external-mcp-command"]').text()
    const url = w.get('[data-testid="workspace-external-mcp-url"]').text()
    expect(cmd).toBe(`claude mcp add --transport http c3 "${url}"`)
  })

  it('strips a trailing slash from the configured base URL', () => {
    const w = render({ baseUrl: 'http://c3.example.com/' })
    expect(w.get('[data-testid="workspace-external-mcp-url"]').text()).toContain(
      'http://c3.example.com/mcp/v1?',
    )
  })
})

describe('the temporary plaintext key', () => {
  it('substitutes a pasted key into both the URL and the command', async () => {
    const w = render()
    await w.get('[data-testid="workspace-external-mcp-key-input"]').setValue('c3k_abc_secret')

    expect(w.get('[data-testid="workspace-external-mcp-url"]').text()).toContain(
      'token=c3k_abc_secret',
    )
    expect(w.get('[data-testid="workspace-external-mcp-command"]').text()).toContain(
      'token=c3k_abc_secret',
    )
  })

  it('never leaves the component — nothing is emitted and nothing is stored', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const w = render()
    await w.get('[data-testid="workspace-external-mcp-key-input"]').setValue('c3k_abc_secret')

    // The only emit this component has is the navigation request.
    expect(Object.keys(w.emitted())).not.toContain('update:mcpApiKeys')
    expect(w.emitted('gotoSystemSettings')).toBeUndefined()
    expect(setItem).not.toHaveBeenCalled()
    setItem.mockRestore()
  })

  it('is gone once the component unmounts — the value lives only in this page view', async () => {
    const w = render()
    await w.get('[data-testid="workspace-external-mcp-key-input"]').setValue('c3k_abc_secret')
    w.unmount()

    const fresh = render()
    expect(fresh.get('[data-testid="workspace-external-mcp-url"]').text()).toContain('token=<KEY>')
  })

  it('masks the input so a pasted key is not shoulder-readable', () => {
    const w = render()
    expect(w.get('[data-testid="workspace-external-mcp-key-input"]').attributes('type')).toBe(
      'password',
    )
  })
})

describe('copying', () => {
  it('copies the URL and reports it', async () => {
    const w = render()
    await w.get('[data-testid="workspace-external-mcp-copy-url"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(
      w.get('[data-testid="workspace-external-mcp-url"]').text(),
    )
  })

  it('copies the command independently of the URL', async () => {
    const w = render()
    await w.get('[data-testid="workspace-external-mcp-copy-command"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith(
      w.get('[data-testid="workspace-external-mcp-command"]').text(),
    )
  })
})

describe('guidance when something is missing', () => {
  it('says the base URL is unconfigured instead of guessing the browser host', () => {
    const w = render({ baseUrl: null })
    expect(w.find('[data-testid="workspace-external-mcp-no-base-url"]').exists()).toBe(true)
    expect(w.find('[data-testid="workspace-external-mcp-url"]').exists()).toBe(false)
  })

  it('treats a blank base URL the same as an absent one', () => {
    const w = render({ baseUrl: '   ' })
    expect(w.find('[data-testid="workspace-external-mcp-no-base-url"]').exists()).toBe(true)
  })

  it('points at system settings when no key covers this workspace', async () => {
    const w = render({ mcpApiKeys: [key({ workspaceIds: ['ws-other'] })] })
    expect(w.find('[data-testid="workspace-external-mcp-no-key"]').exists()).toBe(true)
    await w.get('[data-testid="workspace-external-mcp-goto"]').trigger('click')
    expect(w.emitted('gotoSystemSettings')).toHaveLength(1)
  })

  it('names the keys that DO cover this workspace', () => {
    const w = render({
      mcpApiKeys: [key(), key({ id: 'key-2', name: 'ci', workspaceIds: ['ws-other'] })],
    })
    const text = w.get('[data-testid="workspace-external-mcp-granted-keys"]').text()
    expect(text).toContain('release-bot')
    expect(text).not.toContain('ci')
  })

  it('still shows the address template when a key exists but was never pasted', () => {
    const w = render()
    expect(w.find('[data-testid="workspace-external-mcp-no-key"]').exists()).toBe(false)
    expect(w.get('[data-testid="workspace-external-mcp-url"]').text()).toContain('<KEY>')
  })
})
