/**
 * Scope-aware default-agent resolution: explicit reference → the task's workspace
 * `defaultAgentId` override → the system `defaultAgentId` → `system`, and the
 * ROLE-chain variant where a workspace that configured a default agent of its own
 * claims the roles it has not overridden — its whole workspace layer moves ahead of
 * the system role fields (see `resolveRoleAgentTarget`).
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
  workAgentId: '',
  toolAgentId: '',
  intentAgentId: '',
  specAgentId: '',
  specReviewAgentId: '',
  automationAgentId: '',
  reviewAgentId: '',
  fixAgentId: '',
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
import type { AgentRole } from './index.js'
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
  settings.workAgentId = ''
  settings.toolAgentId = ''
  settings.intentAgentId = ''
  settings.specAgentId = ''
  settings.specReviewAgentId = ''
  settings.reviewAgentId = ''
  settings.fixAgentId = ''
  for (const key of Object.keys(workspaces)) delete workspaces[key]
})

type RoleField =
  'toolAgentId' | 'intentAgentId' | 'specAgentId' | 'specReviewAgentId' | 'workAgentId'

/** The four runtime roles that read BOTH a system field and a workspace override. */
const OVERRIDE_ROLES: Array<{
  role: AgentRole
  systemField: RoleField
  workspaceField: RoleField
}> = [
  { role: 'tool', systemField: 'toolAgentId', workspaceField: 'toolAgentId' },
  { role: 'intent', systemField: 'intentAgentId', workspaceField: 'intentAgentId' },
  { role: 'spec', systemField: 'specAgentId', workspaceField: 'specAgentId' },
  { role: 'spec_review', systemField: 'specReviewAgentId', workspaceField: 'specReviewAgentId' },
]

/**
 * The five RUNTIME roles and the settings field each reads. `work` has no workspace
 * role field — its workspace override rides the prior chain instead — and it is
 * workspace-first in BOTH modes, so it never takes the system-first shape below.
 */
