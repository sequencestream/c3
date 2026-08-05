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
//   v1.3  — desktop channel. One target can now carry MORE THAN ONE artifact (the
//           CLI package plus the desktop installers), so three descriptive fields
//           become part of the record: `channel` (`cli` | `desktop` — which
//           distribution a consumer is choosing), `kind` (the concrete artifact
//           type: `tarball`/`zip`/`dmg`/`app`/`msi`/`nsis`/`deb`/`appimage`), and
//           the `platform` + `arch` pair spelled out rather than left implicit in
//           the target name. `target` is NO LONGER a unique key; `file` is.
//
// Pure Node, no deps.
import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

/** v1.3 — desktop channel. v1/v1.1/v1.2 readers ignore unknown fields. */
export const MANIFEST_SCHEMA = 'c3-release-manifest/v1.3'

/** Distribution channels a consumer picks between. */
export const CHANNEL_CLI = 'cli'
export const CHANNEL_DESKTOP = 'desktop'

/**
 * Split a friendly target (`macos-arm64`) into its platform and arch. Both are
 * recorded explicitly so a manifest consumer never has to parse the target name.
 */
export function splitTarget(target) {
  const idx = String(target).indexOf('-')
  if (idx < 0) return { platform: String(target), arch: '' }
  return { platform: target.slice(0, idx), arch: target.slice(idx + 1) }
}

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
 *   channel?: string,                    // `cli` (default) | `desktop`
 *   kind?: string,                       // artifact type (tarball/zip/dmg/msi/…)
 *   preferred?: boolean,                 // the ONE updater-selected installer for its platform
 *   experimental?: boolean,
 * }>} o.artifacts
 *   file = absolute path to the PACKAGE (e.g. dist/c3-v0.2.0-macos-arm64.tar.gz).
 *   The `binary` + `binarySha256` pair identify the in-package binary.
 *   `bytes` / `sha256` default to disk reads (caller can pass them to avoid an
 *   extra stat / hash — pack.mjs already computed them).
 *   `channel` defaults to `cli` so every pre-desktop call site keeps producing
 *   the same meaning without being touched.
 *   `preferred` marks the single self-update installer for a platform — the
 *   desktop updater picks it over sibling installers of the same kind family
 *   instead of guessing between them.
 */
export function buildManifest({ versionInfo, artifacts }) {
  return {
    schema: MANIFEST_SCHEMA,
    version: versionInfo.version,
    commit: versionInfo.commit,
    buildTime: versionInfo.buildTime,
    artifacts: artifacts.map((a) => {
      const { platform, arch } = splitTarget(a.target)
      return {
        target: a.target,
        platform,
        arch,
        channel: a.channel ?? CHANNEL_CLI,
        ...(a.kind ? { kind: a.kind } : {}),
        file: basename(a.file),
        bytes: typeof a.bytes === 'number' ? a.bytes : statSync(a.file).size,
        sha256: typeof a.sha256 === 'string' ? a.sha256 : sha256File(a.file),
        ...(a.binary ? { binary: a.binary } : {}),
        ...(a.binarySha256 ? { binarySha256: a.binarySha256 } : {}),
        ...(a.preferred ? { preferred: true } : {}),
        ...(a.experimental ? { experimental: true } : {}),
      }
    }),
  }
}

/** Write the manifest as pretty JSON (2-space indent, trailing newline). */
export function writeManifest(outPath, manifest) {
  writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
  return outPath
}

/**
 * Entries already in `manifestPath` that belong to THIS build and that the caller
 * is not itself producing — i.e. the ones a writer must carry forward instead of
 * clobbering.
 *
 * Two channels now write the same file: `release:build` (cli) and
 * `release:desktop` (desktop). Whichever runs second must preserve the other's
 * entries, or the artifacts stay on disk while silently dropping out of the
 * manifest — and therefore out of SHA256SUMS, since checksumming reads the
 * manifest. Both writers go through this helper so the outcome does not depend
 * on which command ran last.
 *
 * A manifest from a DIFFERENT version/commit is stale output from an earlier
 * build and is discarded wholesale — mixing two builds is exactly what the
 * release gates exist to prevent.
 *
 * @param {string} manifestPath
 * @param {{ version: string, commit: string }} versionInfo
 * @param {string[]} [producedFiles] basenames the caller is (re)writing itself
 * @returns {Array<object>} entries to prepend to the caller's own artifacts
 */
export function carryForwardArtifacts(manifestPath, versionInfo, producedFiles = []) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  } catch {
    return [] // absent or corrupt — nothing to carry
  }
  if (parsed?.version !== versionInfo.version || parsed?.commit !== versionInfo.commit) return []
  if (!Array.isArray(parsed.artifacts)) return []
  const mine = new Set(producedFiles.map((f) => basename(f)))
  return parsed.artifacts.filter((a) => !mine.has(basename(a.file ?? '')))
}
