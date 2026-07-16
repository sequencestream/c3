/**
 * Vendor-neutral sandbox data-root resolution (ADR-0015 store scope). Covers the
 * host defaults (CODEX_HOME / CLAUDE_CONFIG_DIR honoured), the isolated codex
 * sandbox home vs the shared claude config dir, and the scope-ordered root list
 * the codex read/list path scans.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import {
  getSandboxClaudeConfigDir,
  getSandboxCodexHome,
  hostClaudeConfigDir,
  hostCodexHome,
  resolveVendorStoreDir,
} from './workspace-path.js'
import { codexStoreRoots } from '../agent/adapters/codex/session-store.js'

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.CODEX_HOME
  delete process.env.CLAUDE_CONFIG_DIR
})

describe('host data roots', () => {
  it('hostCodexHome honours CODEX_HOME, else ~/.codex', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/u')
    expect(hostCodexHome()).toBe('/home/u/.codex')
    process.env.CODEX_HOME = '/custom/codex'
    expect(hostCodexHome()).toBe('/custom/codex')
  })

  it('hostClaudeConfigDir honours CLAUDE_CONFIG_DIR, else ~/.claude', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/u')
    expect(hostClaudeConfigDir()).toBe('/home/u/.claude')
    process.env.CLAUDE_CONFIG_DIR = '/custom/claude'
    expect(hostClaudeConfigDir()).toBe('/custom/claude')
  })
})

describe('sandbox data roots', () => {
  it('codex sandbox home is an isolated per-workspace dir under c3 home', () => {
    const home = getSandboxCodexHome('/abs/my/proj')
    // Isolated (not the host ~/.codex) and workspace-scoped.
    expect(home).toContain(path.join('sandbox-home', 'abs-my-proj', '.codex'))
    expect(home).not.toBe(hostCodexHome())
  })

  it('claude sandbox config dir reuses the HOST claude config dir', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/u')
    // Shared with the host so a sandbox-written transcript stays host-readable.
    expect(getSandboxClaudeConfigDir('/abs/proj')).toBe(hostClaudeConfigDir())
  })
})

describe('resolveVendorStoreDir', () => {
  it('routes codex by scope: host → ~/.codex, sandbox → isolated home', () => {
    expect(resolveVendorStoreDir('codex', '/abs/proj', 'host')).toBe(hostCodexHome())
    expect(resolveVendorStoreDir('codex', '/abs/proj', 'sandbox')).toBe(
      getSandboxCodexHome('/abs/proj'),
    )
  })

  it('routes claude to the host config dir for both scopes', () => {
    expect(resolveVendorStoreDir('claude', '/abs/proj', 'host')).toBe(hostClaudeConfigDir())
    expect(resolveVendorStoreDir('claude', '/abs/proj', 'sandbox')).toBe(hostClaudeConfigDir())
  })
})

describe('codexStoreRoots (scan order = frozen scope first, other as fallback)', () => {
  it('sandbox scope scans the sandbox home first', () => {
    expect(codexStoreRoots('/abs/proj', 'sandbox')).toEqual([
      getSandboxCodexHome('/abs/proj'),
      hostCodexHome(),
    ])
  })

  it('host scope scans host first, sandbox as dual-scan fallback', () => {
    expect(codexStoreRoots('/abs/proj', 'host')).toEqual([
      hostCodexHome(),
      getSandboxCodexHome('/abs/proj'),
    ])
  })
})
