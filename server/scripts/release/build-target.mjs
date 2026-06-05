// Single-target Bun compile — the one reusable build primitive.
//
// Runs under `bun` (uses the Bun.build JS API). Produces ONE standalone executable
// for ONE platform target. Pure reader of the pre-generated static-embed snapshot:
// the import of `../static-embed.js` (the committed empty stub) is redirected at
// build time to the generated dist/static-embed.generated.ts via an onResolve
// plugin, so N targets can build in parallel without writing any shared file.
//
// `pnpm binary` (native, self-use) and `pnpm release:build` (multi-platform) both
// route through buildTarget() — no second compile path.
//
/* global Bun */
// ^ This module runs under `bun` (Bun.build JS API); `Bun` is a runtime global.
import { chmodSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverDir = resolve(here, '..', '..') // server/
const repoRoot = resolve(serverDir, '..')

// Friendly target name → Bun --target triple. P0 wave: macOS-arm64 + Linux-x64-glibc.
export const TARGETS = {
  'macos-arm64': 'bun-darwin-arm64',
  'linux-x64': 'bun-linux-x64',
}

export function defaultOutfile(friendly) {
  return resolve(repoRoot, 'dist', `c3-${friendly}`)
}

export function defaultEmbedPath() {
  return resolve(repoRoot, 'dist', 'static-embed.generated.ts')
}

/**
 * Compile one target.
 * @param {object} o
 * @param {string} o.target   friendly name (key of TARGETS) or a raw bun-* triple
 * @param {string} [o.outfile]   absolute output path (default dist/c3-<friendly>)
 * @param {string} [o.embedPath] absolute path to the generated static-embed snapshot
 * @param {string} [o.harden]    hardening tier — P0 placeholder, only 'default' honored
 */
export async function buildTarget({ target, outfile, embedPath, harden = 'default' }) {
  const bunTarget = TARGETS[target] ?? target
  const friendly =
    Object.keys(TARGETS).find((k) => TARGETS[k] === bunTarget) ??
    target.replace(/^bun-/, '').replace('darwin', 'macos')
  const out = outfile ?? defaultOutfile(friendly)
  const embed = embedPath ?? defaultEmbedPath()
  const entry = resolve(serverDir, 'src', 'cli.ts')

  if (harden !== 'default') {
    console.warn(
      `[build-target] harden="${harden}" is a P0 placeholder; building with default tier.`,
    )
  }
  if (!existsSync(embed)) {
    throw new Error(
      `[build-target] embed snapshot missing: ${embed}\n` +
        `  Run Phase1 first: \`node server/scripts/generate-static-embed.mjs\` (needs web/dist/).`,
    )
  }

  // Redirect the committed stub import to the real generated snapshot. The asset
  // imports INSIDE the snapshot (web/dist/**) are NOT matched and resolve normally.
  const redirectStub = {
    name: 'static-embed-redirect',
    setup(build) {
      build.onResolve({ filter: /static-embed(\.js)?$/ }, () => ({ path: embed }))
    },
  }

  console.log(`[build-target] target=${friendly} (${bunTarget}) → ${out}`)
  // NB: --bytecode is intentionally never enabled — cross-compile + bytecode segfaults
  // (oven-sh/bun#18416). --minify is kept. Bun.build defaults bytecode off.
  const result = await Bun.build({
    entrypoints: [entry],
    target: bunTarget,
    minify: true,
    compile: { target: bunTarget, outfile: out },
    plugins: [redirectStub],
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`[build-target] bun build failed for ${friendly}`)
  }
  if (!existsSync(out)) {
    throw new Error(`[build-target] outfile missing after build: ${out}`)
  }
  chmodSync(out, 0o755)
  console.log(`[build-target] OK → ${out}`)
  return { friendly, bunTarget, outfile: out }
}

// ── CLI entry: `bun run build-target.mjs --target=macos-arm64 [--outfile=...] [--embed=...]`
function parseArgs(argv) {
  const o = {}
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a)
    if (m) o[m[1]] = m[2]
    else if (a.startsWith('--')) o[a.slice(2)] = true
  }
  return o
}

const isMain = (() => {
  try {
    return import.meta.path === Bun.main
  } catch {
    return false
  }
})()

if (isMain) {
  const a = parseArgs(process.argv.slice(2))
  const target = a.target ?? process.env.BUN_TARGET ?? 'macos-arm64'
  await buildTarget({
    target,
    outfile: a.outfile ? resolve(a.outfile) : undefined,
    embedPath: a.embed ? resolve(a.embed) : undefined,
    harden: a.harden ?? 'default',
  })
}
