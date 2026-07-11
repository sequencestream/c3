// pnpm release:github — the GitHub-publish orchestrator (formerly `pnpm release`).
//
// Chains the release stages so a maintainer cuts a *public GitHub Release* with one
// command. `pnpm release` itself is now the local build+store flow (see release.mjs);
// this preserved orchestrator keeps the tag/gh path available unchanged:
//   pnpm release:github                       build all targets, checksum, cut the GitHub Release
//   pnpm release:github --no-publish          build + checksum + notes, but DON'T create the Release
//   pnpm release:github --dry-run             rehearse every stage, execute nothing irreversible
//   pnpm release:github --targets=linux-x64   passthrough subset to the build stage
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
    const [, k] = m
    if (k === 'dry-run') o.dryRun = true
    else if (k === 'no-publish') o.noPublish = true
    else if (k === 'skip-gate') o.skipGate = true
    else o.passthrough.push(a) // --targets, --skip-web, …
  }
  return o
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

const args = parseArgs(process.argv.slice(2))
const dry = args.dryRun ? ['--dry-run'] : []

console.log(
  `[release:github] ${args.dryRun ? 'DRY-RUN ' : ''}` +
    `gate → build${args.noPublish ? ' + checksum(notes only)' : ' → notes → publish'}` +
    (args.passthrough.length ? ` (${args.passthrough.join(' ')})` : ''),
)

// 0. pregate — source-level blocking gate. Any red aborts BEFORE the cross-compile.
//    --skip-gate opts out; --dry-run lists the plan only.
if (!args.skipGate) {
  const { failed } = runPregate({ dryRun: args.dryRun })
  if (failed) {
    console.error(
      `[release:github] aborted — source gate "${failed}" is red (no cross-compile attempted).`,
    )
    process.exit(1)
  }
} else {
  console.log('[release:github] --skip-gate: source gates skipped.')
}

// 1. build (+ manifest + Phase3 artifact smoke gate)
await run('release-build.mjs', [...args.passthrough, ...dry])

// 2. notes → dist/RELEASE_NOTES.md (skipped in dry-run; build produced no manifest then)
if (!args.dryRun) {
  await run('notes.mjs', ['--out=dist/RELEASE_NOTES.md'])
}

// 3. publish — checksums + verify-dist final check; --no-publish stops after checksum (no tag/gh).
await run('publish.mjs', [...(args.noPublish ? ['--no-publish'] : []), ...dry])

console.log(
  `[release:github] ${args.dryRun ? 'dry-run complete — nothing was published.' : 'done.'}`,
)
