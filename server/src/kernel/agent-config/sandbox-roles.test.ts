import { describe, expect, it, vi } from 'vitest'
import type { AgentConfig, SystemSettings } from '@ccc/shared/protocol'
import { normalizeSandboxRoleId, firstEnabledSandboxAgent } from './normalize.js'

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

// `sys` is a system-mode (subscription) claude agent and IS a legal sandbox agent
// since the wrapper opens the host keychain for it (arapuca `--allow-keychain`).
// It sits first so the "candidate admission is enabled-only" rule is observable.
const AGENTS: AgentConfig[] = [
  agent({ id: 'sys', configMode: 'system', config: { baseUrl: '', apiKey: '', model: '' } }),
  agent({ id: 'custom-claude' }),
  agent({ id: 'custom-claude-2' }),
  agent({ id: 'custom-codex', vendor: 'codex' }),
  agent({ id: 'disabled-custom', enabled: false }),
  agent({
    id: 'disabled-system',
    configMode: 'system',
    enabled: false,
    config: { baseUrl: '', apiKey: '', model: '' },
  }),
]

describe('normalizeSandboxRoleId', () => {
  it('keeps a reference to an enabled custom agent', () => {
    expect(normalizeSandboxRoleId('custom-claude', AGENTS)).toBe('custom-claude')
  })
  it('keeps a reference to an enabled system-mode agent (subscription auth is allowed)', () => {
    expect(normalizeSandboxRoleId('sys', AGENTS)).toBe('sys')
  })
  it('resets a disabled agent to "", of either auth mode', () => {
    expect(normalizeSandboxRoleId('disabled-custom', AGENTS)).toBe('')
    expect(normalizeSandboxRoleId('disabled-system', AGENTS)).toBe('')
  })
  it('resets an unknown / empty reference to ""', () => {
    expect(normalizeSandboxRoleId('nope', AGENTS)).toBe('')
    expect(normalizeSandboxRoleId('', AGENTS)).toBe('')
    expect(normalizeSandboxRoleId(undefined, AGENTS)).toBe('')
  })
})

describe('firstEnabledSandboxAgent', () => {
  it('prefers a same-vendor enabled agent', () => {
    expect(firstEnabledSandboxAgent(AGENTS, 'codex')?.id).toBe('custom-codex')
  })
  it('falls back to any enabled agent when no same-vendor match', () => {
    const noCodex = AGENTS.filter((a) => a.vendor !== 'codex')
    expect(firstEnabledSandboxAgent(noCodex, 'codex')?.id).toBe('sys')
  })
  it('accepts a system-mode agent as the only candidate', () => {
    expect(firstEnabledSandboxAgent([AGENTS[0]])?.id).toBe('sys')
  })
  it('returns undefined when no agent is enabled', () => {
    expect(firstEnabledSandboxAgent([AGENTS[4]])).toBeUndefined()
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

  it('accepts an enabled system-mode agent as the kind-specific sandbox role', async () => {
    const { resolveSandboxAgent } = await withSettings({ sandboxIntentAgentId: 'sys' })
    expect(resolveSandboxAgent('intent', 'claude')?.id).toBe('sys')
  })

  it('accepts an enabled system-mode agent as the sandbox default', async () => {
    const { resolveSandboxAgent } = await withSettings({ sandboxDefaultAgentId: 'sys' })
    expect(resolveSandboxAgent('work', 'claude')?.id).toBe('sys')
  })

  it('falls back to the sandbox default, then to the first same-vendor enabled agent', async () => {
    const { resolveSandboxAgent } = await withSettings({ sandboxDefaultAgentId: 'custom-claude' })
    expect(resolveSandboxAgent('work', 'claude')?.id).toBe('custom-claude')
    // No role and no sandbox default ⇒ the first enabled same-vendor agent, which
    // may legitimately be the system-mode one.
    const { resolveSandboxAgent: r2 } = await withSettings({})
    expect(r2('work', 'claude')?.id).toBe('sys')
    expect(r2('work', 'codex')?.id).toBe('custom-codex')
  })

  it('still rejects a disabled agent, of either auth mode', async () => {
    const { resolveSandboxAgent } = await withSettings({
      sandboxDefaultAgentId: 'disabled-system',
      agents: [AGENTS[5], AGENTS[3]],
    })
    // The disabled system agent is skipped; resolution lands on the enabled codex one.
    expect(resolveSandboxAgent('work', 'claude')?.id).toBe('custom-codex')
  })

  it('returns null only when no agent is enabled at all', async () => {
    const { resolveSandboxAgent } = await withSettings({ agents: [AGENTS[4]] })
    expect(resolveSandboxAgent('work', 'claude')).toBeNull()
  })
})
