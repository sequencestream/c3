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
      config: { baseUrl: '', apiKey: '', model: '' },
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
import { resolveFirstAgentOfVendor } from './index.js'

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
