import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { SystemSettings } from '@ccc/shared/protocol'

// Mock loadSettings to return a controlled agent list.
const mockSettings: SystemSettings = {
  agents: [
    {
      id: 'claude-pro',
      vendor: 'claude',
      configMode: 'system' as const,
      displayName: 'Claude Pro',
      config: { baseUrl: '', apiKey: '', model: '' },
      enabled: true,
    },
    {
      id: 'claude-sonnet',
      vendor: 'claude',
      configMode: 'system' as const,
      displayName: 'Claude Sonnet',
      config: { baseUrl: '', apiKey: '', model: '' },
      enabled: true,
    },
    {
      id: 'codex-agent',
      vendor: 'codex',
      configMode: 'system' as const,
      displayName: 'Codex Agent',
      config: { baseUrl: '', apiKey: '', model: '', wireApi: 'chat' as const },
      enabled: true,
    },
    {
      id: 'disabled-claude',
      vendor: 'claude',
      configMode: 'system' as const,
      displayName: 'Disabled Claude',
      config: { baseUrl: '', apiKey: '', model: '' },
      enabled: false,
    },
  ],
  defaultAgentId: 'claude-pro',
  // '' ⇒ tool sessions follow the default agent; tests mutate this per-case.
  toolAgentId: '',
  degradationChain: [],
}

vi.mock('../config/index.js', () => ({
  loadSettings: vi.fn(() => mockSettings),
  getSessionAgentId: vi.fn(() => null),
  bindSessionAgent: vi.fn(),
  changeSessionAgentFact: vi.fn(() => true),
  setPendingIntent: vi.fn(),
}))

// Import AFTER the mock is set up.
import { launchForAgent, resolveFirstAgentOfVendor, resolveToolAgent } from './index.js'

describe('resolveFirstAgentOfVendor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the first enabled agent matching the vendor', () => {
    const agent = resolveFirstAgentOfVendor('claude')
    expect(agent.id).toBe('claude-pro')
    expect(agent.vendor).toBe('claude')
  })

  it('returns the first enabled agent for codex vendor', () => {
    const agent = resolveFirstAgentOfVendor('codex')
    expect(agent.id).toBe('codex-agent')
    expect(agent.vendor).toBe('codex')
  })

  it('skips disabled agents when matching vendor', () => {
    const agent = resolveFirstAgentOfVendor('claude')
    // The disabled agent has id 'disabled-claude' — the first enabled claude is 'claude-pro'
    expect(agent.id).not.toBe('disabled-claude')
    expect(agent.id).toBe('claude-pro')
  })

  it('falls back to default agent when no enabled agent of matching vendor exists', () => {
    const agent = resolveFirstAgentOfVendor('opencode')
    // No opencode agents configured — should fall back to default (claude-pro)
    expect(agent.id).toBe('claude-pro')
  })
})

describe('resolveToolAgent — toolAgentId → defaultAgentId → system fall-through (2026-06-15-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('follows the default agent when toolAgentId is empty', () => {
    mockSettings.toolAgentId = ''
    expect(resolveToolAgent().id).toBe('claude-pro')
  })

  it('resolves an explicitly set, enabled toolAgentId', () => {
    mockSettings.toolAgentId = 'claude-sonnet'
    expect(resolveToolAgent().id).toBe('claude-sonnet')
  })

  it('resolves a cross-vendor tool agent (codex) when set', () => {
    mockSettings.toolAgentId = 'codex-agent'
    expect(resolveToolAgent().vendor).toBe('codex')
  })

  it('falls back to the default agent when toolAgentId is unknown', () => {
    mockSettings.toolAgentId = 'gone'
    expect(resolveToolAgent().id).toBe('claude-pro')
  })

  it('still resolves a disabled tool agent by id (launch is never locked out)', () => {
    // normalize rewrites a disabled toolAgentId before persist; the runtime resolver
    // itself does not filter on `enabled`, mirroring resolveAgent (AC-R10).
    mockSettings.toolAgentId = 'disabled-claude'
    expect(resolveToolAgent().id).toBe('disabled-claude')
  })
})

describe('launchForAgent — codex wireApi (2026-06-12-006)', () => {
  it('a custom codex agent carries baseUrl/apiKey + wireApi into the launch overrides', () => {
    const launch = launchForAgent({
      id: 'cx',
      vendor: 'codex',
      configMode: 'custom',
      displayName: 'Codex',
      config: {
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk',
        model: 'm',
        wireApi: 'responses',
      },
      enabled: true,
    })
    expect(launch.baseUrl).toBe('https://api.deepseek.com')
    expect(launch.apiKey).toBe('sk')
    expect(launch.wireApi).toBe('responses')
  })

  it('a system-mode codex agent applies no provider override and omits wireApi', () => {
    const launch = launchForAgent({
      id: 'cx-sys',
      vendor: 'codex',
      configMode: 'system',
      displayName: 'Codex',
      config: { baseUrl: 'https://ignored', apiKey: 'ignored', model: 'm', wireApi: 'chat' },
      enabled: true,
    })
    expect(launch.baseUrl).toBeUndefined()
    expect(launch.apiKey).toBeUndefined()
    expect(launch.wireApi).toBeUndefined()
  })
})
