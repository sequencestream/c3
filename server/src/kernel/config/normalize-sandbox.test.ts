/**
 * Unit tests for the sandbox-config normalize invariants (arapuca):
 * - branch-independent: the sandbox config is preserved under BOTH gitBranchMode
 *   values (switching modes never drops a saved sandbox config)
 * - extraMounts: same-path passthrough, read-only by default, absolute paths only
 * - sandboxSessionKinds: dedupe, drop unknown, empty → ['work']
 * - legacy container keys are read and dropped (no semantic carry-over)
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

describe('normalizeSandboxConfig invariants (via normalizeWorkspaceSetting)', () => {
  it('keeps sandbox under current-branch (branch-independent)', () => {
    const result = normalizeWorkspaceSetting(
      { gitBranchMode: 'current-branch', sandbox: { enabled: true } },
      [agent('a', 'custom', true)],
    )
    expect(result.sandbox).toMatchObject({ enabled: true })
  })

  it('keeps sandbox when gitBranchMode is absent (defaults to worktree)', () => {
    const result = normalizeWorkspaceSetting({ sandbox: { enabled: true } }, [])
    expect(result.sandbox).toMatchObject({ enabled: true })
  })

  it('keeps enabled under worktree', () => {
    const result = normalizeWorkspaceSetting(
      { gitBranchMode: 'worktree', sandbox: { enabled: true } },
      [],
    )
    expect(result.sandbox).toMatchObject({ enabled: true })
  })

  it('preserves the sandbox config across a branch-mode switch (no silent drop)', () => {
    const saved = {
      sandbox: {
        enabled: true,
        extraMounts: [{ path: '/opt/cache' }],
        sandboxSessionKinds: ['work', 'intent'],
      },
    }
    const worktree = normalizeWorkspaceSetting({ gitBranchMode: 'worktree', ...saved }, [])
    const currentBranch = normalizeWorkspaceSetting(
      { gitBranchMode: 'current-branch', ...saved },
      [],
    )
    expect(currentBranch.sandbox).toEqual(worktree.sandbox)
    expect(currentBranch.sandbox).toMatchObject({ enabled: true })
  })

  it('keeps extraMounts, defaulting readonly to true and preserving explicit false', () => {
    const result = normalizeWorkspaceSetting(
      {
        gitBranchMode: 'worktree',
        sandbox: {
          enabled: true,
          extraMounts: [
            { path: '/opt/cache' }, // default ro
            { path: '/opt/rw', readonly: false }, // explicit rw
          ],
        },
      },
      [],
    )
    expect(result.sandbox?.extraMounts).toEqual([
      { path: '/opt/cache' },
      { path: '/opt/rw', readonly: false },
    ])
  })

  it('drops extraMounts entries that are not absolute paths and de-dupes', () => {
    const result = normalizeWorkspaceSetting(
      {
        gitBranchMode: 'worktree',
        sandbox: {
          enabled: true,
          extraMounts: [
            { path: 'relative/dir' }, // dropped — not absolute
            { path: '  ' }, // dropped — blank
            { path: '/opt/a' },
            { path: '/opt/a' }, // dropped — duplicate
          ],
        },
      },
      [],
    )
    expect(result.sandbox?.extraMounts).toEqual([{ path: '/opt/a' }])
  })

  it('normalizes sandboxSessionKinds: dedupe + drop unknown values', () => {
    const result = normalizeWorkspaceSetting(
      {
        gitBranchMode: 'worktree',
        sandbox: {
          enabled: true,
          sandboxSessionKinds: ['work', 'intent', 'work', 'bogus'],
        },
      },
      [],
    )
    expect(result.sandbox?.sandboxSessionKinds).toEqual(['work', 'intent'])
  })

  it('falls back sandboxSessionKinds to ["work"] when none survive', () => {
    const result = normalizeWorkspaceSetting(
      {
        gitBranchMode: 'worktree',
        sandbox: { enabled: true, sandboxSessionKinds: ['bogus'] },
      },
      [],
    )
    expect(result.sandbox?.sandboxSessionKinds).toEqual(['work'])
  })

  it('reads and drops legacy container keys without carry-over', () => {
    const result = normalizeWorkspaceSetting(
      {
        gitBranchMode: 'worktree',
        sandbox: {
          enabled: true,
          sandbox: 'default',
          allowExternalNetwork: true,
          readonlyRootfs: false,
          imageOverride: 'node:20',
          agentIds: ['a'],
          networkDisabled: true,
        },
      },
      [agent('a', 'custom', true)],
    )
    // enabled survives; every legacy container key is dropped.
    expect(result.sandbox).toEqual({ enabled: true })
  })

  it('returns undefined when nothing meaningful is set', () => {
    const result = normalizeWorkspaceSetting(
      { gitBranchMode: 'worktree', sandbox: { imageOverride: 'node:20' } },
      [],
    )
    expect(result.sandbox).toBeUndefined()
  })

  it('keeps an explicit non-default sessionRetentionDays (floored, clamped up)', () => {
    const result = normalizeWorkspaceSetting(
      { sandbox: { enabled: true, sessionRetentionDays: 7.9 } },
      [],
    )
    expect(result.sandbox).toMatchObject({ enabled: true, sessionRetentionDays: 7 })
  })

  it('clamps a below-floor sessionRetentionDays up to the minimum', () => {
    const result = normalizeWorkspaceSetting(
      { sandbox: { enabled: true, sessionRetentionDays: 0 } },
      [],
    )
    // 0 is not finite-positive after clamp semantics → treated as absent (default applies).
    expect(result.sandbox?.sessionRetentionDays).toBeUndefined()
  })

  it('omits sessionRetentionDays when it equals the default (keeps config clean)', () => {
    const result = normalizeWorkspaceSetting(
      { sandbox: { enabled: true, sessionRetentionDays: 30 } },
      [],
    )
    expect(result.sandbox).toEqual({ enabled: true })
  })

  it('drops a non-finite sessionRetentionDays', () => {
    const result = normalizeWorkspaceSetting(
      { sandbox: { enabled: true, sessionRetentionDays: 'lots' } },
      [],
    )
    expect(result.sandbox?.sessionRetentionDays).toBeUndefined()
  })
})