const RUNTIME_ROLES: Array<{
  role: AgentRole
  systemField: RoleField
  workspaceField?: RoleField
}> = [...OVERRIDE_ROLES, { role: 'work', systemField: 'workAgentId' }]

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

  it('takes the roles with it — an explicit workspace default outranks the system role field', () => {
    workspaces[WS_X] = { defaultAgentId: 'b' }
    settings.specAgentId = 'c'
    expect(resolveRoleAgentTarget('spec', WS_X).ref).toBe('b')
    // A workspace that did NOT configure a default keeps the system role choice.
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

describe('work — the workspace-first chain resolves workAgentId before the default', () => {
  it('follows the default chain when no work override is set anywhere', () => {
    // No workspace work, no system work → workspace default → system default.
    expect(resolveRoleAgentTarget('work', WS_X).ref).toBe('a')
    workspaces[WS_X] = { defaultAgentId: 'b' }
    expect(resolveRoleAgentTarget('work', WS_X).ref).toBe('b')
  })

  it('uses the workspace workAgentId override before anything else', () => {
    workspaces[WS_X] = { workAgentId: 'c' }
    settings.workAgentId = 'd'
    expect(resolveRoleAgentTarget('work', WS_X).ref).toBe('c')
    // Other workspaces without their own override fall through to the system work value.
    expect(resolveRoleAgentTarget('work', WS_Y).ref).toBe('d')
  })

  it('falls through an empty workspace override to the system workAgentId', () => {
    workspaces[WS_X] = { workAgentId: '' }
    settings.workAgentId = 'b'
    expect(resolveRoleAgentTarget('work', WS_X).ref).toBe('b')
  })

  it('falls through to the default chain when both work values are empty', () => {
    workspaces[WS_X] = { workAgentId: '', defaultAgentId: 'c' }
    settings.workAgentId = ''
    expect(resolveRoleAgentTarget('work', WS_X).ref).toBe('c')
  })

  it('does NOT leak the work chain into other roles', () => {
    workspaces[WS_X] = { workAgentId: 'c' }
    settings.workAgentId = 'd'
    // `spec` still resolves through the default chain, untouched by work overrides.
    expect(resolveRoleAgentTarget('spec', WS_X).ref).toBe('a')
  })
})

describe('workspace-default precedence — an explicit workspace default claims every role', () => {
  it.each(RUNTIME_ROLES)(
    'role $role: an explicit workspace default A beats the system role field B',
    ({ role, systemField }) => {
      settings[systemField] = 'b'
      workspaces[WS_X] = { defaultAgentId: 'a' }
      expect(resolveRoleAgentTarget(role, WS_X).ref).toBe('a')
      // The system role field still runs — just after the workspace layer — so a
      // workspace WITHOUT an explicit default keeps resolving to it.
      expect(resolveRoleAgentTarget(role, WS_Y).ref).toBe('b')
      // …and it is not dropped from the chain: with the workspace default gone the
      // same workspace lands back on B.
      delete workspaces[WS_X]
      expect(resolveRoleAgentTarget(role, WS_X).ref).toBe('b')
    },
  )

  it.each(RUNTIME_ROLES)(
    'role $role: a workspace default that is a GROUP binds the group ref',
    ({ role, systemField }) => {
      settings.agents = [agent('d'), agent('b'), agent('m', { group: 'fast' })]
      settings[systemField] = 'b'
      workspaces[WS_X] = { defaultAgentId: '_c3_claude_fast' }
      const target = resolveRoleAgentTarget(role, WS_X)
      expect(target.ref).toBe('_c3_claude_fast')
      expect(target.isGroup).toBe(true)
      expect(target.agent.id).toBe('m')
    },
  )

  it('keeps the workspace role override ahead of the workspace default', () => {
    settings.specAgentId = 'b'
    workspaces[WS_X] = { specAgentId: 'c', defaultAgentId: 'a' }
    expect(resolveRoleAgentTarget('spec', WS_X).ref).toBe('c')
  })

  it('applies to review / fix too — the queue chain follows the workspace default first', () => {
    settings.reviewAgentId = 'b'
    settings.fixAgentId = 'd'
    workspaces[WS_X] = { defaultAgentId: 'a' }
    expect(resolveRoleAgentTarget('review', WS_X).ref).toBe('a')
    expect(resolveRoleAgentTarget('fix', WS_X).ref).toBe('a')
    // Inheriting workspaces keep the system review/fix role.
    expect(resolveRoleAgentTarget('review', WS_Y).ref).toBe('b')
    expect(resolveRoleAgentTarget('fix', WS_Y).ref).toBe('d')
  })

  it('ignores the workspace review / fix role fields — they are template seeds, not routes', () => {
    settings.reviewAgentId = 'b'
    workspaces[WS_X] = { reviewAgentId: 'c', defaultAgentId: 'a' }
    expect(resolveRoleAgentTarget('review', WS_X).ref).toBe('a')
  })

  it('leaves the default role on the workspace default (no role field to reorder)', () => {
    // The system default is NOT promoted into the explicit slot — that would make
    // the workspace default unreachable.
    workspaces[WS_X] = { defaultAgentId: 'b' }
    settings.defaultAgentId = 'a'
    expect(resolveRoleAgentTarget('default', WS_X).ref).toBe('b')
  })

  it('does not reorder anything for a workspace whose default is blank or non-string', () => {
    settings.specAgentId = 'b'
    workspaces[WS_X] = { defaultAgentId: '   ' }
    expect(resolveRoleAgentTarget('spec', WS_X).ref).toBe('b')
    workspaces[WS_X] = {}
    expect(resolveRoleAgentTarget('spec', WS_X).ref).toBe('b')
  })

  it('keeps an explicit pick ahead of an explicit workspace default', () => {
    settings.agents = [agent('a'), agent('c'), agent('m', { group: 'fast' })]
    workspaces[WS_X] = { defaultAgentId: 'a' }
    expect(resolveAgentTarget('c', null, WS_X).ref).toBe('c')
    const group = resolveAgentTarget('_c3_claude_fast', null, WS_X)
    expect(group.ref).toBe('_c3_claude_fast')
    expect(group.agent.id).toBe('m')
  })

  it('stops on a workspace default pointing at an EMPTY group, for every role', () => {
    const emptyGroup = '_c3_claude_fast'
    settings.specAgentId = 'b'
    settings.toolAgentId = 'b'
    workspaces[WS_X] = { defaultAgentId: emptyGroup }
    for (const { role } of RUNTIME_ROLES) {
      expect(() => resolveRoleAgentTarget(role, WS_X)).toThrow(AgentGroupUnavailableError)
      // No silent fall-through to the system role field that would have answered.
      expect(tryResolveRoleAgentTarget(role, WS_X)).toEqual({ ok: false, groupRef: emptyGroup })
    }
  })
})

describe('workspace-first role chains — the work role, and the untouched inheritance order', () => {
  it('walk each of the four work levels in turn', () => {
    // 1. workspace workAgentId
    settings.workAgentId = 'd'
    workspaces[WS_X] = { workAgentId: 'c', defaultAgentId: 'b' }
    expect(resolveRoleAgentTarget('work', WS_X).ref).toBe('c')

    // 2. the workspace default, once the workspace work override is empty — this
    //    is where the reorder shows: the system work value no longer pre-empts it
    workspaces[WS_X] = { workAgentId: '', defaultAgentId: 'b' }
    expect(resolveRoleAgentTarget('work', WS_X).ref).toBe('b')

    // 3. the SYSTEM work value, once the workspace default is gone too
    workspaces[WS_X] = { workAgentId: '', defaultAgentId: 'gone' }
    expect(resolveRoleAgentTarget('work', WS_X).ref).toBe('d')

    // 4. the system default, once both work values are empty
    settings.workAgentId = ''
    expect(resolveRoleAgentTarget('work', WS_X).ref).toBe('a')
  })

  it.each(OVERRIDE_ROLES)(
    'role $role: without the default key the order is untouched — system role → workspace role → system default',
    ({ role, systemField, workspaceField }) => {
      const workspace = { [workspaceField]: 'c' }
      workspaces[WS_X] = workspace
      settings[systemField] = 'b'
      // The system role field still leads a workspace that configured no default.
      expect(resolveRoleAgentTarget(role, WS_X).ref).toBe('b')

      settings[systemField] = ''
      // …then the workspace's own role override.
      expect(resolveRoleAgentTarget(role, WS_X).ref).toBe('c')

      // …then straight to the system default: with no default key there is no
      // workspace-default link for the system role to have been moved behind.
      delete workspace[workspaceField as keyof typeof workspace]
      expect(resolveRoleAgentTarget(role, WS_X).ref).toBe('a')
    },
  )
})
