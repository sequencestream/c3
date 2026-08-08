/**
 * Meta-test for the e2e settings guard. The guard's whole value is a code path
 * that fires only in a situation nobody sets up on purpose — so without these
 * assertions it would rot into dead code and nobody would notice until a real
 * `~/.c3/settings.json` got overwritten.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GUARD_REFUSED_EXIT_CODE,
  decideGuard,
  enforceIsolatedSettings,
  realSettingsPath,
  refusalMessage,
} from './settings-guard.mjs'

describe('decideGuard', () => {
  it('refuses the real ~/.c3/settings.json', () => {
    const verdict = decideGuard(realSettingsPath())
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain('real config')
  })

  it('refuses the real path written with a `~` prefix', () => {
    expect(decideGuard('~/.c3/settings.json').allowed).toBe(false)
  })

  it('refuses the real path reached through a non-canonical form', () => {
    // What a naive string compare misses: same file, different spelling.
    expect(decideGuard(join(homedir(), '.c3', '.', 'settings.json')).allowed).toBe(false)
  })

  it('allows an isolated settings path under a temp dir', () => {
    const verdict = decideGuard(join(tmpdir(), 'c3-e2e-suite-abc123', 'settings.json'))
    expect(verdict.allowed).toBe(true)
  })

  it('allows another settings.json inside ~/.c3 that is not the real one', () => {
    // `--settings ~/.c3/e2e/settings.json` relocates the whole config dir; only
    // the exact real file is off limits.
    expect(decideGuard(join(homedir(), '.c3', 'e2e', 'settings.json')).allowed).toBe(true)
  })

  it('refuses when the server reports no settings path (older build)', () => {
    expect(decideGuard(undefined).allowed).toBe(false)
    expect(decideGuard('').allowed).toBe(false)
    expect(decideGuard(undefined).reason).toContain('older build')
  })
})

describe('refusalMessage', () => {
  it('names the isolated-server helper and how to re-run the test', () => {
    const msg = refusalMessage('the server is running on the real config', {
      testScript: 'scripts/e2e/e2e-consensus-test.mjs',
      port: 13000,
    })
    expect(msg).toContain('[e2e-guard] REFUSED')
    expect(msg).toContain('node scripts/e2e/isolated-server.mjs --port 13000')
    expect(msg).toContain('node scripts/e2e/e2e-consensus-test.mjs ws://localhost:13000/ws')
  })

  it('still prints a usable command when the caller names no script', () => {
    expect(refusalMessage('reason')).toContain('scripts/e2e/isolated-server.mjs')
  })
})

describe('enforceIsolatedSettings', () => {
  afterEach(() => vi.restoreAllMocks())

  it('exits with the refusal code and prints the fix when handed the real path', () => {
    // The whole point of the guard: this path must actually stop the process,
    // not merely return a verdict object nobody checks.
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    enforceIsolatedSettings(realSettingsPath(), {
      testScript: 'scripts/e2e/e2e-consensus-test.mjs',
      url: 'ws://localhost:13000/ws',
    })

    expect(exit).toHaveBeenCalledWith(GUARD_REFUSED_EXIT_CODE)
    expect(err.mock.calls[0][0]).toContain('node scripts/e2e/isolated-server.mjs --port 13000')
  })

  it('exits when the server reports no settings path at all', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    enforceIsolatedSettings(undefined, { url: 'ws://localhost:13000/ws' })
    expect(exit).toHaveBeenCalledWith(GUARD_REFUSED_EXIT_CODE)
  })

  it('returns the path and neither exits nor prints for an isolated server', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const isolated = join(tmpdir(), 'c3-e2e-suite-xyz', 'settings.json')

    expect(enforceIsolatedSettings(isolated, { url: 'ws://localhost:13000/ws' })).toBe(isolated)
    expect(exit).not.toHaveBeenCalled()
    expect(err).not.toHaveBeenCalled()
  })
})
