#!/usr/bin/env node
/**
 * Boot ONE c3 server that runs entirely on throwaway state — the only supported
 * way to run an e2e, by hand or from the suite.
 *
 * Isolation is two overrides working together: `--settings <dir>/settings.json`
 * relocates the whole config dir (settings.json AND its sibling state.json), and
 * `C3_DB_PATH` points the intent db at the same throwaway dir. Nothing the server
 * writes can reach the real `~/.c3`.
 *
 * The throwaway settings.json is SEEDED from the real `~/.c3/settings.json` when
 * one exists — read-only, never written back — so tests that need real configured
 * agents (consensus, relay, sandbox tokens) still have them instead of SKIPping
 * forever. `auth` is stripped: e2e connect without a token, and an auth-enabled
 * real config would otherwise gate the WS handshake.
 *
 * Two shapes, one implementation:
 *   - CLI (foreground, for running a single e2e by hand):
 *       pnpm build && node scripts/e2e/isolated-server.mjs --port 13000
 *     Prints the ws:// url, the settings path and the db path, then holds until
 *     Ctrl-C and removes the temp dir on the way out.
 *   - Function (`startIsolatedServer`), used by `run-all.mjs`, which brings its
 *     own state dir and db path.
 *
 * Building is NOT this helper's job — it launches `server/dist/cli.cjs`, so run
 * `pnpm build` first (the suite runner does that for you).
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** The real config, used ONLY as a read-only seed source. */
export function realSettingsFile() {
  return join(homedir(), '.c3', 'settings.json')
}

/**
 * Write an isolated settings.json at `target`, seeded from the real one when
 * present and always without `auth`. Absent real file ⇒ `{}` (the server
 * normalizes that to the default single-agent config).
 */
export function seedSettings(target) {
  let settings = {}
  try {
    settings = JSON.parse(readFileSync(realSettingsFile(), 'utf-8'))
  } catch {
    /* no real settings — start from empty (default agent) */
  }
  delete settings.auth
  writeFileSync(target, JSON.stringify(settings, null, 2))
  return target
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
 * @param {string} [opts.stateDir] existing dir to hold settings.json (a fresh temp
 *   dir is created — and owned, i.e. removed by `cleanup()` — when omitted)
 * @param {string} [opts.dbPath] `C3_DB_PATH` value (default `<stateDir>/c3.db`)
 * @param {number} [opts.waitTries] port-readiness attempts (500ms apart)
 * @returns {Promise<{server: import('node:child_process').ChildProcess, port: number,
 *   wsUrl: string, settingsPath: string, dbPath: string, stateDir: string,
 *   cleanup: () => void}>} `cleanup()` removes the temp dir only when this helper
 *   created it; the caller owns a dir it passed in.
 */
export async function startIsolatedServer(opts = {}) {
  const port = opts.port ?? 13000
  const ownsStateDir = !opts.stateDir
  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), 'c3-e2e-'))
  mkdirSync(stateDir, { recursive: true })
  const dbPath = opts.dbPath ?? join(stateDir, 'c3.db')
  // A caller-supplied `--db` may name a dir that does not exist yet (the guide's
  // shared-ledger sections point several tests at one fixed path).
  mkdirSync(dirname(dbPath), { recursive: true })
  const settingsPath = seedSettings(join(stateDir, 'settings.json'))

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
    [
      join(ROOT, 'server', 'dist', 'cli.cjs'),
      'start',
      '--port',
      String(port),
      '--settings',
      settingsPath,
    ],
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
    settingsPath,
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
  console.log(`\x1b[36m[isolated]\x1b[0m ws:       ${started.wsUrl}`)
  console.log(`\x1b[36m[isolated]\x1b[0m settings: ${started.settingsPath}`)
  console.log(`\x1b[36m[isolated]\x1b[0m db:       ${started.dbPath}`)
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
