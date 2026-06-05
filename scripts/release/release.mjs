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
    else o.passthrough.push(a) // --targets, --harden, --skip-web, …
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
  `[release] ${args.dryRun ? 'DRY-RUN ' : ''}build${args.noPublish ? ' + sign(notes only)' : ' → notes → publish'}` +
    (args.passthrough.length ? ` (${args.passthrough.join(' ')})` : ''),
)

// 1. build (+ manifest)
await run('release-build.mjs', [...args.passthrough, ...dry])

// 2. notes → dist/RELEASE_NOTES.md (skipped in dry-run; build produced no manifest then)
if (!args.dryRun) {
  await run('notes.mjs', ['--out=dist/RELEASE_NOTES.md'])
}

// 3. publish — signs always; --no-publish stops after signing (no tag, no gh Release)
await run('publish.mjs', [...(args.noPublish ? ['--no-publish'] : []), ...dry])

console.log(`[release] ${args.dryRun ? 'dry-run complete — nothing was published.' : 'done.'}`)
