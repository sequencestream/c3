import { describe, it, expect } from 'vitest'
import type { AgentConfig } from '@ccc/shared/protocol'
import { resolveAutomationDefaultAgent, scopedSeedRefs } from './resolveAutomationDefaultAgent'

const claude = (id: string, enabled?: boolean): AgentConfig => ({
  id,
  vendor: 'claude',
  configMode: 'custom',
  displayName: id,
  ...(enabled === undefined ? {} : { enabled }),
  config: { baseUrl: '', apiKey: '', model: '' },
})
const codex = (id: string): AgentConfig => ({
  id,
  vendor: 'codex',
  configMode: 'custom',
  displayName: id,
  config: { wireApi: 'chat', baseUrl: '', apiKey: '', model: '' },
})

describe('resolveAutomationDefaultAgent — create-form seed follow-chain (AC-R25)', () => {
  const agents = [claude('a1'), codex('a2'), claude('a3')]

  it('resolves a non-empty automationAgentId to that agent (with its vendor)', () => {
    expect(resolveAutomationDefaultAgent(agents, 'a2', 'a1')).toMatchObject({
      id: 'a2',
      vendor: 'codex',
    })
  })

  it('follows defaultAgentId when automationAgentId is empty', () => {
    expect(resolveAutomationDefaultAgent(agents, '', 'a2')).toMatchObject({ id: 'a2' })
  })

  it('falls back to the first enabled agent when both ids are empty', () => {
    expect(resolveAutomationDefaultAgent(agents, '', '')).toMatchObject({ id: 'a1' })
  })

  it('falls back to the first enabled agent when the wanted id is unknown', () => {
    expect(resolveAutomationDefaultAgent(agents, 'gone', '')).toMatchObject({ id: 'a1' })
  })

  it('never seeds a disabled agent — skips it in the enabled pool', () => {
    const withDisabled = [claude('a1', false), codex('a2')]
    // wanted points at the disabled a1 ⇒ falls back to first enabled (a2).
    expect(resolveAutomationDefaultAgent(withDisabled, 'a1', '')).toMatchObject({ id: 'a2' })
  })

  it('returns undefined when no enabled agent exists (caller applies system fallback)', () => {
    expect(resolveAutomationDefaultAgent([claude('a1', false)], 'a1', '')).toBeUndefined()
    expect(resolveAutomationDefaultAgent([], '', '')).toBeUndefined()
  })

  it('walks the full scoped chain: system role → workspace role → workspace default → system default', () => {
    // system automation role = a2 wins over everything below it.
    expect(resolveAutomationDefaultAgent(agents, 'a2', 'a3', 'a1', 'a1')).toMatchObject({
      id: 'a2',
    })
    // system role empty ⇒ workspace role override wins.
    expect(resolveAutomationDefaultAgent(agents, '', 'a3', 'a1', 'a2')).toMatchObject({
      id: 'a3',
    })
    // role links empty ⇒ workspace default wins over the system default.
    expect(resolveAutomationDefaultAgent(agents, '', '', 'a2', 'a1')).toMatchObject({
      id: 'a2',
    })
    // every configured link empty ⇒ first enabled agent.
    expect(resolveAutomationDefaultAgent(agents, '', '', '', '')).toMatchObject({ id: 'a1' })
  })

  it('trims whitespace on every link and skips dangling ids', () => {
    expect(resolveAutomationDefaultAgent(agents, '  ', '  a2  ', '', '')).toMatchObject({
      id: 'a2',
    })
    expect(resolveAutomationDefaultAgent(agents, ' gone ', '  ', 'a2', '')).toMatchObject({
      id: 'a2',
    })
  })
})

describe('scopedSeedRefs — the seed chain folds in the resolver order (AC-R33)', () => {
  it('keeps the system role field first while the workspace inherits', () => {
    expect(
      scopedSeedRefs({
        systemRoleRef: 'sys',
        workspaceRoleRef: 'ws',
        systemDefaultAgentId: 'sysdef',
      }),
    ).toEqual(['sys', 'ws', '', 'sysdef'])
  })

  it('moves the workspace layer ahead of the system role field once the workspace sets a default', () => {
    expect(
      scopedSeedRefs({
        systemRoleRef: 'sys',
        workspaceRoleRef: 'ws',
        workspaceDefaultAgentId: 'wsdef',
        systemDefaultAgentId: 'sysdef',
      }),
    ).toEqual(['ws', 'wsdef', 'sys', 'sysdef'])
  })

  it('treats a blank workspace default as inheriting', () => {
    expect(
      scopedSeedRefs({
        systemRoleRef: 'sys',
        workspaceRoleRef: 'ws',
        workspaceDefaultAgentId: '   ',
        systemDefaultAgentId: 'sysdef',
      }),
    ).toEqual(['sys', 'ws', '   ', 'sysdef'])
  })

  it('reads an absent workspace default as inheriting (the key is omitted on the wire)', () => {
    expect(scopedSeedRefs({ systemRoleRef: 'sys' })).toEqual(['sys', '', '', ''])
  })

  it('feeds the resolver so a workspace default beats a SET system role field', () => {
    const agents = [claude('sys'), claude('wsdef')]
    expect(
      resolveAutomationDefaultAgent(
        agents,
        ...scopedSeedRefs({
          systemRoleRef: 'sys',
          workspaceDefaultAgentId: 'wsdef',
        }),
      ),
    ).toMatchObject({ id: 'wsdef' })
  })
})
