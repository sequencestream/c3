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
  // '' ⇒ intent comm sessions follow the default agent; tests mutate this per-case.
  intentAgentId: '',
  // '' ⇒ spec sessions follow the default agent; tests mutate this per-case.
  specAgentId: '',
  automationAgentId: '',
  degradationChain: [],
}

vi.mock('../config/index.js', () => ({
  loadSettings: vi.fn(() => mockSettings),
  getSessionAgentId: vi.fn(() => null),
  getProxyConfig: vi.fn(() => ({ enabled: false, httpProxy: '', httpsProxy: '' })),
  bindSessionAgent: vi.fn(),
  changeSessionAgentFact: vi.fn(() => true),
  setPendingIntent: vi.fn(),
}))

// Import AFTER the mock is set up.
import {
  launchForAgent,
  resolveFirstAgentOfVendor,
  resolveIntentAgent,
  resolveSpecAgent,
  resolveToolAgent,
} from './index.js'

describe('launchForAgent — system mode model override (2026-07-02-001)', () => {
  it('claude + system + model non-empty → model passed, envOverrides/baseUrl/apiKey absent', () => {
    const launch = launchForAgent({
      id: 'cl-sys-m',
      vendor: 'claude',
      configMode: 'system',
      displayName: 'Claude Sys',
      config: { baseUrl: '', apiKey: '', model: 'claude-sonnet-5' },
      enabled: true,
    })
    expect(launch.model).toBe('claude-sonnet-5')
    expect(launch.baseUrl).toBeUndefined()
    expect(launch.apiKey).toBeUndefined()
    // envOverrides must be absent or contain nothing provider-related
    // (proxy config is mocked off, so no env at all)
    expect(launch.envOverrides).toBeUndefined()
  })

  it('claude + system + model empty → model absent from LaunchOverrides (regression)', () => {
    const launch = launchForAgent({
      id: 'cl-sys-e',
      vendor: 'claude',
      configMode: 'system',
      displayName: 'Claude Sys',
      config: { baseUrl: '', apiKey: '', model: '' },
      enabled: true,
    })
    expect(launch.model).toBeUndefined()
    expect(launch.baseUrl).toBeUndefined()
    expect(launch.apiKey).toBeUndefined()
    expect(launch.envOverrides).toBeUndefined()
  })

  it('codex + system + model non-empty → model passed, baseUrl/apiKey/wireApi absent', () => {
    const launch = launchForAgent({
      id: 'cx-sys-m',
      vendor: 'codex',
      configMode: 'system',
      displayName: 'Codex Sys',
      config: { baseUrl: '', apiKey: '', model: 'deepseek-chat', wireApi: 'chat' },
      enabled: true,
    })
    expect(launch.model).toBe('deepseek-chat')
    expect(launch.baseUrl).toBeUndefined()
    expect(launch.apiKey).toBeUndefined()
    expect(launch.wireApi).toBeUndefined()
  })

  it('codex + system + model empty → model absent (regression)', () => {
    const launch = launchForAgent({
      id: 'cx-sys-e',
      vendor: 'codex',
      configMode: 'system',
      displayName: 'Codex Sys',
      config: { baseUrl: '', apiKey: '', model: '', wireApi: 'chat' },
      enabled: true,
    })
    expect(launch.model).toBeUndefined()
    expect(launch.baseUrl).toBeUndefined()
    expect(launch.apiKey).toBeUndefined()
    expect(launch.wireApi).toBeUndefined()
  })

  it('custom mode: model + connection fields still together (regression)', () => {
    const launch = launchForAgent({
      id: 'cx-cust',
      vendor: 'codex',
      configMode: 'custom',
      displayName: 'Codex Cust',
      config: {
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test',
        model: 'test-model',
        wireApi: 'responses',
      },
      enabled: true,
    })
    expect(launch.model).toBe('test-model')
    expect(launch.baseUrl).toBe('https://api.example.com')
    expect(launch.apiKey).toBe('sk-test')
    expect(launch.wireApi).toBe('responses')
  })
})

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

describe('resolveIntentAgent — intentAgentId → defaultAgentId → system fall-through (AC-R23)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('follows the default agent when intentAgentId is empty', () => {
    mockSettings.intentAgentId = ''
    expect(resolveIntentAgent().id).toBe('claude-pro')
  })

  it('resolves an explicitly set, enabled intentAgentId', () => {
    mockSettings.intentAgentId = 'claude-sonnet'
    expect(resolveIntentAgent().id).toBe('claude-sonnet')
  })

  it('resolves a cross-vendor intent agent (codex) when set', () => {
    mockSettings.intentAgentId = 'codex-agent'
    expect(resolveIntentAgent().vendor).toBe('codex')
  })

  it('falls back to the default agent when intentAgentId is unknown', () => {
    mockSettings.intentAgentId = 'gone'
    expect(resolveIntentAgent().id).toBe('claude-pro')
  })

  it('still resolves a disabled intent agent by id (launch is never locked out)', () => {
    // normalize rewrites a disabled intentAgentId before persist; the runtime resolver
    // itself does not filter on `enabled`, mirroring resolveAgent (AC-R10).
    mockSettings.intentAgentId = 'disabled-claude'
    expect(resolveIntentAgent().id).toBe('disabled-claude')
  })
})

describe('resolveSpecAgent — specAgentId → defaultAgentId → system fall-through (AC-R24)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('follows the default agent when specAgentId is empty', () => {
    mockSettings.specAgentId = ''
    expect(resolveSpecAgent().id).toBe('claude-pro')
  })

  it('resolves an explicitly set, enabled specAgentId', () => {
    mockSettings.specAgentId = 'claude-sonnet'
    expect(resolveSpecAgent().id).toBe('claude-sonnet')
  })

  it('resolves a cross-vendor spec agent (codex) when set', () => {
    mockSettings.specAgentId = 'codex-agent'
    expect(resolveSpecAgent().vendor).toBe('codex')
  })

  it('falls back to the default agent when specAgentId is unknown', () => {
    mockSettings.specAgentId = 'gone'
    expect(resolveSpecAgent().id).toBe('claude-pro')
  })

  it('still resolves a disabled spec agent by id (launch is never locked out)', () => {
    // normalize rewrites a disabled specAgentId before persist; the runtime resolver
    // itself does not filter on `enabled`, mirroring resolveAgent (AC-R10).
    mockSettings.specAgentId = 'disabled-claude'
    expect(resolveSpecAgent().id).toBe('disabled-claude')
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

  it('a system-mode codex agent — model override IS passed, provider fields still omitted (2026-07-02-001)', () => {
    const launch = launchForAgent({
      id: 'cx-sys',
      vendor: 'codex',
      configMode: 'system',
      displayName: 'Codex',
      config: { baseUrl: 'https://ignored', apiKey: 'ignored', model: 'm', wireApi: 'chat' },
      enabled: true,
    })
    // model is standalone — system mode still passes it
    expect(launch.model).toBe('m')
    // provider connection fields stay custom-only
    expect(launch.baseUrl).toBeUndefined()
    expect(launch.apiKey).toBeUndefined()
    expect(launch.wireApi).toBeUndefined()
  })
})
