// Publish final check (release 5/7) — the last gate before tag + GitHub Release.
//
// After checksumming, prove the distribution set is internally consistent and complete
// BEFORE anything irreversible (git tag, `gh release create`):
//   0. manifest.schema is c3-release-manifest/*                       (client understands it)
//   1. re-hash every artifact and match manifest.artifacts[].sha256   (no post-build drift)
//   2. SHA256SUMS ↔ manifest agree line-for-line                       (same bytes throughout)
//   3. every P0 target is present in the manifest                      (no half-baked release)
//   4. no orphan business artifact in the dist root                    (nothing uploaded but unmanifested)
//
// Any mismatch / missing P0 / orphan throws → publish aborts, no tag, no upload.
//
// Pure Node. CLI: node scripts/release/postgate.mjs [--manifest=dist/manifest.json]
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256File } from './manifest.mjs'
import { P0_TARGETS } from './targets.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

/**
 * The set of targets whose presence the dist MUST contain to publish.
 *
 * Default = the full P0 wave. Each CI build job passes its own target via
 * `C3_REQUIRED_TARGETS=<target>`, so its postgate only requires that one target —
 * the required set narrows to P0 ∩ selected. Experimental/non-P0 targets
 * (windows-x64) are never hard-required regardless.
 */
export function requiredTargets(env = process.env) {
  const sel = (env.C3_REQUIRED_TARGETS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!sel.length) return P0_TARGETS
  return P0_TARGETS.filter((t) => sel.includes(t))
}

/**
 * The distribution channel whose completeness is being gated: `cli` (default) or
 * `desktop`. A desktop build job ships installers, not the CLI package, so its
 * postgate must look for its OWN channel — otherwise the P0 completeness check
 * reads a dist full of `.dmg`s and reports the CLI tarball missing.
 *
 * Artifacts written before the channel field existed are treated as `cli`, which
 * is what they were.
 */
export function requiredChannel(env = process.env) {
  const raw = (env.C3_REQUIRED_CHANNEL || '').trim()
  return raw || 'cli'
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

  // 0. Schema: the desktop updater parses this exact manifest, so it must be one of
  //    the schemas it understands (c3-release-manifest/*) — anything else is either
  //    a stale or foreign file and must not be trusted as a release manifest.
  if (typeof manifest.schema !== 'string' || !/^c3-release-manifest\//.test(manifest.schema)) {
    throw new Error(
      `manifest schema invalid: ${String(manifest.schema)} — expected c3-release-manifest/*`,
    )
  }

  // 3. Required-target completeness (P0 ∩ selected — see requiredTargets()),
  //    scoped to the channel under test.
  const required = requiredTargets()
  const channel = requiredChannel()
  const present = new Set(
    manifest.artifacts.filter((a) => (a.channel ?? 'cli') === channel).map((a) => a.target),
  )
  const missing = required.filter((t) => !present.has(t))
  if (missing.length)
    throw new Error(`required ${channel} target(s) missing from manifest: ${missing.join(', ')}`)

  // 3b. Desktop channel: every required target must carry EXACTLY ONE
  //     `preferred` self-update artifact. The updater never guesses between
  //     sibling installers — a desktop target without a unique preferred entry
  //     is not self-updatable and must not be declared so.
  if (channel === 'desktop') {
    for (const t of required) {
      const entries = manifest.artifacts.filter(
        (a) => (a.channel ?? 'cli') === 'desktop' && a.target === t,
      )
      const preferred = entries.filter((a) => a.preferred === true)
      if (preferred.length !== 1) {
        throw new Error(
          `desktop target ${t} must have exactly one preferred self-update artifact ` +
            `(found ${preferred.length} of ${entries.length})`,
        )
      }
    }
  }

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

  // 4. No orphan business artifacts: every release package sitting in the dist root
  //    must be described by the manifest. A stray package (e.g. one a merge step
  //    flattened but never manifested) would be uploaded to the Release yet never
  //    be verifiable by a consumer — fail before `gh` instead of shipping it.
  //    Only top-level files matching the release naming pattern count; `.sha256`
  //    sidecars ride along (the manifest describes the package, not the sidecar).
  const packagePattern =
    /^c3-(?:cli|desktop)-v.*\.(?:tar\.gz|zip|dmg|msi|exe|deb|AppImage|app\.tar\.gz)$/
  for (const name of readdirSync(distDir)) {
    const file = resolve(distDir, name)
    if (statSync(file).isDirectory()) continue
    if (name.endsWith('.sha256')) continue
    if (!packagePattern.test(name)) continue
    if (!manifestNames.has(name)) {
      throw new Error(`orphan release artifact not in manifest: ${name}`)
    }
  }

  log(
    `  ✓ required ${channel} complete (${required.join(', ') || 'none'}), ${manifest.artifacts.length} artifact(s) verified.`,
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
