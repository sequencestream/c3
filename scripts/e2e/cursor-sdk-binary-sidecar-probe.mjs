#!/usr/bin/env node
/**
 * Cursor SDK **binary sidecar** probe — the go/no-go gate for running Cursor from
 * a single-file build (see
 * `doc/domains/core/agent-session/features/agent-session-cursor.md`).
 *
 * The question it answers is narrow and load-bearing: a standalone binary carries
 * no Cursor runtime, so can it resolve and run `@cursor/sdk` from a tree that
 * exists only OUTSIDE the executable? Everything downstream — the release
 * assembling per-target sidecars, the server's resolution boundary, the cursor
 * agent type being offered at all — is worthless if it cannot.
 *
 * It compiles a REAL Bun single-file binary over c3's OWN resolution boundary
 * (`server/src/kernel/agent/adapters/cursor/sdk-resolve.ts`), so what passes here
 * is the code that ships, not a re-implementation that could drift from it.
 *
 * Stages, in order — each one is a separate run of the same binary:
 *   S1 sidecar staged for this host target (`scripts/release/sidecar.mjs`)
 *   S2 binary compiled with the SDK external
 *   S3 NO sidecar ⇒ honestly unavailable (nothing leaks in from the repo)
 *   S4 sidecar present ⇒ resolves, origin `sidecar`, entry inside the sidecar root
 *   S5 lazy load ⇒ the SDK module really loads, and the platform package's ripgrep
 *      is reachable through `CURSOR_RIPGREP_PATH`
 *   S6 the local store answers (`Agent.list`) — the local runtime is up
 *   S7 a minimal `Agent.create` → `send` → stream → `wait` round trip
 *   S8 `CURSOR_SDK_PATH` outranks the sidecar; an invalid override falls through
 *
 * S7 spends a small amount of real quota and needs a real `CURSOR_API_KEY` plus
 * outbound network, so this is NOT CI-safe and NOT part of `pnpm e2e`. With no key
 * the mechanism stages still run and are reported; the verdict is SKIP, never GO.
 *
 * Usage:
 *   node scripts/e2e/cursor-sdk-binary-sidecar-probe.mjs [--json] [--keep] [--mechanism-only]
 * Exit codes: 0 = GO, 1 = NO-GO, 5 = SKIP (no credentials / no toolchain).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostTarget } from '../release/targets.mjs'
import { platformPackageFor, stageSidecar } from '../release/sidecar.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

const args = new Set(process.argv.slice(2))
const JSON_OUT = args.has('--json')
const KEEP = args.has('--keep')
const MECHANISM_ONLY = args.has('--mechanism-only')

const log = (s) => !JSON_OUT && console.log(`[sidecar-probe] ${s}`)
const findings = []
const record = (name, ok, detail) => {
  findings.push({ name, ok, detail })
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

function finish(verdict, reason) {
  if (JSON_OUT) console.log(JSON.stringify({ verdict, reason, findings }, null, 2))
  else {
    if (reason) console.log(`[sidecar-probe] ${verdict}: ${reason}`)
    console.log(`[sidecar-probe] VERDICT: ${verdict}`)
  }
  process.exit(verdict === 'GO' ? 0 : verdict === 'SKIP' ? 5 : 1)
}

function which(bin) {
  const res =
    process.platform === 'win32'
      ? spawnSync('where', [bin], { encoding: 'utf-8' })
      : spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf-8' })
  const path = res.stdout?.split('\n')[0]?.trim()
  return res.status === 0 && path ? path : null
}

const API_KEY = (process.env.CURSOR_API_KEY ?? '').trim()
const bun = process.env.BUN_BIN ?? which('bun')
if (!bun) finish('SKIP', 'bun is not available — the probe must compile a real single-file binary')
if (!which('npm')) finish('SKIP', 'npm is not available — the sidecar tree is staged with it')

const target = hostTarget()
const platformPackage = platformPackageFor(target)
const WORK = mkdtempSync(join(tmpdir(), 'c3-sidecar-probe-'))
const binDir = join(WORK, 'bin')
const elsewhere = join(WORK, 'elsewhere')
const sidecarHome = join(WORK, 'sidecar-home')
const workspace = join(WORK, 'workspace')
for (const dir of [binDir, elsewhere, sidecarHome, workspace]) mkdirSync(dir, { recursive: true })
writeFileSync(join(workspace, 'README.md'), '# cursor sidecar probe\n')

function cleanup() {
  if (KEEP) {
    log(`kept scratch: ${WORK}`)
    return
  }
  rmSync(WORK, { recursive: true, force: true })
}

/**
 * The probe binary's entry: it does nothing of its own beyond calling into the
 * production resolution boundary and printing a JSON verdict, so a stage failing
 * here is a failure of the shipped code.
 */
