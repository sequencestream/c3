/**
 * Scope-aware default-agent resolution: explicit reference → the task's workspace
 * `defaultAgentId` override → the system `defaultAgentId` → `system`.
 *
 * These tests drive the resolver with DELIBERATELY un-normalized settings — the
 * storage layer would have rewritten an emptied group reference long before a run
 * sees it, so injecting one here is the only way to prove the runtime still refuses
 * to route around it instead of quietly following the default.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AgentConfig, SystemSettings, WorkspaceSetting } from '@ccc/shared/protocol'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'

/** A claude agent; array position doubles as `order_seq`. */
function agent(id: string, extra: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id,
    vendor: 'claude',
    configMode: 'system',
    displayName: id,
    config: { baseUrl: '', apiKey: '', model: '' },
    ...extra,
  } as AgentConfig
}

const settings: SystemSettings = {
  agents: [agent('d'), agent('a'), agent('b'), agent('c')],
  defaultAgentId: 'a',
  toolAgentId: '',
  intentAgentId: '',
  specAgentId: '',
  specReviewAgentId: '',
  automationAgentId: '',
  degradationChain: [],
  modelProviders: [],
} as unknown as SystemSettings

/** Per-workspace stored configuration the mocked `loadWorkspaceSetting` serves. */
const workspaces: Record<string, WorkspaceSetting> = {}

vi.mock('../config/index.js', () => ({
  loadSettings: vi.fn(() => settings),
  loadWorkspaceSetting: vi.fn((ws: string) => workspaces[ws] ?? {}),
  getSessionAgentId: vi.fn(() => null),
  getSessionGroupCursor: vi.fn(() => null),
  getSessionStoreScope: vi.fn(() => null),
  getProxyConfig: vi.fn(() => ({ enabled: false, httpProxy: '', httpsProxy: '' })),
  bindSessionAgent: vi.fn(),
  changeSessionAgentFact: vi.fn(() => true),
  setPendingIntent: vi.fn(),
  setSessionGroupCursor: vi.fn(),
  saveSettings: vi.fn(),
}))

// Import AFTER the mock is in place.
import {
  AgentGroupUnavailableError,
  resolveAgentTarget,
  resolveRoleAgentTarget,
  tryResolveRoleAgentTarget,
} from './index.js'

const WS_X = 'ws-x'
const WS_Y = 'ws-y'

beforeEach(() => {
  settings.agents = [agent('d'), agent('a'), agent('b'), agent('c')]
  settings.defaultAgentId = 'a'
  settings.toolAgentId = ''
  settings.intentAgentId = ''
  settings.specAgentId = ''
  settings.specReviewAgentId = ''
  for (const key of Object.keys(workspaces)) delete workspaces[key]
})

describe('inheritance — a workspace with no override follows the system default', () => {
  it('resolves an empty role to the system default, in a workspace and without one', () => {
    expect(resolveRoleAgentTarget('spec', WS_X).ref).toBe('a')
    expect(resolveRoleAgentTarget('spec').ref).toBe('a')
    expect(resolveRoleAgentTarget('default', WS_X).ref).toBe('a')
  })

  it('follows a LATER system change instead of a value frozen at read time', () => {
    expect(resolveRoleAgentTarget('default', WS_X).ref).toBe('a')
    settings.defaultAgentId = 'b'
    expect(resolveRoleAgentTarget('default', WS_X).ref).toBe('b')
    // The workspace still stores nothing — inheriting is a relation, not a copy.
    expect(workspaces[WS_X]).toBeUndefined()
  })
})

