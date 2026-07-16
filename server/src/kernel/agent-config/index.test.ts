import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
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
  sandboxDefaultAgentId: '',
  sandboxToolAgentId: '',
  sandboxIntentAgentId: '',
  sandboxSpecAgentId: '',
  sandboxAutomationAgentId: '',
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
  groupAgents,
  launchForAgent,
  launchForCandidates,
  resolveAgent,
  resolveAgentCandidates,
  resolveFirstAgentOfVendor,
  resolveIntentAgent,
  resolveSpecAgent,
  resolveToolAgent,
} from './index.js'
import type { AgentConfig } from '@ccc/shared/protocol'

describe('group agents + candidate resolution (ADR-0029)', () => {
  // A custom claude agent factory for group tests.
  function claudeCustom(id: string, order: number, group: string, model: string): AgentConfig {
    return {
      id,
      vendor: 'claude',
      configMode: 'custom',
      displayName: id,
      order_seq: order,
      group,
      config: { baseUrl: `https://${id}.example/anthropic`, apiKey: `sk-${id}`, model },
      enabled: true,
    }
  }

  const originalAgents = mockSettings.agents
  beforeEach(() => {
    mockSettings.agents = originalAgents
  })
  afterEach(() => {
    // Restore the shared fixture so later describes (which have no beforeEach of
    // their own for `agents`) are not polluted by this block's mutations.
    mockSettings.agents = originalAgents
  })

  it('groupAgents(vendor, group) returns that vendor+group enabled members in order', () => {
    mockSettings.agents = [
      claudeCustom('a2', 1, 'fast', 'kimi-k2'),
      claudeCustom('a1', 0, 'fast', 'deepseek-v4'),
      { ...claudeCustom('a3', 2, 'fast', 'mimo'), enabled: false }, // disabled ⇒ excluded
      {
        ...claudeCustom('cx', 3, 'fast', 'm'),
        vendor: 'codex',
        config: { baseUrl: 'https://cx', apiKey: 'k', model: 'm', wireApi: 'chat' },
      }, // same group name, different vendor ⇒ its OWN (codex, fast) group
    ]
    expect(groupAgents('claude', 'fast').map((a) => a.id)).toEqual(['a1', 'a2'])
    // Different vendors may reuse the same group name — the codex "fast" is separate.
    expect(groupAgents('codex', 'fast').map((a) => a.id)).toEqual(['cx'])
  })

  it('resolveAgentCandidates(_c3_<vendor>_<group>) yields the ordered members; launchForCandidates maps them', () => {
    mockSettings.agents = [
      claudeCustom('a1', 0, 'fast', 'deepseek-v4'),
      claudeCustom('a2', 1, 'fast', 'kimi-k2'),
    ]
    const candidates = resolveAgentCandidates('_c3_claude_fast')
    expect(candidates.map((a) => a.id)).toEqual(['a1', 'a2'])
    const launch = launchForCandidates(candidates)
    // model placeholder = the highest-priority candidate's model.
    expect(launch.model).toBe('deepseek-v4')
    expect(launch.relayCandidates).toEqual([
      { baseUrl: 'https://a1.example/anthropic', apiKey: 'sk-a1', model: 'deepseek-v4' },
      { baseUrl: 'https://a2.example/anthropic', apiKey: 'sk-a2', model: 'kimi-k2' },
    ])
  })

  it('resolveAgent tolerates a group ref, returning the highest-priority member', () => {
    mockSettings.agents = [
      claudeCustom('a1', 0, 'fast', 'deepseek-v4'),
      claudeCustom('a2', 1, 'fast', 'kimi-k2'),
    ]
    expect(resolveAgent('_c3_claude_fast').id).toBe('a1')
  })

  it('an empty group ref falls back to the default agent (never empty)', () => {
    mockSettings.agents = originalAgents
    const candidates = resolveAgentCandidates('_c3_claude_nonexistent')
    expect(candidates.length).toBe(1)
    expect(candidates[0].id).toBe('claude-pro') // the default fallback
  })

  it('a real id resolves to a length-1 candidate list', () => {
    mockSettings.agents = [claudeCustom('a1', 0, 'fast', 'deepseek-v4')]
    expect(resolveAgentCandidates('a1').map((a) => a.id)).toEqual(['a1'])
  })
})

describe('launchForAgent — system mode model override + relay candidates (ADR-0029)', () => {
  it('claude + system + model non-empty → model passed, no relay candidates', () => {
    const launch = launchForAgent({
      id: 'cl-sys-m',
      vendor: 'claude',
      configMode: 'system',
      displayName: 'Claude Sys',
      config: { baseUrl: '', apiKey: '', model: 'claude-sonnet-5' },
      enabled: true,
    })
    expect(launch.model).toBe('claude-sonnet-5')
    expect(launch.relayCandidates).toBeUndefined()
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
    expect(launch.relayCandidates).toBeUndefined()
    expect(launch.envOverrides).toBeUndefined()
  })

  it('codex + system + model non-empty → model passed, no relay candidates', () => {
    const launch = launchForAgent({
      id: 'cx-sys-m',
      vendor: 'codex',
      configMode: 'system',
      displayName: 'Codex Sys',
      config: { baseUrl: '', apiKey: '', model: 'deepseek-chat', wireApi: 'chat' },
      enabled: true,
    })
    expect(launch.model).toBe('deepseek-chat')
    expect(launch.relayCandidates).toBeUndefined()
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
    expect(launch.relayCandidates).toBeUndefined()
  })

  it('custom codex → a relay candidate carries the real upstream + wireApi; model placeholder', () => {
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
    expect(launch.relayCandidates).toEqual([
      {
        baseUrl: 'https://api.example.com',
        apiKey: 'sk-test',
        model: 'test-model',
        wireApi: 'responses',
      },
    ])
  })

  it('custom claude → a relay candidate (no wireApi) + the adaptive-thinking workaround flag', () => {
    const launch = launchForAgent({
      id: 'cl-cust',
      vendor: 'claude',
      configMode: 'custom',
      displayName: 'Claude Cust',
      config: {
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiKey: 'sk-real',
        model: 'deepseek-v4',
      },
      enabled: true,
    })
    expect(launch.model).toBe('deepseek-v4')
    expect(launch.relayCandidates).toEqual([
      { baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-real', model: 'deepseek-v4' },
    ])
    // The real key is NOT in the env — it rides the relay candidate only.
    expect(launch.envOverrides?.ANTHROPIC_API_KEY).toBeUndefined()
    expect(launch.envOverrides?.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING).toBe('1')
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

describe('launchForAgent — codex wireApi rides the relay candidate (ADR-0029)', () => {
  it('a custom codex agent carries baseUrl/apiKey + wireApi into the relay candidate', () => {
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
    expect(launch.relayCandidates).toEqual([
      { baseUrl: 'https://api.deepseek.com', apiKey: 'sk', model: 'm', wireApi: 'responses' },
    ])
  })

  it('a system-mode codex agent — model override IS passed, no relay candidate (2026-07-02-001)', () => {
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
    // provider connection stays custom-only ⇒ no relay candidate
    expect(launch.relayCandidates).toBeUndefined()
  })
})
