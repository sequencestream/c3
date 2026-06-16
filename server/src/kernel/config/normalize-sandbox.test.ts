/**
 * Unit tests for the sandbox-config normalize invariants (2026-06-12):
 * - worktree-only: sandbox is dropped unless gitBranchMode === 'worktree'
 * - custom-only: agentIds keeps only enabled custom agent ids
 *
 * Exercised through the public `normalizeWorkspaceSetting(raw, agents)`.
 */
import { describe, it, expect } from 'vitest'
import { normalizeWorkspaceSetting } from './index.js'
import type { AgentConfig } from '@ccc/shared/protocol'

/** Minimal claude AgentConfig builder — only the fields normalize reads matter. */
function agent(id: string, configMode: 'system' | 'custom', enabled: boolean): AgentConfig {
  return {
    id,
    vendor: 'claude',
    configMode,
    displayName: id,
    enabled,
    icon: '',
    config: { baseUrl: '', apiKey: '', model: '' },
  } as unknown as AgentConfig
}

const ENABLED_SANDBOX = { enabled: true, sandbox: 'default' }

describe('normalizeSandboxConfig invariants (via normalizeWorkspaceSetting)', () => {
  it('drops sandbox entirely when gitBranchMode is not worktree', () => {
    const result = normalizeWorkspaceSetting(
      { gitBranchMode: 'current-branch', sandbox: { ...ENABLED_SANDBOX } },
      [agent('a', 'custom', true)],
    )
    expect(result.sandbox).toBeUndefined()
  })

  it('drops sandbox when gitBranchMode is absent (defaults to current-branch)', () => {
    const result = normalizeWorkspaceSetting({ sandbox: { ...ENABLED_SANDBOX } }, [])
    expect(result.sandbox).toBeUndefined()
  })

  it('keeps sandbox under worktree and retains valid custom agent ids', () => {
    const result = normalizeWorkspaceSetting(
      { gitBranchMode: 'worktree', sandbox: { ...ENABLED_SANDBOX, agentIds: ['a', 'ghost'] } },
      [agent('a', 'custom', true)],
    )
    expect(result.sandbox).toMatchObject({ enabled: true, sandbox: 'default' })
    // 'ghost' is not a known agent → dropped; 'a' is enabled custom → kept.
    expect(result.sandbox?.agentIds).toEqual(['a'])
  })

  it('filters out system and disabled agents from agentIds', () => {
    const result = normalizeWorkspaceSetting(
      {
        gitBranchMode: 'worktree',
        sandbox: { ...ENABLED_SANDBOX, agentIds: ['sys', 'dis', 'ok'] },
      },
      [
        agent('sys', 'system', true), // system → excluded
        agent('dis', 'custom', false), // disabled → excluded
        agent('ok', 'custom', true), // enabled custom → kept
      ],
    )
    expect(result.sandbox?.agentIds).toEqual(['ok'])
  })

  it('omits agentIds when none survive the custom-only filter', () => {
    const result = normalizeWorkspaceSetting(
      { gitBranchMode: 'worktree', sandbox: { ...ENABLED_SANDBOX, agentIds: ['sys'] } },
      [agent('sys', 'system', true)],
    )
    expect(result.sandbox).toMatchObject({ enabled: true, sandbox: 'default' })
    expect(result.sandbox?.agentIds).toBeUndefined()
  })

  it('de-duplicates agentIds while preserving first-seen order', () => {
    const result = normalizeWorkspaceSetting(
      {
        gitBranchMode: 'worktree',
        sandbox: { ...ENABLED_SANDBOX, agentIds: ['b', 'a', 'b'] },
      },
      [agent('a', 'custom', true), agent('b', 'custom', true)],
    )
    expect(result.sandbox?.agentIds).toEqual(['b', 'a'])
  })

  it('persists explicit networkDisabled / readonlyRootfs (true and false survive)', () => {
    const loosened = normalizeWorkspaceSetting(
      {
        gitBranchMode: 'worktree',
        sandbox: { ...ENABLED_SANDBOX, networkDisabled: false, readonlyRootfs: false },
      },
      [],
    )
    // A `false` (loosen the deny-by-default policy) must round-trip, not be dropped.
    expect(loosened.sandbox?.networkDisabled).toBe(false)
    expect(loosened.sandbox?.readonlyRootfs).toBe(false)

    const tightened = normalizeWorkspaceSetting(
      {
        gitBranchMode: 'worktree',
        sandbox: { ...ENABLED_SANDBOX, networkDisabled: true, readonlyRootfs: true },
      },
      [],
    )
    expect(tightened.sandbox?.networkDisabled).toBe(true)
    expect(tightened.sandbox?.readonlyRootfs).toBe(true)
  })

  it('omits the security policies when unset (deny-by-default applies at merge)', () => {
    const result = normalizeWorkspaceSetting(
      { gitBranchMode: 'worktree', sandbox: { ...ENABLED_SANDBOX } },
      [],
    )
    expect(result.sandbox?.networkDisabled).toBeUndefined()
    expect(result.sandbox?.readonlyRootfs).toBeUndefined()
  })
})
