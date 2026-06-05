// Pre-build blocking gate (release 5/7) — the source-level quality gate.
//
// Runs the cheap source checks IN ORDER and aborts on the first red, BEFORE the
// expensive cross-compile fan-out. A red typecheck/lint/test must never burn a
// multi-platform `bun --compile`, so this is the very first stage of `pnpm release`.
//
//   typecheck → lint → test → i18n:check → i18n:check-freeze
//
// This is the RELEASE full gate (CI release, every artifact). It's intentionally
// distinct from husky/lint-staged (the commit-increment gate, staged files only)
// and from ci.yml (the per-PR check). See release.md → Quality gates.
//
// Pure Node. CLI: node scripts/release/pregate.mjs [--dry-run]
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

/** Source gates, in cost-ascending / fail-fast order. Each is a pnpm script. */
export const GATES = ['typecheck', 'lint', 'test', 'i18n:check', 'i18n:check-freeze']

/**
 * Run every gate in order; abort on the first non-zero exit.
 * @param {object} [o]
 * @param {boolean} [o.dryRun]  print the plan, run nothing
 * @returns {{ ran: string[], failed: string | null }}
 */
export function runPregate({ dryRun = false } = {}) {
  console.log(`[pregate] source gates: ${GATES.join(' → ')}`)
  if (dryRun) {
    console.log('[pregate] --dry-run: nothing executed.')
    return { ran: [], failed: null }
  }
  const ran = []
  for (const gate of GATES) {
    console.log(`\n[pregate] ▶ ${gate}`)
    const r = spawnSync('pnpm', [gate], { cwd: repoRoot, stdio: 'inherit' })
    if (r.status !== 0) {
      console.error(
        `\n[pregate] ✗ ${gate} failed (exit ${r.status}) — aborting before cross-compile.`,
      )
      return { ran, failed: gate }
    }
    ran.push(gate)
    console.log(`[pregate] ✓ ${gate}`)
  }
  console.log('\n[pregate] ✓ all source gates green.')
  return { ran, failed: null }
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isMain()) {
  const dryRun = process.argv.slice(2).includes('--dry-run')
  const { failed } = runPregate({ dryRun })
  process.exit(failed ? 1 : 0)
}
