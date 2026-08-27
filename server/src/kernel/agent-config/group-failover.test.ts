/*
 * Group failover across the launch-segment boundary (ADR-0029).
 *
 * A group may mix `custom` members (reached through c3's relay) and `system` ones
 * (the vendor CLI's own login). One run can serve only one kind, because the
 * provider endpoint is baked into the subprocess env at spawn — so the candidate
 * list is cut into SEGMENTS, and the session's cursor is what carries a resume
 * across a segment boundary.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { AgentConfig, SystemSettings } from '@ccc/shared/protocol'

const mockSettings: SystemSettings = {
  agents: [],
  defaultAgentId: 'lead',
  toolAgentId: '',
  intentAgentId: '',
  specAgentId: '',
  specReviewAgentId: '',
  automationAgentId: '',
  degradationChain: [],
}

// The bound ref + cursor of the one session under test.
let boundRef: string | null = null
let cursor: string | null = null

vi.mock('../config/index.js', () => ({
  loadSettings: vi.fn(() => mockSettings),
  getSessionAgentId: vi.fn(() => boundRef),
  getSessionGroupCursor: vi.fn(() => cursor),
  setSessionGroupCursor: vi.fn((_id: string, member: string | null) => {
    cursor = member
  }),
  getSessionStoreScope: vi.fn(() => 'host' as const),
  getProxyConfig: vi.fn(() => ({ enabled: false, httpProxy: '', httpsProxy: '' })),
  bindSessionAgent: vi.fn(),
  changeSessionAgentFact: vi.fn(() => true),
  setPendingIntent: vi.fn(),
}))

import {
  advanceGroupCursor,
  launchForCandidates,
  launchSegment,
  resolveAgentCandidates,
  resolveSessionLaunch,
} from './index.js'

const GROUP = 'pool'
const REF = `_c3_claude_${GROUP}`

function custom(
  id: string,
  order: number,
  model: string,
  group = GROUP,
  baseUrl = `https://${id}.example/anthropic`,
): AgentConfig {
  return {
    id,
    vendor: 'claude',
    configMode: 'custom',
    displayName: id,
    order_seq: order,
    group,
    config: { baseUrl, apiKey: `sk-${id}`, model },
    enabled: true,
  }
}

function system(id: string, order: number, model = '', group = GROUP): AgentConfig {
  return {
    id,
    vendor: 'claude',
    configMode: 'system',
    displayName: id,
    order_seq: order,
    group,
    config: { baseUrl: '', apiKey: '', model },
    enabled: true,
  }
}

beforeEach(() => {
  boundRef = REF
  cursor = null
  mockSettings.agents = []
  mockSettings.modelProviders = []
})

describe('launchSegment — what a single launch can actually serve', () => {
  it('a leading system member launches ALONE on the CLI’s own login', () => {
    const members = [system('s1', 0), custom('c1', 1, 'deepseek-v4'), custom('c2', 2, 'kimi-k2')]
    expect(launchSegment(members).map((a) => a.id)).toEqual(['s1'])
  })

  it('a leading custom member takes every custom member that directly follows', () => {
    const members = [custom('c1', 0, 'deepseek-v4'), custom('c2', 1, 'kimi-k2'), system('s1', 2)]
    expect(launchSegment(members).map((a) => a.id)).toEqual(['c1', 'c2'])
  })

  it('an all-custom group is one segment', () => {
    const members = [custom('c1', 0, 'a'), custom('c2', 1, 'b')]
    expect(launchSegment(members).map((a) => a.id)).toEqual(['c1', 'c2'])
  })

  it('a custom member with no baseUrl cannot be relayed, so it ends the segment', () => {
    const blank = custom('c2', 1, 'b', GROUP, '')
    expect(launchSegment([custom('c1', 0, 'a'), blank]).map((a) => a.id)).toEqual(['c1'])
  })

  it('a paused-provider peer ends the segment without aborting a healthy leader', () => {
    // Peer c2 points at a paused provider. Resolving it must NOT throw out of
    // launchSegment — that would abort the healthy leader. It ends the segment
    // the same way a peer with no baseUrl does.
    mockSettings.modelProviders = [
      {
        id: 'p-ok',
        displayName: 'ok',
        apiKey: 'k',
        urls: { anthropic: 'https://ok.example/anthropic' },
      },
      {
        id: 'p-paused',
        displayName: 'paused',
        apiKey: 'k',
        paused: true,
        urls: { anthropic: 'https://paused.example/anthropic' },
      },
    ]
    const lead = {
      ...custom('c1', 0, 'a'),
      providerId: 'p-ok',
      config: { baseUrl: '', apiKey: '', model: 'a' },
    } as AgentConfig
    const pausedPeer = {
      ...custom('c2', 1, 'b'),
      providerId: 'p-paused',
      config: { baseUrl: '', apiKey: '', model: 'b' },
    } as AgentConfig
    expect(launchSegment([lead, pausedPeer]).map((a) => a.id)).toEqual(['c1'])
  })

  it('a paused-provider LEADER throws so the selected agent fails loudly', () => {
    mockSettings.modelProviders = [
      {
        id: 'p-paused',
        displayName: 'paused',
        apiKey: 'k',
        paused: true,
        urls: { anthropic: 'https://paused.example/anthropic' },
      },
    ]
    const lead = {
      ...custom('c1', 0, 'a'),
      providerId: 'p-paused',
      config: { baseUrl: '', apiKey: '', model: 'a' },
    } as AgentConfig
    expect(() => launchSegment([lead])).toThrow(/paused/)
  })
})

describe('launchForCandidates — the leading member is always the one that runs', () => {
  it('a leading system member yields NO relay candidate and its own model override', () => {
    mockSettings.agents = [system('s1', 0, 'claude-opus-5'), custom('c1', 1, 'deepseek-v4')]
    const launch = launchForCandidates(resolveAgentCandidates(REF))
    expect(launch.relayCandidates).toBeUndefined()
    expect(launch.model).toBe('claude-opus-5')
  })

  it('a leading custom member relays only its own segment, never past a system member', () => {
    mockSettings.agents = [
      custom('c1', 0, 'deepseek-v4'),
      system('s1', 1),
      custom('c2', 2, 'kimi-k2'),
    ]
    const launch = launchForCandidates(resolveAgentCandidates(REF))
    expect(launch.relayCandidates?.map((c) => c.model)).toEqual(['deepseek-v4'])
  })
})

describe('the session group cursor moves a resume onto the next candidate', () => {
  it('resolveSessionLaunch starts from the cursor’s member', () => {
    mockSettings.agents = [system('s1', 0), custom('c1', 1, 'deepseek-v4')]
    expect(resolveSessionLaunch('s').relayCandidates).toBeUndefined()
    cursor = 'c1'
    expect(resolveSessionLaunch('s').relayCandidates?.map((c) => c.model)).toEqual(['deepseek-v4'])
  })

  it('advancing steps past the whole segment that just ran', () => {
    mockSettings.agents = [custom('c1', 0, 'a'), custom('c2', 1, 'b'), system('s1', 2)]
    // c1+c2 are one segment — the relay already tried both, so the next lead is s1.
    expect(advanceGroupCursor('s')).toBe('s1')
    expect(cursor).toBe('s1')
  })

  it('the group is a ring — advancing past the last member wraps to the first', () => {
    mockSettings.agents = [system('s1', 0), custom('c1', 1, 'a')]
    expect(advanceGroupCursor('s')).toBe('c1')
    // c1 is the tail; the next advance comes back round to s1 rather than stranding.
    expect(advanceGroupCursor('s')).toBe('s1')
  })

  it('a session bound to a plain agent has nothing to advance through', () => {
    mockSettings.agents = [custom('c1', 0, 'a', '')]
    boundRef = 'c1'
    expect(advanceGroupCursor('s')).toBeNull()
    expect(cursor).toBeNull()
  })

  it('a one-member group does not advance onto itself', () => {
    mockSettings.agents = [custom('c1', 0, 'a')]
    expect(advanceGroupCursor('s')).toBeNull()
  })

  it('a cursor naming a member that left the group falls back to the natural order', () => {
    mockSettings.agents = [custom('c1', 0, 'a'), custom('c2', 1, 'b')]
    cursor = 'gone'
    expect(resolveSessionLaunch('s').relayCandidates?.map((c) => c.model)).toEqual(['a', 'b'])
  })

  it('an unusable group is reported where it is actionable, not from the failure handler', () => {
    mockSettings.agents = []
    expect(advanceGroupCursor('s')).toBeNull()
  })
})
