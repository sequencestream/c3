#!/usr/bin/env node
/**
 * E2E suite runner — boots one c3 server and runs every WebSocket e2e against it,
 * then tears the server down and reports a pass/fail summary. Wired as `pnpm e2e`.
 *
 * Isolation is `isolated-server.mjs`'s job — the same helper a developer runs by
 * hand for a single test, so the suite and a manual run cannot drift apart: a
 * throwaway `C3_DB_PATH` plus `--settings <throwaway>`, seeded read-only from the
 * real `~/.c3/settings.json` with `auth` stripped. The run never writes to the
 * real `~/.c3`. Tests still SKIP (exit 5) when no extra agents are present.
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
 *   pnpm e2e                       # build, boot, run all, report
 *   pnpm e2e --no-build            # reuse the existing server/dist build
 *   pnpm e2e --port 13550
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { startIsolatedServer } from './isolated-server.mjs'

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

// Throwaway state dir: isolates the intent db; an available test directory lives
// here too, and `isolated-server.mjs` seeds its settings.json into it.
const STATE_DIR = mkdtempSync(join(tmpdir(), 'c3-e2e-suite-'))
const DB_PATH = join(STATE_DIR, 'c3.db')
const SEED_PROJECT = join(STATE_DIR, 'seed')
writeFileSync(join(STATE_DIR, '.keep'), '')
// Seed project for the smoke test's auto-selected session.
mkdirSync(SEED_PROJECT, { recursive: true })
writeFileSync(join(SEED_PROJECT, 'README.md'), '# c3 e2e seed\n')

// Each test: name, script file, and whether a non-(0/5) exit fails the suite.
const TESTS = [
  { name: 'sessions page setting (hidden / visible)', file: 'e2e-sessions-page-setting-test.mjs' },
  { name: 'smoke (permission flow)', file: 'e2e-ws-test.mjs' },
  { name: 'pending-queue flush race', file: 'e2e-pending-flush-test.mjs' },
  { name: 'intent (save flow)', file: 'e2e-intent-test.mjs' },
  {
    name: 'delivery ↔ intent association (link / unlink guards)',
    file: 'e2e-delivery-link-test.mjs',
  },
  {
    name: 'delivery PR (create gates / detail contract / transient failure layer)',
    file: 'e2e-delivery-pr-test.mjs',
  },
  {
    name: 'delivery status guard (unreachable edge / blocked gap / system-only)',
    file: 'e2e-delivery-transition-test.mjs',
  },
  {
    name: 'dependency gate (same-delivery / cross-delivery / no-delivery)',
    file: 'e2e-dependency-gate-test.mjs',
  },
  { name: 'automation queue (park isolation + manual control)', file: 'e2e-queue-test.mjs' },
  {
    name: 'spec automation (author → review → opt-in machine approval → revoke)',
    file: 'e2e-spec-automation-test.mjs',
  },
  { name: 'consensus (voting)', file: 'e2e-consensus-test.mjs' },
  { name: 'ask-consensus (per-question)', file: 'e2e-ask-consensus-test.mjs' },
  { name: 'sandbox (backward compat)', file: 'e2e-sandbox-test.mjs' },
  { name: 'sandbox container (config + container path)', file: 'e2e-sandbox-container-test.mjs' },
  // Last two on purpose: both temporarily rewrite the agent list (one makes a
  // Cursor agent the system default, the other disables/removes one mid-run) and
  // restore the snapshot on exit, so any botched restore cannot reach the tests
  // above. Neither has a SKIP branch — each environment has its own assertion.
  {
    name: 'cursor agent config (runtime signal → config → default agent)',
    file: 'e2e-cursor-agent-config-test.mjs',
  },
  {
    name: 'cursor automation (dispatch → run → failure branches)',
    file: 'e2e-cursor-automation-test.mjs',
  },
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
  // The suite owns STATE_DIR (it holds the seed project and the db), so it hands
  // it to the helper and does its own cleanup.
  let started
  try {
    started = await startIsolatedServer({ port: PORT, stateDir: STATE_DIR, dbPath: DB_PATH })
  } catch (err) {
    console.error(`[suite] ${err.message}`)
    cleanup()
    process.exit(1)
  }
  log('server is up')

  await runE2ESuite(started.server)
}

/**
 * Run the full e2e suite against `server` (already up on WS_URL), tear it down,
 * print a summary, and exit with non-zero on any FAIL.
 */
async function runE2ESuite(server) {
  let serverExited = false
  server.on('exit', () => {
    serverExited = true
  })

  const results = []
  for (const t of TESTS) {
    if (serverExited) {
      console.error('[suite] server exited unexpectedly — aborting')
      results.push({ ...t, status: 'FAIL', code: -1 })
      break
    }
    console.log(`\n\x1b[35m================ ${t.name} ================\x1b[0m`)
    // `C3_DB_PATH` reaches the tests too: the delivery-association test seeds
    // `intent_prs` rows straight into the ledger (a real PR needs a live forge).
    const code = await run('node', [join(HERE, t.file), WS_URL], {
      cwd: ROOT,
      env: { ...process.env, C3_DB_PATH: DB_PATH },
    })
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
