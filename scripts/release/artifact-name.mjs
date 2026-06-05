// Release artifact naming.
//
// Two distinct naming layers, by design:
//
//   1. The BINARY is always named `c3` (or `c3.exe` on Windows). The version and
//      platform info do NOT live in the binary filename — the binary is the
//      consumer's `c3`, period. Multiple platforms coexist in a multi-target
//      build by being placed in per-target subdirs under `dist/<target>/c3`.
//   2. The PACKAGE (`c3-v{ver}-{target}{.ext}`) is what gets uploaded to the
//      GitHub Release. It bundles the binary + its inner sidecars
//      (`c3.sha256`, `c3.minisig`) into a single distributable archive; the
//      version and platform info live ONLY in the package filename.
//
// `pnpm binary` (self-use quickcut) keeps the un-versioned `dist/<target>/c3`
// output of `buildTarget()` and does NOT use the package helper.
//
// Windows gets `.zip` (the convention Windows users expect); POSIX targets
// get `.tar.gz`. The leading `v` is fixed; a `v`-prefixed version is not
// doubled (`normalizeVersion` strips a single leading `v`).
//
// Examples (version 0.2.0):
//   binary:  dist/macos-arm64/c3
//   package: c3-v0.2.0-macos-arm64.tar.gz
//   package: c3-v0.2.0-windows-x64.zip
//   inner:   c3-v0.2.0-macos-arm64.tar.gz → c3, c3.sha256, c3.minisig

/** Normalize a version string: strip a single leading `v`. */
export function normalizeVersion(version) {
  return String(version).replace(/^v/, '')
}

/** `c3` — the binary basename, always (no version, no platform). */
export function binaryName(target) {
  return target.startsWith('windows') ? 'c3.exe' : 'c3'
}

/** Archive extension per target: `.zip` on Windows, `.tar.gz` elsewhere. */
export function packageExt(target) {
  return target.startsWith('windows') ? '.zip' : '.tar.gz'
}

/**
 * `c3-v{ver}-{target}{.ext}` — the release:build / publish artifact basename
 * (the PACKAGE, not the binary). Extension is platform-conventional.
 */
export function packageName(version, target) {
  return `c3-v${normalizeVersion(version)}-${target}${packageExt(target)}`
}

// ── Back-compat shim ────────────────────────────────────────────────────────
// Older call sites (tests, docs) imported `artifactName`; keep the symbol
// alive pointing at the new package naming so the import surface doesn't break
// during the migration. New code should call `packageName` directly.
export const artifactName = packageName
