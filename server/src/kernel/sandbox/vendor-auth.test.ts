/**
 * Per-vendor sandbox auth strategy — unit tests.
 *
 * Table-driven over the four real authentication paths (claude custom, claude
 * subscription on macOS and off it, codex relay, codex subscription), asserting
 * the resolved profile field by field: data root + its variable, credential
 * variable names, mounts, keychain grant and pre-run dirs. Host facts are
 * injected, so the macOS-only rule is exercised from any host.
 *
 * Two invariants get their own tests because they are security boundaries rather
 * than behaviour: no vendor's credential variables or data root appear in another
 * vendor's profile, and an unregistered vendor fails closed instead of yielding a
 * credential-less "generic" profile.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'

// The workspace-path helpers reach the config module for the c3 home; stub it so
// these tests never touch a real settings file.
vi.mock('../config/index.js', () => ({
  c3HomeDir: vi.fn(() => '/c3home'),
  getProjectSandbox: vi.fn(() => undefined),
}))

import { hostCodexHome } from '../config/workspace-path.js'
import { SandboxLaunchError } from './errors.js'
import {
  readHostFacts,
  resolveSandboxAuthProfile,
  VENDOR_AUTH_PROFILES,
  type SandboxAuthProfile,
  type SandboxAuthResolver,
  type SandboxHostFacts,
} from './vendor-auth.js'
import type { VendorId } from '@ccc/shared/protocol'
import type { ResolvedSandboxPaths } from './types.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const PATHS: ResolvedSandboxPaths = {
  executionRoot: '/work/tree',
  workspaceRoot: '/work/src',
  specsBase: '/c3home/specs/work-src',
  codexHome: '/c3home/relay/codex',
  claudeConfigDir: '/home/dev/.claude',
  extra: [],
  arapucaBin: '/usr/local/bin/arapuca',
}

/** Host facts with a deterministic home / login / uid and a controllable existence check. */
function facts(over: Partial<SandboxHostFacts> = {}): SandboxHostFacts {
  return {
    platform: 'linux',
    homeDir: '/home/dev',
    loginName: 'dev',
    uid: 501,
    canonicalize: (path) => (path === '/tmp' ? '/private/tmp' : path),
    exists: () => true,
    ...over,
  }
}

function resolve(
  vendor: VendorId,
  systemAuth: boolean,
  host: SandboxHostFacts = facts(),
): SandboxAuthProfile {
  return resolveSandboxAuthProfile(vendor, { paths: PATHS, systemAuth, host })
}

/** The profile's literal env as a plain object, for readable assertions. */
function literalEnv(profile: SandboxAuthProfile): Record<string, string> {
  return Object.fromEntries(profile.literalEnv.map((v) => [v.name, v.value]))
}

/** Every rw/ro mount path the profile contributes. */
function mountPaths(profile: SandboxAuthProfile): string[] {
  return profile.mounts.map((m) => m.path)
}

// ─── Claude ──────────────────────────────────────────────────────────────────

describe('claude auth profile', () => {
  it('pins CLAUDE_CONFIG_DIR and forwards only ANTHROPIC_* for a custom (API-key) agent', () => {
    const profile = resolve('claude', false)
    expect(profile.entryCommand).toBe('claude')
    expect(profile.allowKeychain).toBe(false)
    expect(literalEnv(profile)).toEqual({ CLAUDE_CONFIG_DIR: PATHS.claudeConfigDir })
    expect(profile.forwardEnv).toEqual([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
    ])
    // The config dir (transcripts) and claude's hardcoded per-user runtime dir,
    // by its canonical path; the global config sibling belongs to the keychain
    // path only.
    expect(mountPaths(profile)).toEqual([PATHS.claudeConfigDir, '/private/tmp/claude-501'])
    expect(profile.mounts.every((m) => !m.readonly)).toBe(true)
    // The runtime dir is pre-created at its HOST path (arapuca matches canonical).
    expect(profile.preRunDirs).toEqual(['/tmp/claude-501'])
  })

  it('drops CLAUDE_CONFIG_DIR and forwards the login name for a macOS subscription agent', () => {
    const profile = resolve('claude', true, facts({ platform: 'darwin' }))
    // Setting CLAUDE_CONFIG_DIR is exactly what flips claude off the Keychain.
    expect(literalEnv(profile)).toEqual({ USER: 'dev', LOGNAME: 'dev' })
    expect(profile.allowKeychain).toBe(true)
    // The config dir is still mounted — transcripts land there either way — plus
    // the global config sibling the keychain path reads.
    expect(mountPaths(profile)).toEqual([
      PATHS.claudeConfigDir,
      '/private/tmp/claude-501',
      '/home/dev/.claude.json',
    ])
  })

  it('omits the global config mount when the host has no ~/.claude.json (a fresh install)', () => {
    const host = facts({ platform: 'darwin', exists: (p) => p !== '/home/dev/.claude.json' })
    // Mounting a path that does not exist aborts the run, so it must be skipped.
    expect(mountPaths(resolve('claude', true, host))).not.toContain('/home/dev/.claude.json')
  })

  it('keeps CLAUDE_CONFIG_DIR for a subscription agent off macOS (file store, no keychain flip)', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const profile = resolve('claude', true, facts({ platform }))
      expect(literalEnv(profile)).toEqual({ CLAUDE_CONFIG_DIR: PATHS.claudeConfigDir })
      expect(mountPaths(profile)).not.toContain('/home/dev/.claude.json')
      // The keychain grant itself is platform-independent — c3 does not gate the
      // subscription mode by platform, only the CLAUDE_CONFIG_DIR rule.
      expect(profile.allowKeychain).toBe(true)
    }
  })
})

