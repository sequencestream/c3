// Publish final check (release 5/7) — the last gate before tag + GitHub Release.
//
// After checksumming, prove the distribution set is internally consistent and complete
// BEFORE anything irreversible (git tag, `gh release create`):
//   1. re-hash every artifact and match manifest.artifacts[].sha256   (no post-build drift)
//   2. SHA256SUMS ↔ manifest agree line-for-line                       (same bytes throughout)
//   3. every P0 target is present in the manifest                      (no half-baked release)
//
// Any mismatch / missing P0 throws → publish aborts, no tag, no upload.
//
// Pure Node. CLI: node scripts/release/postgate.mjs [--manifest=dist/manifest.json]
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256File } from './manifest.mjs'
import { P0_TARGETS } from './targets.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

/**
 * The set of targets whose presence the dist MUST contain to publish.
 *
 * Default = the full P0 wave. When a release is cut for a target subset (CI passes
 * `C3_REQUIRED_TARGETS=<comma list>`, e.g. macOS-Intel runners are starved), the
 * required set narrows to P0 ∩ selected — so dropping a P0 target from the build
 * also drops it from the completeness gate (the operator opted out), while
 * experimental/non-P0 targets (windows-x64) are never hard-required regardless.
 */
export function requiredTargets(env = process.env) {
  const sel = (env.C3_REQUIRED_TARGETS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!sel.length) return P0_TARGETS
  return P0_TARGETS.filter((t) => sel.includes(t))
}

/** Parse a SHA256SUMS body (`<hex>  <name>` per line) into a name→hex map. */
export function parseSha256Sums(text) {
  const map = new Map()
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+(.+)$/.exec(line.trim())
    if (m) map.set(m[2], m[1])
  }
  return map
}

/**
 * Verify the dist set is consistent + complete. Throws on the first violation.
 * @param {object} [o]
 * @param {string} [o.manifestPath]
 * @param {(m: string) => void} [o.log]
 * @returns {{ checked: number }}
 */
export function verifyDist({ manifestPath, log = () => {} } = {}) {
  const mp = manifestPath ? resolve(manifestPath) : resolve(repoRoot, 'dist', 'manifest.json')
  if (!existsSync(mp))
    throw new Error(`manifest missing: ${mp} — run \`pnpm release:build\` first.`)
  const manifest = JSON.parse(readFileSync(mp, 'utf-8'))
  const distDir = dirname(mp)

  // 3. Required-target completeness (P0 ∩ selected — see requiredTargets()).
  const required = requiredTargets()
  const present = new Set(manifest.artifacts.map((a) => a.target))
  const missing = required.filter((t) => !present.has(t))
  if (missing.length)
    throw new Error(`required target(s) missing from manifest: ${missing.join(', ')}`)

  // 2. SHA256SUMS must exist (checksumming ran) and agree with the manifest.
  const sumsPath = resolve(distDir, 'SHA256SUMS')
  if (!existsSync(sumsPath))
    throw new Error(`SHA256SUMS missing: ${sumsPath} — run checksum first.`)
  const sums = parseSha256Sums(readFileSync(sumsPath, 'utf-8'))

  for (const a of manifest.artifacts) {
    const file = resolve(distDir, basename(a.file))
    if (!existsSync(file)) throw new Error(`artifact missing on disk: ${a.file}`)
    // 1. re-hash vs manifest.
    const actual = sha256File(file)
    if (actual !== a.sha256) {
      throw new Error(`sha256 drift for ${a.file}: manifest ${a.sha256} vs actual ${actual}`)
    }
    // 2. manifest vs SHA256SUMS.
    const inSums = sums.get(a.file)
    if (!inSums) throw new Error(`${a.file} absent from SHA256SUMS`)
    if (inSums !== a.sha256) {
      throw new Error(`SHA256SUMS mismatch for ${a.file}: ${inSums} vs manifest ${a.sha256}`)
    }
    log(`  ✓ ${a.target}  ${a.sha256.slice(0, 12)}…  (manifest = SHA256SUMS = on-disk)`)
  }

  // No orphan lines: every SHA256SUMS entry must map to a manifest artifact.
  const manifestNames = new Set(manifest.artifacts.map((a) => a.file))
  for (const name of sums.keys()) {
    if (!manifestNames.has(name)) throw new Error(`SHA256SUMS has orphan entry: ${name}`)
  }

  log(
    `  ✓ required complete (${required.join(', ') || 'none'}), ${manifest.artifacts.length} artifact(s) verified.`,
  )
  return { checked: manifest.artifacts.length }
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
    console.log('[verify-dist] checking manifest ↔ SHA256SUMS ↔ on-disk + P0 completeness…')
    verifyDist({
      manifestPath: typeof args.manifest === 'string' ? args.manifest : undefined,
      log: (m) => console.log(m),
    })
    console.log('[verify-dist] OK — distribution set consistent and complete.')
  } catch (err) {
    console.error(`[verify-dist] ✗ ${err.message}`)
    process.exit(1)
  }
}
