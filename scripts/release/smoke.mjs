// Headless artifact smoke (release 5/7) — the artifact-level quality gate.
//
// For a built `c3-*` binary, prove it actually RUNS without ever invoking claude
// (a claude call in CI would block forever — no interactive answerer):
//   1. `c3 --version`            → assert version + commit + build-time echo
//   2. start the server on a RANDOM free port (claude is only touched when a run
//      launches, so a bare boot is claude-free), then HTTP-probe until it answers,
//      then kill it. A live HTTP response is the liveness proof.
//
// Cross-compiled binaries can't execute on a foreign host (a linux-x64 artifact on
// a macOS runner), so smoke runs ONLY on host-runnable targets — others are skipped
// and left to their platform's CI runner (`isHostRunnable`).
//
// This script IS the test carrier: it's run inside `release:build` Phase3 and
// standalone via `pnpm release:smoke`. A tiny companion `release-smoke.test.mjs`
// covers the pure helpers (host mapping, version parse, free-port pick).
//
// Pure Node. CLI: node scripts/release/smoke.mjs [--file=dist/c3-…] [--timeout=15000]
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { get as httpGet } from 'node:http'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isHostRunnable, hostTarget } from './targets.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

/** A built `c3 --version` line: `0.1.0 (commit c58a0b5, built <ISO>)`. */
export function assertVersionOutput(out) {
  const s = String(out).trim()
  if (!/^v?\d+\.\d+\.\d+/.test(s)) throw new Error(`--version: no semver in ${JSON.stringify(s)}`)
  if (!/commit [0-9a-f]{7}/.test(s)) throw new Error(`--version: no commit in ${JSON.stringify(s)}`)
  if (!/built \S/.test(s)) throw new Error(`--version: no build time in ${JSON.stringify(s)}`)
  return s
}

/** Grab a free TCP port by binding :0, reading it back, then releasing it. */
export function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer()
    srv.on('error', rej)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close((err) => (err ? rej(err) : res(port)))
    })
  })
}

/** Resolve once the server answers HTTP on `port`, or reject after `timeoutMs`. */
function waitForHttp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((res, rej) => {
    const attempt = () => {
      const req = httpGet({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, (r) => {
        r.resume() // any HTTP status means the server is alive
        res(r.statusCode)
      })
      req.on('error', () => (Date.now() > deadline ? rej(new Error('timeout')) : retry()))
      req.on('timeout', () => req.destroy())
    }
    const retry = () => setTimeout(attempt, 200)
    attempt()
  })
}

/**
 * Smoke one artifact: `--version` echo + a random-port server boot probed over HTTP.
 * Never calls claude. Throws on any failure; resolves with the version string on success.
 * @param {string} file       absolute path to a host-runnable c3 binary
 * @param {object} [o]
 * @param {number} [o.timeoutMs=15000]
 * @param {(m: string) => void} [o.log]
 */
export async function smokeArtifact(file, { timeoutMs = 15000, log = () => {} } = {}) {
  // 1. --version
  const v = spawnSync(file, ['--version'], { encoding: 'utf-8' })
  if (v.status !== 0) throw new Error(`${basename(file)} --version exited ${v.status}`)
  const version = assertVersionOutput(v.stdout)
  log(`  ✓ ${basename(file)} --version → ${version}`)

  // 2. boot on a random free port, probe HTTP, then kill. Throwaway db + project so
  // the smoke never touches real state; HUSKY=0 keeps it hook-free.
  const port = await freePort()
  const sandbox = mkdtempSync(join(tmpdir(), 'c3-smoke-'))
  const child = spawn(file, ['--port', String(port), '--workspace', sandbox], {
    env: { ...process.env, C3_DB_PATH: join(sandbox, 'c3.db'), HUSKY: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (d) => (stderr += d))
  const exited = new Promise((_, rej) =>
    child.on('exit', (code) => rej(new Error(`server exited early (${code}): ${stderr.trim()}`))),
  )
  try {
    const status = await Promise.race([waitForHttp(port, timeoutMs), exited])
    log(`  ✓ ${basename(file)} server live on :${port} (HTTP ${status})`)
    return version
  } finally {
    child.kill('SIGKILL')
  }
}

/**
 * Run the artifact gate across a build plan: smoke every host-runnable target,
 * skip (with a log) the cross-compiled ones. Throws on the first failure.
 * @param {object} o
 * @param {Array<{ target: string, path: string }>} o.artifacts
 * @param {(m: string) => void} [o.log]
 */
export async function smokeBuiltArtifacts({ artifacts, log = () => {} }) {
  for (const a of artifacts) {
    if (!isHostRunnable(a.target)) {
      log(`  ⤳ ${a.target}: skip smoke (not host-runnable on ${hostTarget()})`)
      continue
    }
    if (!existsSync(a.path)) throw new Error(`artifact missing: ${a.path}`)
    await smokeArtifact(a.path, { log })
  }
}

// --- CLI ---
function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
      return m ? [m[1], m[2] ?? true] : [a, true]
    }),
  )
  const timeoutMs = args.timeout ? Number(args.timeout) : 15000
  if (args.file) {
    await smokeArtifact(resolve(String(args.file)), { timeoutMs, log: (m) => console.log(m) })
    console.log('[smoke] OK')
  } else {
    // No --file: read dist/manifest.json and smoke the host-runnable artifacts.
    const manifestPath = resolve(repoRoot, 'dist', 'manifest.json')
    if (!existsSync(manifestPath)) {
      console.error('[smoke] dist/manifest.json missing — run `pnpm release:build` first.')
      process.exit(1)
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    const distDir = dirname(manifestPath)
    await smokeBuiltArtifacts({
      artifacts: manifest.artifacts.map((a) => ({
        target: a.target,
        path: resolve(distDir, basename(a.file)),
      })),
      log: (m) => console.log(m),
    })
    console.log('[smoke] OK')
  }
}
