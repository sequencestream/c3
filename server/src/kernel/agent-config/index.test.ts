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
  specReviewAgentId: '',
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
  AgentGroupUnavailableError,
  groupAgents,
  launchForAgent,
  launchForCandidates,
  resolveAgent,
  resolveAgentCandidates,
  resolveAgentVendor,
  resolveFirstAgentOfVendor,
  resolveIntentAgent,
  resolveRoleAgentTarget,
  resolveSessionAgentBinding,
  resolveSessionVendor,
  setOnSessionBindingFallback,
  resolveSpecAgent,
  resolveSpecReviewAgent,
  resolveToolAgent,
  resolveToolSessionLaunch,
  tryResolveAgentTarget,
  tryResolveRoleAgentTarget,
} from './index.js'
import type { AgentRole } from './index.js'
import type { AgentConfig } from '@ccc/shared/protocol'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'

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

  it('a group with no enabled member fails loudly instead of falling back', () => {
    mockSettings.agents = originalAgents
    expect(() => resolveAgentCandidates('_c3_claude_nonexistent')).toThrow(
      AgentGroupUnavailableError,
    )
    // The failure names the group at fault so the caller can report it verbatim.
    expect(tryResolveAgentTarget('_c3_claude_nonexistent')).toEqual({
      ok: false,
      groupRef: '_c3_claude_nonexistent',
    })
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

describe('resolveSpecReviewAgent — the single reviewer slot, no sandbox variant', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('follows the default agent when specReviewAgentId is empty', () => {
    mockSettings.specReviewAgentId = ''
    expect(resolveSpecReviewAgent().id).toBe('claude-pro')
  })

  it('resolves an explicitly set, enabled reviewer', () => {
    mockSettings.specReviewAgentId = 'claude-sonnet'
    expect(resolveSpecReviewAgent().id).toBe('claude-sonnet')
  })

  it('resolves a cross-vendor reviewer (codex) when set', () => {
    mockSettings.specReviewAgentId = 'codex-agent'
    expect(resolveSpecReviewAgent().vendor).toBe('codex')
  })

  it('falls back to the default agent when the reviewer id is unknown', () => {
    mockSettings.specReviewAgentId = 'gone'
    expect(resolveSpecReviewAgent().id).toBe('claude-pro')
  })

  it('is independent of the spec AUTHOR slot', () => {
    mockSettings.specAgentId = 'claude-sonnet'
    mockSettings.specReviewAgentId = 'codex-agent'
    expect(resolveSpecAgent().id).toBe('claude-sonnet')
    expect(resolveSpecReviewAgent().id).toBe('codex-agent')
  })
})

describe('roles pointing at a group — bind the group, run its first enabled member', () => {
  /** Members of the claude `default` group, deliberately given out of order. */
  function member(id: string, order: number, group = 'default'): AgentConfig {
    return {
      id,
      vendor: 'claude',
      configMode: 'custom',
      displayName: id,
      order_seq: order,
      group,
      config: { baseUrl: `https://${id}.example/anthropic`, apiKey: `sk-${id}`, model: id },
      enabled: true,
    }
  }

  const GROUP = '_c3_claude_default'
  const ROLE_FIELD: Record<
    Exclude<AgentRole, 'default'>,
    'toolAgentId' | 'intentAgentId' | 'specAgentId' | 'specReviewAgentId'
  > = {
    tool: 'toolAgentId',
    intent: 'intentAgentId',
    spec: 'specAgentId',
    spec_review: 'specReviewAgentId',
  }
  const DEDICATED_ROLES = Object.keys(ROLE_FIELD) as Array<Exclude<AgentRole, 'default'>>

  const original = { ...mockSettings, agents: mockSettings.agents }
  beforeEach(() => {
    mockSettings.agents = [member('m2', 1), member('m1', 0), member('m3', 2)]
    mockSettings.defaultAgentId = GROUP
    mockSettings.toolAgentId = ''
    mockSettings.intentAgentId = ''
    mockSettings.specAgentId = ''
    mockSettings.specReviewAgentId = ''
  })
  afterEach(() => {
    mockSettings.agents = original.agents
    mockSettings.defaultAgentId = original.defaultAgentId
    mockSettings.toolAgentId = original.toolAgentId
    mockSettings.intentAgentId = original.intentAgentId
    mockSettings.specAgentId = original.specAgentId
    mockSettings.specReviewAgentId = original.specReviewAgentId
  })

  it("resolveAgent('') follows a GROUP default to its first enabled member, by order_seq", () => {
    expect(resolveAgent('').id).toBe('m1')
    expect(resolveAgent(null).id).toBe('m1')
    // The binding identity stays the group, not the member.
    expect(resolveRoleAgentTarget('default').ref).toBe(GROUP)
    expect(resolveRoleAgentTarget('default').candidates.map((a) => a.id)).toEqual([
      'm1',
      'm2',
      'm3',
    ])
  })

  it('a re-ordered group changes which member represents it on the next resolution', () => {
    mockSettings.agents = [member('m1', 5), member('m2', 0), member('m3', 2)]
    expect(resolveAgent('').id).toBe('m2')
    expect(resolveAgentCandidates('').map((a) => a.id)).toEqual(['m2', 'm3', 'm1'])
  })

  it('disabling the first member promotes the next one — same group binding', () => {
    mockSettings.agents = [{ ...member('m1', 0), enabled: false }, member('m2', 1), member('m3', 2)]
    expect(resolveAgent('').id).toBe('m2')
    expect(resolveToolSessionLaunch().agentId).toBe(GROUP)
  })

  it('a GROUP default with every member disabled throws instead of returning System', () => {
    mockSettings.agents = [
      { ...member('m1', 0), enabled: false },
      { ...member('m2', 1), enabled: false },
    ]
    expect(() => resolveAgent('')).toThrow(AgentGroupUnavailableError)
    // The error points at the DEFAULT group — the setting the user must fix.
    expect(tryResolveAgentTarget('')).toEqual({ ok: false, groupRef: GROUP })
    // Vendor reads stay answerable (the ref encodes the vendor) for display paths.
    expect(resolveAgentVendor('')).toBe('claude')
  })

  it.each(DEDICATED_ROLES)(
    'role %s: set directly to the group and left empty under a group default resolve identically',
    (role) => {
      const field = ROLE_FIELD[role]
      mockSettings[field] = ''
      const followed = resolveRoleAgentTarget(role)
      mockSettings[field] = GROUP
      const direct = resolveRoleAgentTarget(role)
      expect(direct.ref).toBe(GROUP)
      expect(followed.ref).toBe(GROUP)
      expect(direct.agent.id).toBe('m1')
      expect(followed.agent.id).toBe('m1')
      expect(direct.candidates.map((a) => a.id)).toEqual(followed.candidates.map((a) => a.id))
    },
  )

  it.each(DEDICATED_ROLES)('role %s reports an unusable group rather than falling back', (role) => {
    mockSettings.agents = [{ ...member('m1', 0), enabled: false }]
    mockSettings[ROLE_FIELD[role]] = GROUP
    expect(tryResolveRoleAgentTarget(role)).toEqual({ ok: false, groupRef: GROUP })
  })

  it('a group launch carries every member as an ordered relay candidate', () => {
    const launch = resolveToolSessionLaunch()
    expect(launch.agentId).toBe(GROUP)
    expect(launch.relayCandidates?.map((c) => c.model)).toEqual(['m1', 'm2', 'm3'])
  })

  it('an empty registry still synthesizes System (the settings-corrupt safety net)', () => {
    mockSettings.agents = []
    mockSettings.defaultAgentId = ''
    expect(resolveAgent('').id).toBe('system')
    expect(resolveAgent('gone').id).toBe('system')
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

describe('resolveSessionAgentBinding — projection fallback for factless real sessions', () => {
  afterEach(() => {
    setOnSessionBindingFallback(null)
  })

  it('reads the projection instead of falling through to the default agent', () => {
    // An automation session that ran before the fact was written on bind: the
    // projection row is the only first-hand record of what it ran on. Without this
    // fallback the binding degrades to `defaultAgentId` (claude), and a codex
    // automation renders as claude in the title bar and status bar.
    setOnSessionBindingFallback((realId) =>
      realId === 'codex-automation-session' ? { agentId: 'codex-agent', vendor: 'codex' } : null,
    )

    expect(resolveSessionAgentBinding('codex-automation-session')).toEqual({
      agentId: 'codex-agent',
      vendor: 'codex',
    })
    expect(resolveSessionVendor('codex-automation-session')).toBe('codex')
  })

  it('keeps the default-agent behaviour when the projection has no row', () => {
    setOnSessionBindingFallback(() => null)

    expect(resolveSessionVendor('unknown-session')).toBe('claude')
    expect(resolveSessionAgentBinding('unknown-session').agentId).toBe('claude-pro')
  })

  it('never consults the projection for a pending session (its intent has its own read-through)', () => {
    const fallback = vi.fn(() => ({ agentId: 'codex-agent', vendor: 'codex' as const }))
    setOnSessionBindingFallback(fallback)

    expect(resolveSessionVendor(`${PENDING_SESSION_PREFIX}abc`)).toBe('claude')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('unwired (tests / scripts without the projection) resolves exactly as before', () => {
    expect(resolveSessionVendor('codex-automation-session')).toBe('claude')
  })
})
