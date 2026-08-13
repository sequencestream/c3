/**
 * Meta-test for the e2e settings guard. The guard's whole value is a code path
 * that fires only in a situation nobody sets up on purpose — so without these
 * assertions it would rot into dead code and nobody would notice until a real
 * `~/.c3/c3.db` (configuration included) got overwritten.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GUARD_REFUSED_EXIT_CODE,
  decideGuard,
  enforceIsolatedSettings,
  realDbPath,
  refusalMessage,
} from './settings-guard.mjs'
import { seedConfig, startIsolatedServer } from './isolated-server.mjs'

// Same runtime require as isolated-server.mjs — a static `node:sqlite` import
// would not survive vitest's module resolution.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

describe('decideGuard', () => {
  it('refuses the real ~/.c3/c3.db', () => {
    const verdict = decideGuard(realDbPath())
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain('real config')
  })

  it('refuses the real path written with a `~` prefix', () => {
    expect(decideGuard('~/.c3/c3.db').allowed).toBe(false)
  })

  it('refuses the real path reached through a non-canonical form', () => {
    // What a naive string compare misses: same file, different spelling.
    expect(decideGuard(join(homedir(), '.c3', '.', 'c3.db')).allowed).toBe(false)
  })

  it('allows an isolated database under a temp dir', () => {
    const verdict = decideGuard(join(tmpdir(), 'c3-e2e-suite-abc123', 'c3.db'))
    expect(verdict.allowed).toBe(true)
  })

  it('allows another c3.db inside ~/.c3 that is not the real one', () => {
    // `--db ~/.c3/e2e/c3.db` relocates the whole instance; only the exact real
    // file is off limits.
    expect(decideGuard(join(homedir(), '.c3', 'e2e', 'c3.db')).allowed).toBe(true)
  })

  it('refuses when the server reports no database path (older build)', () => {
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

    enforceIsolatedSettings(realDbPath(), {
      testScript: 'scripts/e2e/e2e-consensus-test.mjs',
      url: 'ws://localhost:13000/ws',
    })

    expect(exit).toHaveBeenCalledWith(GUARD_REFUSED_EXIT_CODE)
    expect(err.mock.calls[0][0]).toContain('node scripts/e2e/isolated-server.mjs --port 13000')
  })

  it('exits when the server reports no database path at all', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    enforceIsolatedSettings(undefined, { url: 'ws://localhost:13000/ws' })
    expect(exit).toHaveBeenCalledWith(GUARD_REFUSED_EXIT_CODE)
  })

  it('returns the path and neither exits nor prints for an isolated server', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined)
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const isolated = join(tmpdir(), 'c3-e2e-suite-xyz', 'c3.db')

    expect(enforceIsolatedSettings(isolated, { url: 'ws://localhost:13000/ws' })).toBe(isolated)
    expect(exit).not.toHaveBeenCalled()
    expect(err).not.toHaveBeenCalled()
  })
})

describe('isolated-server refuses to write the real ~/.c3', () => {
  /** Snapshot the real db so an accidental write shows up as a diff, not a guess. */
  function snapshot(path) {
    try {
      const s = statSync(path)
      return { size: s.size, mtimeMs: s.mtimeMs }
    } catch {
      return undefined // absent here — the refusal itself is then the whole assertion
    }
  }

  it('seedConfig throws on the real c3.db instead of overwriting it', () => {
    const before = snapshot(realDbPath())
    expect(() => seedConfig(realDbPath())).toThrow(/refusing to write the real/)
    expect(snapshot(realDbPath())).toEqual(before)
  })

  it('seedConfig throws on the real c3.db spelled with `~`', () => {
    expect(() => seedConfig('~/.c3/c3.db')).toThrow(/refusing to write the real/)
  })

  it('seedConfig writes an auth-stripped, import-stamped db to an isolated target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'c3-guard-seed-'))
    try {
      const target = seedConfig(join(dir, 'c3.db'))
      const db = new DatabaseSync(target, { readOnly: true })
      try {
        // The legacy-import markers must be stamped whether or not anything was
        // copied — otherwise the isolated server renames the developer's own files.
        const markers = db
          .prepare("SELECT id FROM schema_migrations WHERE id LIKE 'config.import_%'")
          .all()
        expect(markers.length).toBeGreaterThan(0)
        // Auth rows never travel: they would gate the WS handshake every e2e opens.
        const hasConfigs = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='system_configs'")
          .get()
        if (hasConfigs) {
          const auth = db
            .prepare("SELECT config_key FROM system_configs WHERE config_key LIKE 'auth%'")
            .all()
          expect(auth).toEqual([])
        }
      } finally {
        db.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('startIsolatedServer rejects `--state-dir ~/.c3` before booting anything', async () => {
    // The footgun this guards: the state dir IS the real config dir, so the
    // seeded db would land on top of the developer's own.
    const before = snapshot(realDbPath())
    await expect(startIsolatedServer({ stateDir: join(homedir(), '.c3') })).rejects.toThrow(
      /refusing to write the real ~\/\.c3\/c3\.db/,
    )
    expect(snapshot(realDbPath())).toEqual(before)
  })

  it('startIsolatedServer rejects a db path aimed at the real ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'c3-guard-db-'))
    try {
      await expect(startIsolatedServer({ stateDir: dir, dbPath: realDbPath() })).rejects.toThrow(
        /refusing to write the real ~\/\.c3\/c3\.db/,
      )
      // Refused before the first write: not even the isolated db exists.
      expect(existsSync(join(dir, 'c3.db'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
