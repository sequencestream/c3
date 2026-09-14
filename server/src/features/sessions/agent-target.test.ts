/**
 * The session-creation gate over agent-role resolution: which refusals are the
 * creation path's business.
 *
 * Two rules, and the asymmetry between them is the point:
 *  - a GROUP whose vendor runtime is missing is "no usable member" — refused, so
 *    the user is told to fix the configuration instead of watching a session fail
 *    to launch later;
 *  - a CONCRETE agent whose vendor runtime is missing is NOT refused — that stays
 *    the session's own availability signal, exactly as before.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AgentConfig, SystemSettings, VendorId, WorkspaceSetting } from '@ccc/shared/protocol'

const settings: SystemSettings = {
  agents: [],
  defaultAgentId: '',
  toolAgentId: '',
  intentAgentId: '',
  specAgentId: '',
  specReviewAgentId: '',
  automationAgentId: '',
  reviewAgentId: '',
  fixAgentId: '',
  workAgentId: '',
}

const workspaceSettings: Record<string, WorkspaceSetting> = {}

vi.mock('../../kernel/config/index.js', () => ({
  loadSettings: () => settings,
  loadWorkspaceSetting: (workspacePath: string) => workspaceSettings[workspacePath] ?? {},
  getSessionAgentId: () => null,
  getProxyConfig: () => ({ enabled: false, httpProxy: '', httpsProxy: '' }),
  getSessionStoreScope: () => 'host',
  bindSessionAgent: vi.fn(),
  changeSessionAgentFact: vi.fn(() => true),
  setPendingIntent: vi.fn(),
  saveSettings: vi.fn(),
}))

let available: Set<VendorId> = new Set(['claude'])
vi.mock('../../kernel/agent/vendor-runtime.js', () => ({
  availableVendorSet: () => available,
}))

import {
  groupUnavailableError,
  sessionAgentTargetForRef,
  sessionAgentTargetForRole,
} from './agent-target.js'

function agent(id: string, over: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id,
    vendor: 'claude',
    configMode: 'system',
    displayName: id,
    enabled: true,
    order_seq: 0,
    config: { baseUrl: '', apiKey: '', model: '' },
    ...over,
  } as AgentConfig
}

beforeEach(() => {
  available = new Set<VendorId>(['claude'])
  settings.agents = [agent('a1', { group: 'fast', order_seq: 0 }), agent('plain', { order_seq: 1 })]
  settings.defaultAgentId = 'plain'
  settings.intentAgentId = ''
  settings.specAgentId = ''
  settings.specReviewAgentId = ''
  settings.toolAgentId = ''
  settings.reviewAgentId = ''
  settings.fixAgentId = ''
  for (const k of Object.keys(workspaceSettings)) delete workspaceSettings[k]
})

describe('sessionAgentTargetForRole', () => {
  it('passes a group whose vendor can run', () => {
    settings.intentAgentId = '_c3_claude_fast'
    const result = sessionAgentTargetForRole('intent')
    expect(result).toMatchObject({ ok: true })
    if (result.ok) {
      expect(result.target.ref).toBe('_c3_claude_fast')
      expect(result.target.agent.id).toBe('a1')
    }
  })

  it('refuses a group whose vendor has no runtime, naming the group', () => {
    settings.intentAgentId = '_c3_claude_fast'
    available = new Set<VendorId>()
    expect(sessionAgentTargetForRole('intent')).toEqual({
      ok: false,
      groupRef: '_c3_claude_fast',
    })
  })

  it('refuses a group with no enabled member, naming the group', () => {
    settings.agents = [agent('a1', { group: 'fast', enabled: false }), agent('plain')]
    settings.specAgentId = '_c3_claude_fast'
    expect(sessionAgentTargetForRole('spec')).toEqual({ ok: false, groupRef: '_c3_claude_fast' })
  })

  it('does NOT refuse a concrete agent whose vendor has no runtime', () => {
    available = new Set<VendorId>()
    expect(sessionAgentTargetForRole('intent')).toMatchObject({ ok: true })
  })

  it('follows a GROUP default when the role field is empty', () => {
    settings.defaultAgentId = '_c3_claude_fast'
    const result = sessionAgentTargetForRole('spec')
    expect(result.ok && result.target.ref).toBe('_c3_claude_fast')
  })
})

describe('sessionAgentTargetForRef (the explicit pick / Auto)', () => {
  it('Auto (null) follows the default role', () => {
    settings.defaultAgentId = '_c3_claude_fast'
    expect(sessionAgentTargetForRef(null)).toMatchObject({
      ok: true,
      target: { ref: '_c3_claude_fast' },
    })
  })

  it('an explicitly picked unusable group is refused like a role one', () => {
    available = new Set<VendorId>()
    expect(sessionAgentTargetForRef('_c3_claude_fast')).toEqual({
      ok: false,
      groupRef: '_c3_claude_fast',
    })
  })
})

describe('groupUnavailableError', () => {
  it('carries the group reference the user must fix', () => {
    expect(groupUnavailableError('_c3_claude_fast')).toEqual({
      code: 'agent.groupUnavailable',
      params: { group: '_c3_claude_fast' },
    })
  })
})

describe('workspace role overrides in the resolution order (runtime roles)', () => {
  const WS = 'ws-1'

  it('an explicit system role field wins over the workspace role override', () => {
    settings.specAgentId = 'plain'
    workspaceSettings[WS] = { specAgentId: 'a1' }
    const result = sessionAgentTargetForRole('spec', WS)
    expect(result.ok && result.target.ref).toBe('plain')
  })

  it('falls to the workspace role override when the system role follows the default', () => {
    settings.specAgentId = ''
    workspaceSettings[WS] = { specAgentId: 'a1', defaultAgentId: 'plain' }
    const result = sessionAgentTargetForRole('spec', WS)
    expect(result.ok && result.target.ref).toBe('a1')
  })

  it('falls to the workspace default before the system default', () => {
    settings.specAgentId = ''
    workspaceSettings[WS] = { defaultAgentId: 'a1' }
    settings.defaultAgentId = 'plain'
    const result = sessionAgentTargetForRole('spec', WS)
    expect(result.ok && result.target.ref).toBe('a1')
  })

  it('ends on the system default when every workspace link is empty', () => {
    settings.specAgentId = ''
    workspaceSettings[WS] = {}
    settings.defaultAgentId = 'plain'
    const result = sessionAgentTargetForRole('spec', WS)
    expect(result.ok && result.target.ref).toBe('plain')
  })

  it('keeps group routing through a workspace role override (ref + representative member)', () => {
    settings.specAgentId = ''
    workspaceSettings[WS] = { specAgentId: '_c3_claude_fast' }
    const result = sessionAgentTargetForRole('spec', WS)
    expect(result.ok && result.target.ref).toBe('_c3_claude_fast')
    expect(result.ok && result.target.agent.id).toBe('a1')
  })

  it('hard-fails an emptied group in the workspace role override instead of falling through', () => {
    settings.agents = [agent('a1', { group: 'fast', enabled: false }), agent('plain')]
    settings.specAgentId = ''
    workspaceSettings[WS] = { specAgentId: '_c3_claude_fast' }
    expect(sessionAgentTargetForRole('spec', WS)).toEqual({
      ok: false,
      groupRef: '_c3_claude_fast',
    })
  })

  it('review / fix do NOT read their workspace role override — they fall to the workspace default', () => {
    settings.reviewAgentId = ''
    workspaceSettings[WS] = { reviewAgentId: 'a1', defaultAgentId: 'plain' }
    const result = sessionAgentTargetForRole('review', WS)
    expect(result.ok && result.target.ref).toBe('plain')

    settings.fixAgentId = ''
    workspaceSettings[WS] = { fixAgentId: 'a1', defaultAgentId: 'plain' }
    const fix = sessionAgentTargetForRole('fix', WS)
    expect(fix.ok && fix.target.ref).toBe('plain')
  })

  it('keeps work workspace-first while the other runtime roles remain system-first', () => {
    settings.workAgentId = 'plain'
    settings.specAgentId = 'plain'
    workspaceSettings[WS] = {
      defaultAgentId: 'plain',
      workAgentId: 'a1',
      specAgentId: 'a1',
    }
    const work = sessionAgentTargetForRole('work', WS)
    const spec = sessionAgentTargetForRole('spec', WS)
    expect(work.ok && work.target.ref).toBe('a1')
    expect(spec.ok && spec.target.ref).toBe('plain')
    settings.specAgentId = ''
    const inheritedSpec = sessionAgentTargetForRole('spec', WS)
    expect(inheritedSpec.ok && inheritedSpec.target.ref).toBe('a1')
    delete workspaceSettings[WS].workAgentId
    const inheritedWork = sessionAgentTargetForRole('work', WS)
    expect(inheritedWork.ok && inheritedWork.target.ref).toBe('plain')
  })

  it('roles do not chain: spec review never inherits the spec role', () => {
    settings.specAgentId = 'a1'
    settings.specReviewAgentId = ''
    workspaceSettings[WS] = { defaultAgentId: 'plain' }
    const result = sessionAgentTargetForRole('spec_review', WS)
    expect(result.ok && result.target.ref).toBe('plain')
  })
})
