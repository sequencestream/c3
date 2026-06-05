// Release manifest (release 2/7) — distribution-trust artifact.
//
// `harden=basic|standard` emits dist/manifest.json: a signed-later, verify-now record
// of exactly what was built (per-artifact sha256, size) plus provenance (version,
// commit, build time, harden tier). Motivation is distribution TRUST, not obfuscation —
// a consumer can `shasum -a 256` an artifact and match it against the manifest.
//
// Pure Node, no deps.
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

export const MANIFEST_SCHEMA = 'c3-release-manifest/v1'

/** SHA-256 hex digest of a file's bytes. */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Build the manifest object.
 * @param {object} o
 * @param {{ version: string, commit: string, buildTime: string }} o.versionInfo
 * @param {string} o.harden                 the requested harden tier (recorded verbatim)
 * @param {Array<{ target: string, file: string, experimental?: boolean }>} o.artifacts
 *        file = absolute path; experimental = ships ⚠️experimental (smoke-unverified, release 4/7)
 */
export function buildManifest({ versionInfo, harden, artifacts }) {
  return {
    schema: MANIFEST_SCHEMA,
    version: versionInfo.version,
    commit: versionInfo.commit,
    buildTime: versionInfo.buildTime,
    harden,
    artifacts: artifacts.map((a) => ({
      target: a.target,
      file: basename(a.file),
      bytes: statSync(a.file).size,
      sha256: sha256File(a.file),
      // Only stamp the flag when true — keeps P0 entries identical to schema v1.
      ...(a.experimental ? { experimental: true } : {}),
    })),
  }
}

/** Write the manifest as pretty JSON (2-space indent, trailing newline). */
export function writeManifest(outPath, manifest) {
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
  return outPath
}