const ENTRY_SOURCE = `
import { join } from 'node:path'
import { resolveCursorSdk, loadCursorSdk, sidecarRoot } from ${JSON.stringify(
  join(repoRoot, 'server', 'src', 'kernel', 'agent', 'adapters', 'cursor', 'sdk-resolve.ts'),
)}

const mode = process.argv[2]
const out = { mode }
try {
  const resolution = resolveCursorSdk()
  Object.assign(out, { resolution, sidecarRoot: sidecarRoot(), execPath: process.execPath })
  if (mode === 'load' || mode === 'store' || mode === 'turn') {
    const sdk = await loadCursorSdk()
    out.loaded = typeof sdk.Agent === 'function'
    out.ripgrepPath = process.env.CURSOR_RIPGREP_PATH ?? null
  }
  if (mode === 'store') {
    const listed = await sdk_list()
    out.storeItems = listed
  }
  if (mode === 'turn') {
    const { Agent } = await loadCursorSdk()
    const options = {
      model: { id: 'auto' },
      apiKey: process.env.CURSOR_API_KEY,
      local: { cwd: process.argv[3], autoReview: false, settingSources: ['project'] },
    }
    const agent = await Agent.create(options)
    out.agentId = agent.agentId
    const run = await agent.send({ text: 'Reply with exactly: SIDECAR-OK' }, { model: { id: 'auto' } })
    let text = ''
    for await (const frame of run.stream()) {
      if (frame?.type !== 'assistant') continue
      for (const block of frame.message?.content ?? []) {
        if (block?.type === 'text') text += block.text
      }
    }
    const result = await run.wait()
    agent.close()
    out.turnStatus = result.status
    out.turnError = result.error?.message ?? null
    out.turnText = text
  }
  out.ok = true
} catch (err) {
  out.ok = false
  out.error = err?.message ?? String(err)
  out.status = err?.status ?? null
}
async function sdk_list() {
  const { Agent } = await loadCursorSdk()
  const listed = await Agent.list({ runtime: 'local', cwd: process.argv[3] })
  return listed.items.length
}
console.log('__PROBE__' + JSON.stringify(out))
`

/** Run the probe binary once and parse its JSON line. */
function runBinary(binary, mode, { env = {}, cwd } = {}) {
  const res = spawnSync(binary, [mode, workspace], {
    encoding: 'utf-8',
    cwd: cwd ?? WORK,
    env: { ...process.env, ...env },
    timeout: 180_000,
  })
  const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('__PROBE__'))
  if (!line) {
    return {
      ok: false,
      error: `no probe output (exit ${res.status}): ${(res.stderr || res.stdout || '').trim().slice(0, 400)}`,
    }
  }
  return JSON.parse(line.slice('__PROBE__'.length))
}

let mechanismOk = true
const gate = (ok) => {
  if (!ok) mechanismOk = false
  return ok
}

