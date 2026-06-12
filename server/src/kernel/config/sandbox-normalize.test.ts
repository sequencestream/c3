/**
 * Tests for the sandbox-related invariants in `normalizeWorkspaceSetting`
 * (2026-06-12-003): worktree-only + custom-only.
 *
 * `normalizeSandboxConfig` is internal, so we exercise it through the exported
 * `normalizeWorkspaceSetting(raw, agents)` entry point.
 */
import { describe, it, expect } from 'vitest'
import { normalizeWorkspaceSetting } from './index.js'
import type { AgentConfig } from '@ccc/shared/protocol'

/** Build a minimal claude AgentConfig for the tests. */
function claudeAgent(
  id: string,
  opts: { enabled?: boolean; configMode?: 'system' | 'custom' } = {},
): AgentConfig {
  return {
    id,
    vendor: 'claude',
    configMode: opts.configMode ?? 'custom',
    displayName: id,
    enabled: opts.enabled ?? true,
    icon: '',
    config: { baseUrl: '', apiKey: '', model: '' },
  }
}

/** A fully valid sandbox config block (worktree-eligible). */
const SANDBOX_RAW = {
  enabled: true,
  sandbox: 'default',
  agentIds: ['a-custom'],
}

describe('normalizeWorkspaceSetting — sandbox worktree-only invariant', () => {
  it('drops the whole sandbox config when gitBranchMode is not worktree', () => {
    const result = normalizeWorkspaceSetting(
      { gitBranchMode: 'current-branch', sandbox: SANDBOX_RAW },
      [claudeAgent('a-custom')],
    )
    expect(result.sandbox).toBeUndefined()
  })

  it('keeps the sandbox config when gitBranchMode is worktree', () => {
    const result = normalizeWorkspaceSetting({ gitBranchMode: 'worktree', sandbox: SANDBOX_RAW }, [
      claudeAgent('a-custom'),
    ])
    expect(result.sandbox).toBeDefined()
    expect(result.sandbox?.enabled).toBe(true)
    expect(result.sandbox?.sandbox).toBe('default')
  })
})

describe('normalizeWorkspaceSetting — sandbox custom-only invariant', () => {
  it('drops agentIds that reference no known agent', () => {
    const result = normalizeWorkspaceSetting(
      {
        gitBranchMode: 'worktree',
        sandbox: { enabled: true, sandbox: 'default', agentIds: ['ghost', 'a-custom'] },
      },
      [claudeAgent('a-custom')],
    )
    expect(result.sandbox?.agentIds).toEqual(['a-custom'])
  })

  it('filters out system and disabled agents, keeping only enabled custom ones', () => {
    const result = normalizeWorkspaceSetting(
      {
        gitBranchMode: 'worktree',
        sandbox: {
          enabled: true,
          sandbox: 'default',
          agentIds: ['a-system', 'a-disabled', 'a-custom'],
        },
      },
      [
        claudeAgent('a-system', { configMode: 'system' }),
        claudeAgent('a-disabled', { enabled: false }),
        claudeAgent('a-custom'),
      ],
    )
    expect(result.sandbox?.agentIds).toEqual(['a-custom'])
  })

  it('omits agentIds entirely when every referenced id is filtered out', () => {
    const result = normalizeWorkspaceSetting(
      {
        gitBranchMode: 'worktree',
        sandbox: { enabled: true, sandbox: 'default', agentIds: ['a-system'] },
      },
      [claudeAgent('a-system', { configMode: 'system' })],
    )
    expect(result.sandbox?.agentIds).toBeUndefined()
    // The rest of the sandbox config still survives.
    expect(result.sandbox?.enabled).toBe(true)
  })
})
