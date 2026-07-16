import { describe, expect, it, vi } from 'vitest'
import type { AgentConfig, SystemSettings } from '@ccc/shared/protocol'
import { normalizeSandboxRoleId, firstEnabledCustomAgent } from './normalize.js'

function agent(over: Partial<AgentConfig> & Pick<AgentConfig, 'id'>): AgentConfig {
  return {
    vendor: 'claude',
    configMode: 'custom',
    displayName: over.id,
    enabled: true,
    config: { baseUrl: 'https://gw.example', apiKey: 'k', model: 'm' },
    ...over,
  } as AgentConfig
}

const AGENTS: AgentConfig[] = [
  agent({ id: 'sys', configMode: 'system', config: { baseUrl: '', apiKey: '', model: '' } }),
  agent({ id: 'custom-claude' }),
  agent({ id: 'custom-claude-2' }),
  agent({ id: 'custom-codex', vendor: 'codex' }),
  agent({ id: 'disabled-custom', enabled: false }),
]

describe('normalizeSandboxRoleId', () => {
  it('keeps a reference to an enabled custom agent', () => {
    expect(normalizeSandboxRoleId('custom-claude', AGENTS)).toBe('custom-claude')
  })
  it('resets a system-mode agent to ""', () => {
    expect(normalizeSandboxRoleId('sys', AGENTS)).toBe('')
  })
  it('resets a disabled custom agent to ""', () => {
    expect(normalizeSandboxRoleId('disabled-custom', AGENTS)).toBe('')
  })
  it('resets an unknown / empty reference to ""', () => {
    expect(normalizeSandboxRoleId('nope', AGENTS)).toBe('')
    expect(normalizeSandboxRoleId('', AGENTS)).toBe('')
    expect(normalizeSandboxRoleId(undefined, AGENTS)).toBe('')
  })
})

describe('firstEnabledCustomAgent', () => {
  it('prefers a same-vendor enabled custom agent', () => {
    expect(firstEnabledCustomAgent(AGENTS, 'codex')?.id).toBe('custom-codex')
  })
  it('falls back to any enabled custom agent when no same-vendor match', () => {
    const noCodex = AGENTS.filter((a) => a.vendor !== 'codex')
    expect(firstEnabledCustomAgent(noCodex, 'codex')?.id).toBe('custom-claude')
  })
  it('returns undefined when no custom agent is enabled', () => {
    const onlySystem = [AGENTS[0]]
    expect(firstEnabledCustomAgent(onlySystem)).toBeUndefined()
  })
})

// resolveSandboxAgent reads loadSettings — mock it and re-import in isolation.
describe('resolveSandboxAgent', () => {
  const base: SystemSettings = {
    agents: AGENTS,
    defaultAgentId: 'sys',
    toolAgentId: '',
    intentAgentId: '',
    specAgentId: '',
    automationAgentId: '',
    sandboxDefaultAgentId: '',
    sandboxToolAgentId: '',
    sandboxIntentAgentId: '',
    sandboxSpecAgentId: '',
    sandboxAutomationAgentId: '',
  }

  async function withSettings(patch: Partial<SystemSettings>) {
    vi.resetModules()
    vi.doMock('../config/index.js', () => ({
      loadSettings: vi.fn(() => ({ ...base, ...patch })),
      getSessionAgentId: vi.fn(() => null),
      getProxyConfig: vi.fn(() => ({ enabled: false, httpProxy: '', httpsProxy: '' })),
      bindSessionAgent: vi.fn(),
      changeSessionAgentFact: vi.fn(() => true),
      setPendingIntent: vi.fn(),
    }))
    return import('./index.js')
  }

  it('uses the kind-specific sandbox role when set', async () => {
    const { resolveSandboxAgent } = await withSettings({ sandboxIntentAgentId: 'custom-claude-2' })
    expect(resolveSandboxAgent('intent', 'claude')?.id).toBe('custom-claude-2')
  })

  it('falls back to the sandbox default, then to the first same-vendor custom', async () => {
    const { resolveSandboxAgent } = await withSettings({ sandboxDefaultAgentId: 'custom-claude' })
    expect(resolveSandboxAgent('work', 'claude')?.id).toBe('custom-claude')
    const { resolveSandboxAgent: r2 } = await withSettings({})
    expect(r2('work', 'claude')?.id).toBe('custom-claude')
  })

  it('never returns a system agent; null when no custom agent exists', async () => {
    const { resolveSandboxAgent } = await withSettings({ agents: [AGENTS[0]] })
    expect(resolveSandboxAgent('work', 'claude')).toBeNull()
  })
})
