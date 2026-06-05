// Runtime version info. The three constants below are replaced at build time by the
// esbuild / Bun `define` injection (see scripts/release/version-info.mjs). In the tsx
// dev path no `define` is applied (RELEASE_HARDEN=none semantics), so the `typeof`
// guards fall back to dev markers — referencing an undeclared name via `typeof` is
// safe and never throws.
declare const __C3_VERSION__: string
declare const __C3_COMMIT__: string
declare const __C3_BUILD_TIME__: string

export const VERSION = typeof __C3_VERSION__ !== 'undefined' ? __C3_VERSION__ : '0.0.0-dev'
export const COMMIT = typeof __C3_COMMIT__ !== 'undefined' ? __C3_COMMIT__ : 'unknown'
export const BUILD_TIME = typeof __C3_BUILD_TIME__ !== 'undefined' ? __C3_BUILD_TIME__ : 'dev'

/** `c3 --version` output: version + short commit + build time. */
export function versionString(): string {
  return `${VERSION} (commit ${COMMIT}, built ${BUILD_TIME})`
}
