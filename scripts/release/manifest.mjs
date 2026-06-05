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
//   v1.2  — release 8/7 (binary→package split). `artifacts[].file` is now the
//           PACKAGE filename (`c3-v{ver}-{target}{.tar.gz|.zip}`), and two new
//           fields describe the in-package binary: `binary` (`c3` / `c3.exe`) and
//           `binarySha256` (sha256 of the inner binary). `bytes` and `sha256` are
//           the package's; `binarySha256` is the inner binary's. v1.1 readers
//           ignore the new fields (so the rename is non-breaking for old
//           consumers). The postgate still only checks `sha256` ↔ SHA256SUMS ↔
//           disk and P0 completeness — it doesn't introspect `binarySha256`.
//   All schemas are accepted by postgate (it only checks sha256 ↔ SHA256SUMS ↔
//   disk and P0 completeness; it doesn't introspect per-artifact fields).
//
// Pure Node, no deps.
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

/** v1.2 — release 8/7. v1/v1.1 readers ignore unknown fields. */
export const MANIFEST_SCHEMA = 'c3-release-manifest/v1.2'

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
 *   bytes?: number,                     // release 8/7: optional. If absent, re-read from disk.
 *   sha256?: string,                     // release 8/7: optional. If absent, re-read from disk.
 *   binary?: string,                     // release 8/7: in-package binary name (`c3` / `c3.exe`)
 *   binarySha256?: string,               // release 8/7: sha256 of the INNER binary
 *   experimental?: boolean,
 *   obfuscated?: boolean,                // release 7/7 — when present (standard tier only)
 *   obfDurationMs?: number,              // release 7/7 — when obfuscated, ms spent
 * }>} o.artifacts
 *   file = absolute path to the PACKAGE (e.g. dist/c3-v0.2.0-macos-arm64.tar.gz).
 *   The `binary` + `binarySha256` pair identify the in-package binary.
 *   `bytes` / `sha256` default to disk reads (caller can pass them to avoid an
 *   extra stat / hash — release 8/7: pack.mjs already computed them).
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
      // Only stamp the flags when true — keeps basic/none entries close to
      // schema v1 (experimental) and v1.0 baseline. The standard tier always
      // carries the obfuscation block (applied: true|false — false = fallback fired).
      const entry = {
        target: a.target,
        file: basename(a.file),
        bytes: typeof a.bytes === 'number' ? a.bytes : statSync(a.file).size,
        sha256: typeof a.sha256 === 'string' ? a.sha256 : sha256File(a.file),
        ...(a.binary ? { binary: a.binary } : {}),
        ...(a.binarySha256 ? { binarySha256: a.binarySha256 } : {}),
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
