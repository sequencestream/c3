/**
 * Meta-test for the e2e settings guard. The guard's whole value is a code path
 * that fires only in a situation nobody sets up on purpose — so without these
 * assertions it would rot into dead code and nobody would notice until a real
 * `~/.c3/settings.json` got overwritten.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GUARD_REFUSED_EXIT_CODE,
  decideGuard,
  enforceIsolatedSettings,
  realDbPath,
  realSettingsPath,
  refusalMessage,
} from './settings-guard.mjs'
import { seedSettings, startIsolatedServer } from './isolated-server.mjs'

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

describe('isolated-server refuses to write the real ~/.c3', () => {
  /** Snapshot the real file so an accidental write shows up as a diff, not a guess. */
  function snapshot(path) {
    try {
      return { content: readFileSync(path, 'utf-8'), mtimeMs: statSync(path).mtimeMs }
    } catch {
      return undefined // absent here — the refusal itself is then the whole assertion
    }
  }

  it('seedSettings throws on the real settings.json instead of overwriting it', () => {
    const before = snapshot(realSettingsPath())
    expect(() => seedSettings(realSettingsPath())).toThrow(/refusing to write the real/)
    expect(snapshot(realSettingsPath())).toEqual(before)
  })

  it('seedSettings throws on the real settings.json spelled with `~`', () => {
    expect(() => seedSettings('~/.c3/settings.json')).toThrow(/refusing to write the real/)
  })

  it('seedSettings still writes an auth-stripped copy to an isolated target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'c3-guard-seed-'))
    try {
      const target = seedSettings(join(dir, 'settings.json'))
      expect(JSON.parse(readFileSync(target, 'utf-8')).auth).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('startIsolatedServer rejects `--state-dir ~/.c3` before booting anything', async () => {
    // The footgun this guards: the state dir IS the real config dir, so the
    // seeded settings.json would land on top of the developer's own.
    const before = snapshot(realSettingsPath())
    await expect(startIsolatedServer({ stateDir: join(homedir(), '.c3') })).rejects.toThrow(
      /refusing to write the real ~\/\.c3\/settings\.json/,
    )
    expect(snapshot(realSettingsPath())).toEqual(before)
  })

  it('startIsolatedServer rejects a db path aimed at the real ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c3-guard-db-'))
    try {
      await expect(startIsolatedServer({ stateDir: dir, dbPath: realDbPath() })).rejects.toThrow(
        /refusing to write the real ~\/\.c3\/c3\.db/,
      )
      // Refused before the first write: not even the isolated settings.json exists.
      expect(() => statSync(join(dir, 'settings.json'))).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