// ─── Codex ───────────────────────────────────────────────────────────────────

describe('codex auth profile', () => {
  it('keeps a custom (relay) agent on the isolated per-workspace CODEX_HOME', () => {
    const profile = resolve('codex', false)
    expect(profile.entryCommand).toBe('codex')
    expect(profile.allowKeychain).toBe(false)
    expect(literalEnv(profile)).toEqual({ CODEX_HOME: PATHS.codexHome })
    expect(profile.forwardEnv).toEqual(['CODEX_API_KEY'])
    expect(profile.mounts).toEqual([{ path: PATHS.codexHome, readonly: false }])
    expect(profile.preRunDirs).toEqual([])
    // The host codex store stays invisible to a relay run.
    expect(mountPaths(profile)).not.toContain(hostCodexHome())
  })

  it('points a subscription agent at the HOST codex home (auth.json lives there)', () => {
    const profile = resolve('codex', true)
    expect(literalEnv(profile)).toEqual({ CODEX_HOME: hostCodexHome() })
    expect(profile.mounts).toEqual([{ path: hostCodexHome(), readonly: false }])
    expect(profile.allowKeychain).toBe(true)
    // The isolated sandbox home is not used at all in this mode.
    expect(mountPaths(profile)).not.toContain(PATHS.codexHome)
  })
})

// ─── Cross-vendor isolation ──────────────────────────────────────────────────

describe('vendor isolation', () => {
  it('never leaks one vendor’s credential variables or data root into another', () => {
    for (const systemAuth of [false, true]) {
      const claude = resolve('claude', systemAuth, facts({ platform: 'darwin' }))
      const codex = resolve('codex', systemAuth)
      const claudeNames = [...claude.forwardEnv, ...claude.literalEnv.map((v) => v.name)]
      const codexNames = [...codex.forwardEnv, ...codex.literalEnv.map((v) => v.name)]
      expect(claudeNames.some((n) => n.startsWith('CODEX'))).toBe(false)
      expect(codexNames.some((n) => n.startsWith('ANTHROPIC') || n.startsWith('CLAUDE'))).toBe(
        false,
      )
      expect(mountPaths(claude)).not.toContain(PATHS.codexHome)
      expect(mountPaths(claude)).not.toContain(hostCodexHome())
      expect(mountPaths(codex)).not.toContain(PATHS.claudeConfigDir)
      expect(codex.preRunDirs).toEqual([])
    }
  })
})

// ─── Registry ────────────────────────────────────────────────────────────────

describe('profile registry', () => {
  it('fails closed on a vendor with no registered strategy', () => {
    // A missing strategy must not degrade into a wrapper with no data root and no
    // credential channel — that would run unauthenticated and store state loose.
    expect(() =>
      resolveSandboxAuthProfile('acme' as VendorId, {
        paths: PATHS,
        systemAuth: false,
        host: facts(),
      }),
    ).toThrow(SandboxLaunchError)
  })

  it('covers every known vendor', () => {
    for (const vendor of ['claude', 'codex'] as const) {
      expect(VENDOR_AUTH_PROFILES[vendor]).toBeTypeOf('function')
    }
  })

  it('reads the ambient host facts consistently with the process', () => {
    const host = readHostFacts()
    expect(host.platform).toBe(process.platform)
    expect(host.loginName).toBeTruthy()
    expect(host.exists(join(process.cwd(), 'package.json'))).toBe(true)
    // A path that cannot be canonicalized comes back unchanged rather than throwing.
    expect(host.canonicalize('/definitely/not/here')).toBe('/definitely/not/here')
  })

  it('accepts a new vendor as a single registry entry — no launcher change', () => {
    // A hypothetical vendor with its own data root, credential and runtime dir:
    // one resolver, registered, is the entire integration surface.
    const acme: SandboxAuthResolver = ({ systemAuth, host }) => ({
      entryCommand: 'acme-cli',
      allowKeychain: false,
      literalEnv: [{ name: 'ACME_HOME', value: join(host.homeDir, '.acme') }],
      forwardEnv: systemAuth ? [] : ['ACME_TOKEN'],
      mounts: [{ path: join(host.homeDir, '.acme'), readonly: false }],
      preRunDirs: [],
    })
    const registry = VENDOR_AUTH_PROFILES as Record<string, SandboxAuthResolver>
    registry.acme = acme
    try {
      const profile = resolveSandboxAuthProfile('acme' as VendorId, {
        paths: PATHS,
        systemAuth: false,
        host: facts(),
      })
      expect(profile.entryCommand).toBe('acme-cli')
      expect(literalEnv(profile)).toEqual({ ACME_HOME: '/home/dev/.acme' })
      expect(profile.forwardEnv).toEqual(['ACME_TOKEN'])
    } finally {
      delete registry.acme
    }
  })
})
