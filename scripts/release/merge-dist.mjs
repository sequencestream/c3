// Distribution merge (release 6/7) — fold the per-target build artifacts into one dist/.
//
// Why this exists: the GH Actions matrix builds each target on its NATIVE OS runner
// (see release.yml), and EACH build job emits its own `dist/manifest.json` (one
// artifact) plus its package. Downloading those artifacts with `merge-multiple: true`
// flattens every file into one dir — but the same-named `manifest.json` (and
// `SHA256SUMS`) COLLIDE, so only the last-written target survives and
// postgate reports the other P0 targets "missing from manifest".
//
// So the aggregation jobs (verify-dist, publish) download WITHOUT merge-multiple —
// each artifact lands in its own subdir `dist/<artifact-name>/…` — and run this
// script to:
//   1. read every per-target `manifest.json`,
//   2. assert they describe the SAME build (version + commit + schema),
//   3. concat their `artifacts[]` (dedup by target),
//   4. flatten each package + sidecar up into dist/,
//   5. write the merged `dist/manifest.json`,
//   6. write `dist/SHA256SUMS` from the manifest's per-package sha256 (so the
//      downstream postgate has manifest ↔ SHA256SUMS ↔ on-disk to check; publish
//      re-generates SHA256SUMS over the same set, which is byte-identical).
//
// Pure Node, no deps. CLI: node scripts/release/merge-dist.mjs [--dist=dist]
import { readdirSync, readFileSync, existsSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { resolve, dirname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeManifest } from './manifest.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

/** Recursively collect every `manifest.json` strictly BELOW `root` (i.e. in subdirs). */
function findSubManifests(root) {
  const out = []
  for (const name of readdirSync(root)) {
    const p = join(root, name)
    if (!statSync(p).isDirectory()) continue
    const mp = join(p, 'manifest.json')
    if (existsSync(mp)) out.push(mp)
    // Only one level deep is expected (download-artifact lays out dist/<artifact>/…),
    // but recurse defensively in case the layout nests further.
    else out.push(...findSubManifests(p))
  }
  return out
}

/** Move `src` to `destDir`, preserving its basename. No-op if it's already there. */
function flatten(src, destDir) {
  const dest = join(destDir, basename(src))
  if (resolve(src) === resolve(dest)) return dest
  renameSync(src, dest)
  return dest
}

/**
 * Merge the per-target dist subdirs into a single flat dist/.
 * @param {object} [o]
 * @param {string} [o.distDir]                 root holding the per-artifact subdirs
 * @param {(m: string) => void} [o.log]
 * @returns {{ manifestPath: string, sumsPath: string, targets: string[] }}
 */
export function mergeDist({ distDir, log = () => {} } = {}) {
  const root = distDir ? resolve(distDir) : resolve(repoRoot, 'dist')
  const subManifests = findSubManifests(root)
  if (!subManifests.length)
    throw new Error(`no per-target manifest.json found under ${root} — nothing to merge`)

  let base = null
  const byTarget = new Map()

  for (const mp of subManifests) {
    const m = JSON.parse(readFileSync(mp, 'utf-8'))
    const subDir = dirname(mp)

    if (!base) {
      base = { schema: m.schema, version: m.version, commit: m.commit }
    } else {
      // Every per-target manifest MUST describe the same build — a mismatch means
      // artifacts from two different runs/commits got mixed and the release is unsafe.
      for (const k of ['schema', 'version', 'commit']) {
        if (m[k] !== base[k])
          throw new Error(
            `manifest mismatch in ${mp}: ${k}=${m[k]} ≠ ${base[k]} (mixed builds — abort)`,
          )
      }
    }

    for (const a of m.artifacts) {
      const prev = byTarget.get(a.target)
      if (prev && prev.sha256 !== a.sha256)
        throw new Error(`conflicting artifact for target ${a.target}: ${prev.sha256} ≠ ${a.sha256}`)
      // Flatten the package (and any sidecars that rode along) up into dist/.
      const pkg = resolve(subDir, basename(a.file))
      if (existsSync(pkg)) {
        flatten(pkg, root)
        const side = `${pkg}.sha256`
        if (existsSync(side)) flatten(side, root)
      }
      byTarget.set(a.target, a)
      log(`  merged ${a.target}  ${basename(a.file)}  ${a.sha256.slice(0, 12)}…`)
    }
  }

  const artifacts = [...byTarget.values()]
  const merged = {
    schema: base.schema,
    version: base.version,
    commit: base.commit,
    // buildTime comes from the first manifest; all share the same commit so any
    // per-job buildTime skew is cosmetic.
    artifacts,
  }
  const manifestPath = resolve(root, 'manifest.json')
  writeManifest(manifestPath, merged)

  // SHA256SUMS from the manifest's per-package hashes (publish re-generates this
  // set; the bytes are identical). One `<hex>  <name>` line per artifact, sorted by name
  // for a stable, reproducible file.
  const sumsLines = artifacts.map((a) => `${a.sha256}  ${basename(a.file)}`).sort()
  const sha256sums = sumsLines.join('\n') + '\n'
  const sumsPath = resolve(root, 'SHA256SUMS')
  writeFileSync(sumsPath, sha256sums)

  log(`  → ${manifestPath} (${artifacts.length} target(s))`)
  log(`  → ${sumsPath}`)
  return { manifestPath, sumsPath, targets: artifacts.map((a) => a.target) }
}

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
  try {
    console.log('[merge-dist] folding per-target artifacts into one dist/…')
    const { targets } = mergeDist({
      distDir: typeof args.dist === 'string' ? args.dist : undefined,
      log: (m) => console.log(m),
    })
    console.log(`[merge-dist] OK — merged ${targets.length} target(s): ${targets.join(', ')}`)
  } catch (err) {
    console.error(`[merge-dist] ✗ ${err.message}`)
    process.exit(1)
  }
}
