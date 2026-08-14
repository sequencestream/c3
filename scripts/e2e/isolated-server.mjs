#!/usr/bin/env node
/**
 * Boot ONE c3 server that runs entirely on throwaway state — the only supported
 * way to run an e2e, by hand or from the suite.
 *
 * Isolation is ONE override: `--db <dir>/c3.db`. All configuration lives in that
 * database and the c3 home dir follows it, so nothing the server writes can reach
 * the real `~/.c3`. A caller that aims the override AT `~/.c3` anyway
 * (`--state-dir ~/.c3`, `--db ~/.c3/c3.db`) is refused before the first write —
 * the helper must not become the thing that clobbers the real config.
 *
 * The throwaway database is SEEDED from the real `~/.c3/c3.db` when one exists —
 * opened read-only, never written back, configuration tables only (no intents, no
 * sessions) — so tests that need real configured agents (consensus, relay, sandbox
 * tokens) still have them instead of SKIPping forever. `auth.*` is stripped: e2e
 * connect without a token, and an auth-enabled real config would otherwise gate the
 * WS handshake. The seed also stamps the legacy-import markers, so an isolated
 * server never reads — nor retires — the developer's own `~/.c3/settings.json`.
 *
 * Two shapes, one implementation:
 *   - CLI (foreground, for running a single e2e by hand):
 *       pnpm build && node scripts/e2e/isolated-server.mjs --port 13000
 *     Prints the ws:// url and the db path, then holds until Ctrl-C and removes
 *     the temp dir on the way out.
 *   - Function (`startIsolatedServer`), used by `run-all.mjs`, which brings its
 *     own state dir and db path.
 *
 * Building is NOT this helper's job — it launches `server/dist/cli.cjs`, so run
 * `pnpm build` first (the suite runner does that for you).
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isRealC3Path, realDbPath } from './settings-guard.mjs'

// Loaded through a runtime require, never a static import: this file is also
// imported by a vitest test, and Vite's resolver only knows the builtins listed
// in `module.builtinModules` — which excludes prefix-only modules like
// `node:sqlite`, so a static import dies at collection with "Failed to load url
// sqlite". A runtime require is opaque to the bundler and resolves normally.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite')

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/**
 * Configuration and authorization tables copied into a throwaway db. Session rows
 * start empty. The workspace-scope relations are copied too: they decide which
 * workspaces an account may reach, so an isolated server that dropped them would
 * answer differently from the real one for no reason the test asked for. A table
 * the source database does not have is skipped.
 */
const CONFIG_TABLES = [
  'workspaces',
  'system_configs',
  'workspace_configs',
  'personalized_configs',
  'mcp_api_keys',
  'user_workspace_scopes',
  'user_workspace_scope_items',
]

/** Import markers stamped into the seed so no isolated server touches legacy files. */
const IMPORT_MARKERS = [
  'config.import_workspaces.v1',
  'config.import_settings.v1',
  'config.import_session_state.v1',
]

/**
 * Create the throwaway database at `target`, seeded from the real `~/.c3/c3.db`
 * when one exists (read-only, configuration tables only). The table definitions are
 * taken from the source database rather than restated here, so this helper cannot
 * drift from the server's schema.
 *
 * Refuses when `target` IS the real `~/.c3/c3.db`, however it is spelled —
 * `--db ~/.c3/c3.db` would otherwise let an e2e rewrite the developer's own
 * configuration, the exact damage this helper exists to prevent.
 */
export function seedConfig(target) {
  assertNotRealC3File(target, realDbPath(), 'c3.db')
  const dst = new DatabaseSync(target)
  try {
    dst.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);',
    )
    const real = realDbPath()
    if (existsSync(real)) copyConfigTables(real, dst)
    // Stamped whether or not anything was copied: an isolated server must never
    // import (and thereby rename) the developer's own settings.json / state.json.
    const stamp = dst.prepare(
      'INSERT OR REPLACE INTO schema_migrations (id, applied_at) VALUES (?,?)',
    )
    for (const id of IMPORT_MARKERS) stamp.run(id, Date.now())
  } finally {
    dst.close()
  }
  return target
}

/** Copy the configuration tables of `sourcePath` into the already-open `dst`. */
function copyConfigTables(sourcePath, dst) {
  let src
  try {
    src = new DatabaseSync(sourcePath, { readOnly: true })
  } catch {
    // Locked, or written by a newer schema — start from an empty configuration
    // rather than failing the whole run.
    return
  }
  try {
    for (const table of CONFIG_TABLES) {
      const ddl = src
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)?.sql
      if (!ddl) continue
      dst.exec(ddl)
      const rows = src.prepare(`SELECT * FROM ${table}`).all()
      if (rows.length === 0) continue
      const columns = Object.keys(rows[0])
      const insert = dst.prepare(
        `INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${columns
          .map(() => '?')
          .join(',')})`,
      )
      for (const row of rows) {
        // Auth would gate the WS handshake that every e2e opens without a token.
        if (table === 'system_configs' && String(row.config_key).startsWith('auth')) continue
        insert.run(...columns.map((c) => row[c]))
      }
    }
  } finally {
    src.close()
  }
}

