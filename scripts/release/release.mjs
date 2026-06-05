// pnpm release (release 3/7) — top-level orchestration: build → notes → publish.
//
// Chains the release stages so a maintainer cuts a release with one command:
//   pnpm release                       build all targets, sign, cut the GitHub Release
//   pnpm release --no-publish          build + sign + notes, but DON'T create the Release
//   pnpm release --dry-run             rehearse every stage, execute nothing irreversible
//   pnpm release --targets=linux-x64   passthrough subset / --harden=… to the build stage
//
// Stages run as child processes so each owns its own argv parsing (no shared global state).
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPregate } from './pregate.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

function parseArgs(argv) {
  const o = { passthrough: [] }
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (!m) continue
    const [, k, v] = m
    if (k === 'dry-run') o.dryRun = true
    else if (k === 'no-publish') o.noPublish = true
    else if (k === 'skip-gate') o.skipGate = true
    else {
      if (k === 'harden') o.harden = v
      o.passthrough.push(a) // --targets, --harden, --skip-web, …
    }
  }
  return o
}

/** Resolve the harden tier the run will use: --harden > RELEASE_HARDEN > basic. */
function resolveHardenTier(args) {
  return String(args.harden || process.env.RELEASE_HARDEN || 'basic')
}

function run(script, scriptArgs) {
  return new Promise((res, rej) => {
    const p = spawn('node', [resolve(here, script), ...scriptArgs], {
      stdio: 'inherit',
      cwd: repoRoot,
    })
    p.on('error', rej)
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${script} → exit ${code}`))))
  })
}

/** Run an arbitrary command (e.g. `pnpm e2e`) to completion. */
function run2(cmd, cmdArgs) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, cmdArgs, { stdio: 'inherit', cwd: repoRoot })
    p.on('error', rej)
    p.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} ${cmdArgs.join(' ')} → exit ${code}`)),
    )
  })
}

const args = parseArgs(process.argv.slice(2))
const dry = args.dryRun ? ['--dry-run'] : []
const harden = resolveHardenTier(args)
const runE2e = harden === 'standard'

console.log(
  `[release] ${args.dryRun ? 'DRY-RUN ' : ''}` +
    `gate → build${runE2e ? ' → e2e(standard)' : ''}${args.noPublish ? ' + sign(notes only)' : ' → notes → publish'}` +
    (args.passthrough.length ? ` (${args.passthrough.join(' ')})` : ''),
)

// 0. pregate — source-level blocking gate. Any red aborts BEFORE the cross-compile.
//    --skip-gate opts out; --dry-run lists the plan only.
if (!args.skipGate) {
  const { failed } = runPregate({ dryRun: args.dryRun })
  if (failed) {
    console.error(
      `[release] aborted — source gate "${failed}" is red (no cross-compile attempted).`,
    )
    process.exit(1)
  }
} else {
  console.log('[release] --skip-gate: source gates skipped.')
}

// 1. build (+ manifest + Phase3 artifact smoke gate)
await run('release-build.mjs', [...args.passthrough, ...dry])

// 2. e2e — forced on the `standard` harden tier (placeholder tier still smokes e2e).
if (runE2e) {
  if (args.dryRun) console.log('[release] --dry-run: would run `pnpm e2e` (standard tier).')
  else await run2('pnpm', ['e2e'])
}

// 3. notes → dist/RELEASE_NOTES.md (skipped in dry-run; build produced no manifest then)
if (!args.dryRun) {
  await run('notes.mjs', ['--out=dist/RELEASE_NOTES.md'])
}

// 4. publish — signs + verify-dist final check; --no-publish stops after signing (no tag/gh).
await run('publish.mjs', [...(args.noPublish ? ['--no-publish'] : []), ...dry])

console.log(`[release] ${args.dryRun ? 'dry-run complete — nothing was published.' : 'done.'}`)
