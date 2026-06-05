// Release manifest (release 2/7) — distribution-trust artifact.
//
// `harden=basic|standard` emits dist/manifest.json: a signed-later, verify-now record
// of exactly what was built (per-artifact sha256, size) plus provenance (version,
// commit, build time, harden tier). Motivation is distribution TRUST, not obfuscation —
// a consumer can `shasum -a 256` an artifact and match it against the manifest.
//
// Schema:
//   v1    — release 2/7 → 6/7. Per-artifact: { target, file, bytes, sha256, [experimental] }.
//   v1.1  — release 7/7. Adds per-artifact `obfuscation: { applied, durationMs }` when
//           the tier is `standard`. `applied: false` means the obfuscation pass failed
//           and the artifact shipped as the un-obfuscated (minified) bundle (graceful
//           fallback; the build kept going and a WARN was logged). For non-standard
//           tiers the field is omitted so v1 consumers see identical bytes.
//   Both schemas are accepted by postgate (it only checks sha256 ↔ SHA256SUMS ↔ disk
//   and P0 completeness; it doesn't introspect per-artifact fields).
//
// Pure Node, no deps.
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

/** v1.1 — release 7/7. v1 readers ignore unknown fields. */
export const MANIFEST_SCHEMA = 'c3-release-manifest/v1.1'

/** SHA-256 hex digest of a file's bytes. */
export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Build the manifest object.
 * @param {object} o
 * @param {{ version: string, commit: string, buildTime: string }} o.versionInfo
 * @param {string} o.harden                 the requested harden tier (recorded verbatim)
 * @param {Array<{
 *   target: string,
 *   file: string,
 *   experimental?: boolean,
 *   obfuscated?: boolean,                  // release 7/7 — when present (standard tier only)
 *   obfDurationMs?: number,                // release 7/7 — when obfuscated, ms spent
 * }>} o.artifacts
 *   file = absolute path; experimental = ships ⚠️experimental (smoke-unverified, release 4/7)
 *   obfuscated + obfDurationMs = standard-tier obfuscation result (release 7/7)
 */
export function buildManifest({ versionInfo, harden, artifacts }) {
  const isStandard = harden === 'standard'
  return {
    schema: MANIFEST_SCHEMA,
    version: versionInfo.version,
    commit: versionInfo.commit,
    buildTime: versionInfo.buildTime,
    harden,
    artifacts: artifacts.map((a) => {
      // Only stamp the flags when true — keeps basic/none entries byte-identical
      // to schema v1 (experimental) and v1.0 baseline. The standard tier always
      // carries the obfuscation block (applied: true|false — false = fallback fired).
      const entry = {
        target: a.target,
        file: basename(a.file),
        bytes: statSync(a.file).size,
        sha256: sha256File(a.file),
        ...(a.experimental ? { experimental: true } : {}),
        ...(isStandard
          ? {
              obfuscation: {
                applied: a.obfuscated === true,
                ...(a.obfuscated === true && typeof a.obfDurationMs === 'number'
                  ? { durationMs: a.obfDurationMs }
                  : {}),
              },
            }
          : {}),
      }
      return entry
    }),
  }
}

/** Write the manifest as pretty JSON (2-space indent, trailing newline). */
export function writeManifest(outPath, manifest) {
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
  return outPath
}