/**
 * Throw before any write when `target` resolves to the real `~/.c3` file
 * `realPath` names. A thrown error (not `process.exit`) so both the CLI and
 * `run-all.mjs` report it through their own error paths, and the meta-test can
 * assert it without mocking the process.
 */
function assertNotRealC3File(target, realPath, label) {
  if (!isRealC3Path(target, realPath)) return
  throw new Error(
    `refusing to write the real ~/.c3/${label} (${target}) — ` +
      'an isolated server must live outside ~/.c3; pass a --state-dir / --db under a temp dir',
  )
}

/** Resolve once a TCP connection to the port succeeds, or reject after `tries`. */
function waitForPort(port, tries = 60, intervalMs = 500) {
  return new Promise((resolvePromise, reject) => {
    let n = 0
    const attempt = () => {
      const sock = connect(port, '127.0.0.1')
      sock.once('connect', () => {
        sock.destroy()
        resolvePromise()
      })
      sock.once('error', () => {
        sock.destroy()
        if (++n >= tries) reject(new Error(`port ${port} not up after ${tries} tries`))
        else setTimeout(attempt, intervalMs)
      })
    }
    attempt()
  })
}

/**
 * Launch an isolated server and resolve once its port accepts connections.
 *
 * @param {object} [opts]
 * @param {number} [opts.port] HTTP/WS port (default 13000)
 * @param {string} [opts.stateDir] existing dir to hold the throwaway db (a fresh temp
 *   dir is created — and owned, i.e. removed by `cleanup()` — when omitted)
 * @param {string} [opts.dbPath] `--db` value (default `<stateDir>/c3.db`)
 * @param {number} [opts.waitTries] port-readiness attempts (500ms apart)
 * @returns {Promise<{server: import('node:child_process').ChildProcess, port: number,
 *   wsUrl: string, dbPath: string, stateDir: string, cleanup: () => void}>}
 *   `cleanup()` removes the temp dir only when this helper created it; the caller
 *   owns a dir it passed in.
 */
export async function startIsolatedServer(opts = {}) {
  const port = opts.port ?? 13000
  const ownsStateDir = !opts.stateDir
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), 'c3-e2e-'))
  const dbPath = opts.dbPath ?? join(stateDir, 'c3.db')
  // The refusal comes BEFORE the first mkdir/write: a caller aiming at ~/.c3
  // (`--state-dir ~/.c3`, `--db ~/.c3/c3.db`) leaves nothing behind.
  assertNotRealC3File(dbPath, realDbPath(), 'c3.db')
  mkdirSync(stateDir, { recursive: true })
  // A caller-supplied `--db` may name a dir that does not exist yet (the guide's
  // shared-ledger sections point several tests at one fixed path).
  mkdirSync(dirname(dbPath), { recursive: true })
  seedConfig(dbPath)

  const cleanup = () => {
    if (!ownsStateDir) return
    try {
      rmSync(stateDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }

  const server = spawn(
    'node',
    [join(ROOT, 'server', 'dist', 'cli.cjs'), 'start', '--port', String(port), '--db', dbPath],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, C3_DB_PATH: dbPath } },
  )

  try {
    await waitForPort(port, opts.waitTries ?? 60)
  } catch (err) {
    server.kill('SIGTERM')
    cleanup()
    throw err
  }

  return {
    server,
    port,
    wsUrl: `ws://localhost:${port}/ws`,
    dbPath,
    stateDir,
    cleanup,
  }
}

// ---- CLI ----------------------------------------------------------------

function argValue(argv, name) {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

async function main() {
  const argv = process.argv.slice(2)
  const port = Number(argValue(argv, '--port')) || 13000
  const stateDir = argValue(argv, '--state-dir')
  const dbPath = argValue(argv, '--db')

  const started = await startIsolatedServer({ port, stateDir, dbPath })
  console.log('')
  console.log(`\x1b[36m[isolated]\x1b[0m server up — the real ~/.c3 is untouched`)
  console.log(`\x1b[36m[isolated]\x1b[0m ws: ${started.wsUrl}`)
  console.log(`\x1b[36m[isolated]\x1b[0m db: ${started.dbPath}`)
  console.log(`\x1b[36m[isolated]\x1b[0m Ctrl-C to stop`)

  const stop = () => {
    started.server.kill('SIGTERM')
    started.cleanup()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  // Do not outlive the server: if it dies, so does this wrapper.
  started.server.on('exit', (code) => {
    started.cleanup()
    process.exit(code ?? 0)
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[isolated] ${err.message}`)
    process.exit(1)
  })
}
