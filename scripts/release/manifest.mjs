// Release manifest (release 2/7) — distribution-trust artifact.
//
// dist/manifest.json is a verify-now record of exactly what was built (per-artifact
// sha256, size) plus provenance (version, commit, build time). Motivation is
// distribution TRUST — a consumer can `shasum -a 256` an artifact and match it
// against the manifest.
//
// Schema:
//   v1.2  — binary→package split. `artifacts[].file` is the PACKAGE filename
//           (`c3-v{ver}-{target}{.tar.gz|.zip}`); two extra fields describe the
//           in-package binary: `binary` (`c3` / `c3.exe`) and `binarySha256`
//           (sha256 of the inner binary). `bytes` and `sha256` are the package's;
//           `binarySha256` is the inner binary's. The postgate only checks `sha256`
//           ↔ SHA256SUMS ↔ disk and P0 completeness — it doesn't introspect
//           per-artifact fields.
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
 * @param {Array<{
 *   target: string,
 *   file: string,
 *   bytes?: number,                     // optional. If absent, re-read from disk.
 *   sha256?: string,                     // optional. If absent, re-read from disk.
 *   binary?: string,                     // in-package binary name (`c3` / `c3.exe`)
 *   binarySha256?: string,               // sha256 of the INNER binary
 *   experimental?: boolean,
 * }>} o.artifacts
 *   file = absolute path to the PACKAGE (e.g. dist/c3-v0.2.0-macos-arm64.tar.gz).
 *   The `binary` + `binarySha256` pair identify the in-package binary.
 *   `bytes` / `sha256` default to disk reads (caller can pass them to avoid an
 *   extra stat / hash — pack.mjs already computed them).
 */
export function buildManifest({ versionInfo, artifacts }) {
  return {
    schema: MANIFEST_SCHEMA,
    version: versionInfo.version,
    commit: versionInfo.commit,
    buildTime: versionInfo.buildTime,
    artifacts: artifacts.map((a) => ({
      target: a.target,
      file: basename(a.file),
      bytes: typeof a.bytes === 'number' ? a.bytes : statSync(a.file).size,
      sha256: typeof a.sha256 === 'string' ? a.sha256 : sha256File(a.file),
      ...(a.binary ? { binary: a.binary } : {}),
      ...(a.binarySha256 ? { binarySha256: a.binarySha256 } : {}),
      ...(a.experimental ? { experimental: true } : {}),
    })),
  }
}

/** Write the manifest as pretty JSON (2-space indent, trailing newline). */
export function writeManifest(outPath, manifest) {
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
  return outPath
}