try {
  // ── S1: stage this host target's sidecar ─────────────────────────────────
  let staged
  try {
    staged = stageSidecar({ target, destDir: sidecarHome, log: (m) => log(m.trim()) })
    gate(
      record(
        'S1 sidecar tree staged for this target',
        true,
        `${staged.packages} pkgs, ${platformPackage}, ${(staged.bytes / 1024 / 1024).toFixed(1)} MiB`,
      ),
    )
  } catch (err) {
    gate(record('S1 sidecar tree staged for this target', false, err.message))
    throw err
  }

  // ── S2: compile a real single-file binary over the production boundary ───
  const entryPath = join(WORK, 'probe-entry.ts')
  writeFileSync(entryPath, ENTRY_SOURCE)
  const binary = join(binDir, process.platform === 'win32' ? 'probe.exe' : 'probe')
  const build = spawnSync(
    bun,
    ['build', entryPath, '--compile', `--outfile=${binary}`, '--external', '@cursor/sdk'],
    { encoding: 'utf-8', cwd: repoRoot },
  )
  gate(
    record(
      'S2 single-file binary compiled with the SDK external',
      build.status === 0 && existsSync(binary),
      build.status === 0 ? binary : (build.stderr || build.stdout || '').trim().slice(0, 400),
    ),
  )
  if (!existsSync(binary)) throw new Error('binary was not produced')

  // ── S3: no sidecar ⇒ honestly unavailable ────────────────────────────────
  const bare = runBinary(binary, 'resolve')
  gate(
    record(
      'S3 no sidecar ⇒ unavailable, nothing leaks in',
      bare.ok === true && bare.resolution?.available === false,
      bare.ok ? `available=${bare.resolution?.available}` : bare.error,
    ),
  )

  // ── S4: sidecar beside the binary ⇒ resolves from it ─────────────────────
  const sidecarRootPath = join(binDir, 'node_modules')
  spawnSync('cp', ['-R', join(sidecarHome, 'node_modules'), sidecarRootPath], { encoding: 'utf-8' })
  const resolved = runBinary(binary, 'resolve')
  gate(
    record(
      'S4 sidecar resolves, origin=sidecar, entry inside the root',
      resolved.resolution?.available === true &&
        resolved.resolution.origin === 'sidecar' &&
        String(resolved.resolution.entry ?? '').includes('node_modules'),
      resolved.resolution
        ? `${resolved.resolution.origin}: ${resolved.resolution.entry}`
        : resolved.error,
    ),
  )

  // ── S5: the module really loads, and ripgrep points into the sidecar ─────
  const loaded = runBinary(binary, 'load')
  gate(
    record(
      'S5 lazy load reaches the SDK module',
      loaded.ok === true && loaded.loaded === true,
      loaded.ok ? `Agent present` : loaded.error,
    ),
  )
  gate(
    record(
      'S5 platform package reachable via CURSOR_RIPGREP_PATH',
      typeof loaded.ripgrepPath === 'string' &&
        loaded.ripgrepPath.includes(platformPackage) &&
        existsSync(loaded.ripgrepPath),
      loaded.ripgrepPath ?? 'not set',
    ),
  )

  // ── S6: the local store answers — the local runtime is up ────────────────
  const store = runBinary(binary, 'store')
  gate(
    record(
      'S6 local agent store answers from the binary',
      store.ok === true && typeof store.storeItems === 'number',
      store.ok ? `${store.storeItems} agent(s)` : store.error,
    ),
  )

  // ── S8: override outranks the sidecar; a bad override falls through ──────
  const away = join(elsewhere, process.platform === 'win32' ? 'probe.exe' : 'probe')
  spawnSync('cp', [binary, away], { encoding: 'utf-8' })
  const overridden = runBinary(away, 'resolve', { env: { CURSOR_SDK_PATH: sidecarRootPath } })
  gate(
    record(
      'S8 CURSOR_SDK_PATH resolves when there is no sidecar',
      overridden.resolution?.available === true && overridden.resolution.origin === 'override',
      overridden.resolution ? String(overridden.resolution.origin) : overridden.error,
    ),
  )
  const badOverride = runBinary(binary, 'resolve', {
    env: { CURSOR_SDK_PATH: join(WORK, 'nowhere') },
  })
  gate(
    record(
      'S8 an invalid override is rejected and falls through to the sidecar',
      badOverride.resolution?.available === true &&
        badOverride.resolution.origin === 'sidecar' &&
        typeof badOverride.resolution.rejectedOverride === 'string',
      badOverride.resolution
        ? `origin=${badOverride.resolution.origin}, rejected=${badOverride.resolution.rejectedOverride}`
        : badOverride.error,
    ),
  )

  if (!mechanismOk) {
    cleanup()
    finish('NO-GO', 'the binary cannot resolve or load the SDK from an external sidecar')
  }
  if (MECHANISM_ONLY) {
    cleanup()
    finish('SKIP', 'mechanism stages only (--mechanism-only): no live turn was attempted')
  }
  if (!API_KEY) {
    cleanup()
    finish(
      'SKIP',
      'CURSOR_API_KEY is not set — the mechanism stages passed, the live create/send round trip was not attempted',
    )
  }

  // ── S7: a minimal live turn from inside the binary ───────────────────────
  const turn = runBinary(binary, 'turn')
  const turnOk =
    turn.ok === true &&
    turn.turnStatus === 'finished' &&
    String(turn.turnText).includes('SIDECAR-OK')
  record(
    'S7 minimal create/send round trip completes',
    turnOk,
    turn.ok ? `status=${turn.turnStatus}, agentId=${turn.agentId}` : turn.error,
  )
  cleanup()
  finish(turnOk ? 'GO' : 'NO-GO', turnOk ? undefined : 'the live turn did not complete')
} catch (err) {
  record('probe completed without throwing', false, err?.message ?? String(err))
  cleanup()
  finish('NO-GO', err?.message ?? String(err))
}