describe('override — a workspace default wins over the system one', () => {
  it('uses the override inside its workspace and leaves other workspaces inheriting', () => {
    workspaces[WS_X] = { defaultAgentId: 'b' }
    expect(resolveRoleAgentTarget('default', WS_X).ref).toBe('b')
    expect(resolveRoleAgentTarget('spec', WS_X).ref).toBe('b')
    expect(resolveRoleAgentTarget('default', WS_Y).ref).toBe('a')
    // A task with no workspace at all keeps using the system value.
    expect(resolveRoleAgentTarget('default').ref).toBe('a')
  })

  it('does NOT override an explicit system-level role choice', () => {
    workspaces[WS_X] = { defaultAgentId: 'b' }
    settings.specAgentId = 'c'
    expect(resolveRoleAgentTarget('spec', WS_X).ref).toBe('c')
    expect(resolveRoleAgentTarget('spec', WS_Y).ref).toBe('c')
  })

  it('goes back to inheriting the moment the override is cleared', () => {
    workspaces[WS_X] = { defaultAgentId: 'b' }
    expect(resolveRoleAgentTarget('default', WS_X).ref).toBe('b')
    delete workspaces[WS_X]
    expect(resolveRoleAgentTarget('default', WS_X).ref).toBe('a')
  })

  it('keeps a GROUP override as the group reference, represented by its first member', () => {
    settings.agents = [agent('d'), agent('a'), agent('m', { group: 'fast' })]
    workspaces[WS_X] = { defaultAgentId: '_c3_claude_fast' }
    const target = resolveRoleAgentTarget('default', WS_X)
    expect(target.ref).toBe('_c3_claude_fast')
    expect(target.isGroup).toBe(true)
    // Display vendor and the member actually launched come from the same read.
    expect(target.agent.id).toBe('m')
    expect(target.agent.vendor).toBe('claude')
  })
})

describe('delete degradation — a cleared role lands on the default, not on a neighbour', () => {
  it('resolves a cleared role to the scope default even though D precedes it in order', () => {
    // The registry order is D, A, B, C — so "the next enabled agent" after a deleted
    // C would be D. A cleared role must land on the DEFAULT (A) instead.
    settings.agents = [agent('d'), agent('a'), agent('b')]
    settings.specAgentId = '' // normalize cleared it when C was deleted
    expect(resolveRoleAgentTarget('spec', WS_Y).ref).toBe('a')
    workspaces[WS_X] = { defaultAgentId: 'b' }
    expect(resolveRoleAgentTarget('spec', WS_X).ref).toBe('b')
  })

  it('falls through a role still holding a DELETED id (the compat path)', () => {
    settings.agents = [agent('d'), agent('a'), agent('b')]
    settings.specAgentId = 'c'
    workspaces[WS_X] = { defaultAgentId: 'b' }
    expect(resolveRoleAgentTarget('spec', WS_X).ref).toBe('b')
    expect(resolveRoleAgentTarget('spec', WS_Y).ref).toBe('a')
  })
})

describe('final fallback — a session is never locked out', () => {
  it('uses the system agent when the workspace override and the system default are both gone', () => {
    settings.agents = [agent(SYSTEM_AGENT_ID), agent('a')]
    settings.defaultAgentId = 'gone'
    workspaces[WS_X] = { defaultAgentId: 'also-gone' }
    expect(resolveRoleAgentTarget('default', WS_X).ref).toBe(SYSTEM_AGENT_ID)
  })

  it('synthesizes a fallback when the registry has no system entry either', () => {
    settings.agents = []
    settings.defaultAgentId = ''
    workspaces[WS_X] = { defaultAgentId: 'gone' }
    const target = resolveRoleAgentTarget('default', WS_X)
    expect(target.ref).toBe(SYSTEM_AGENT_ID)
    expect(target.agent.vendor).toBe('claude')
  })
})

describe('an empty group stops resolution at every link of the chain', () => {
  const emptyGroup = '_c3_claude_fast'

  it('throws for an explicit group reference', () => {
    expect(() => resolveAgentTarget(emptyGroup, null, WS_X)).toThrow(AgentGroupUnavailableError)
  })

  it('throws when an empty role follows a WORKSPACE default pointing at an empty group', () => {
    workspaces[WS_X] = { defaultAgentId: emptyGroup }
    expect(() => resolveRoleAgentTarget('spec', WS_X)).toThrow(AgentGroupUnavailableError)
    // …even though A and `system` would both have been available.
    const result = tryResolveRoleAgentTarget('spec', WS_X)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.groupRef).toBe(emptyGroup)
  })

  it('throws when the INHERITED system default is an empty group', () => {
    settings.defaultAgentId = emptyGroup
    expect(() => resolveRoleAgentTarget('spec', WS_X)).toThrow(AgentGroupUnavailableError)
    expect(tryResolveRoleAgentTarget('spec', WS_X).ok).toBe(false)
  })

  it('contrasts with a missing CONCRETE reference, which does reach the fallback', () => {
    workspaces[WS_X] = { defaultAgentId: 'gone' }
    expect(resolveRoleAgentTarget('spec', WS_X).ref).toBe('a')
  })
})
