// Release artifact naming (release 3/7).
//
// release:build output is version-stamped: `c3-v{ver}-{os}-{arch}{.exe?}`. The leading
// `v` is fixed; the version's own `v` (e.g. a `v0.2.0` git tag) is normalized away so we
// never emit `c3-vv0.2.0-…`. Windows targets get `.exe` (forward-looking; no windows in P0).
// `pnpm binary` (self-use quickcut) keeps the un-versioned `c3-<os>-<arch>` name and does
// NOT use this helper.

/** Normalize a version string: strip a single leading `v`. */
export function normalizeVersion(version) {
  return String(version).replace(/^v/, '')
}

/** `c3-v{ver}-{target}{.exe?}` — the release:build / publish artifact basename. */
export function artifactName(version, target) {
  const ext = target.startsWith('windows') ? '.exe' : ''
  return `c3-v${normalizeVersion(version)}-${target}${ext}`
}
