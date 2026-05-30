#!/usr/bin/env node
/**
 * E2E suite runner — boots one c3 server and runs every WebSocket e2e against it,
 * then tears the server down and reports a pass/fail summary. Wired as `pnpm e2e`.
 *
 * Isolation: the requirement db is pointed at a throwaway `C3_DB_PATH` so the run
 * never touches the real `~/.c3/c3.db`. Agent config (`~/.c3/settings.json`) is
 * left untouched — the consensus tests need the real agents, and skip themselves
 * (exit 5) when none beyond the default are configured.
 *
 * The server is built first (`pnpm build`) unless `--no-build` / `E2E_NO_BUILD=1`.
 * Override the port with `--port` / `E2E_PORT`. The one-off SDK spike
 * (`spike-ask-answer-injection.mjs`) is intentionally excluded — it runs no
 * server and proves an SDK detail, not a c3 flow.
 *
 * Exit codes per test: 0 = PASS, 5 = SKIP (e.g. consensus with no voters),
 * anything else = FAIL. The suite exits non-zero if any test FAILs.
 *
 * Usage:
 *   pnpm e2e                 # build, boot, run all, report
 *   pnpm e2e --no-build      # reuse the existing server/dist build
 *   pnpm e2e --port 13550
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const argv = process.argv.slice(2)
const NO_BUILD = argv.includes('--no-build') || process.env.E2E_NO_BUILD === '1'
const portArg = (() => {
  const i = argv.indexOf('--port')
  return i >= 0 ? argv[i + 1] : process.env.E2E_PORT
})()
const PORT = Number(portArg) || 13099
const WS_URL = `ws://localhost:${PORT}/ws`

// Throwaway state dir: isolates the requirement db; the seed workspace lives here too.
const STATE_DIR = mkdtempSync(join(tmpdir(), 'c3-e2e-suite-'))
const DB_PATH = join(STATE_DIR, 'c3.db')
const SEED_PROJECT = join(STATE_DIR, 'seed')
writeFileSync(join(STATE_DIR, '.keep'), '')
// Seed project for the smoke test's auto-selected session.
mkdirSync(SEED_PROJECT, { recursive: true })
writeFileSync(join(SEED_PROJECT, 'README.md'), '# c3 e2e seed\n')

// Each test: name, script file, and whether a non-(0/5) exit fails the suite.
const TESTS = [
  { name: 'smoke (permission flow)', file: 'e2e-ws-test.mjs' },
  { name: 'requirement (save flow)', file: 'e2e-requirement-test.mjs' },
  { name: 'consensus (voting)', file: 'e2e-consensus-test.mjs' },
  { name: 'ask-consensus (per-question)', file: 'e2e-ask-consensus-test.mjs' },
]

function log(s) {
  console.log(`\x1b[36m[suite]\x1b[0m ${s}`)
}

function run(cmd, args, opts = {}) {
  return new Promise((resolveP) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts })
    child.on('exit', (code) => resolveP(code ?? 1))
    child.on('error', () => resolveP(1))
  })
}

/** Resolve once a TCP connection to the port succeeds, or reject after `tries`. */
function waitForPort(port, tries = 60, intervalMs = 500) {
  return new Promise((resolveP, reject) => {
    let n = 0
    const attempt = () => {
      const sock = connect(port, '127.0.0.1')
      sock.once('connect', () => {
        sock.destroy()
        resolveP()
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

async function main() {
  if (!NO_BUILD) {
    log('building (pnpm build) — pass --no-build to skip')
    const code = await run('pnpm', ['build'], { cwd: ROOT })
    if (code !== 0) {
      console.error('[suite] build failed')
      cleanup()
      process.exit(1)
    }
  }

  log(`starting server on :${PORT} (db=${DB_PATH})`)
  const server = spawn(
    'node',
    [
      join(ROOT, 'server', 'dist', 'cli.cjs'),
      'start',
      '--project',
      SEED_PROJECT,
      '--port',
      String(PORT),
    ],
    { cwd: ROOT, stdio: 'inherit', env: { ...process.env, C3_DB_PATH: DB_PATH } },
  )
  let serverExited = false
  server.on('exit', () => {
    serverExited = true
  })

  try {
    await waitForPort(PORT)
  } catch (err) {
    console.error(`[suite] ${err.message}`)
    server.kill('SIGTERM')
    cleanup()
    process.exit(1)
  }
  log('server is up')

  const results = []
  for (const t of TESTS) {
    if (serverExited) {
      console.error('[suite] server exited unexpectedly — aborting')
      results.push({ ...t, status: 'FAIL', code: -1 })
      break
    }
    console.log(`\n\x1b[35m================ ${t.name} ================\x1b[0m`)
    const code = await run('node', [join(HERE, t.file), WS_URL], { cwd: ROOT })
    const status = code === 0 ? 'PASS' : code === 5 ? 'SKIP' : 'FAIL'
    results.push({ ...t, status, code })
  }

  log('stopping server')
  server.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 500))
  if (!serverExited) server.kill('SIGKILL')
  cleanup()

  // ---- Summary ----
  console.log('\n\x1b[1m================ E2E SUITE SUMMARY ================\x1b[0m')
  for (const r of results) {
    const tag =
      r.status === 'PASS'
        ? '\x1b[32mPASS\x1b[0m'
        : r.status === 'SKIP'
          ? '\x1b[33mSKIP\x1b[0m'
          : '\x1b[31mFAIL\x1b[0m'
    console.log(`  ${tag}  ${r.name}${r.status === 'FAIL' ? ` (exit ${r.code})` : ''}`)
  }
  const failed = results.filter((r) => r.status === 'FAIL').length
  const skipped = results.filter((r) => r.status === 'SKIP').length
  const passed = results.filter((r) => r.status === 'PASS').length
  console.log(`\n  ${passed} passed, ${skipped} skipped, ${failed} failed`)
  console.log('===================================================\n')
  process.exit(failed > 0 ? 1 : 0)
}

function cleanup() {
  try {
    rmSync(STATE_DIR, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

main().catch((err) => {
  console.error('[suite] fatal:', err)
  cleanup()
  process.exit(1)
})
