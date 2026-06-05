// Shared target knowledge (release 5/7) — single source for the P0 matrix, the
// known-target whitelist, and host-runnability. Both the build orchestrator and
// the quality gates (smoke, publish verify-dist) consume these so the P0 set is
// defined exactly once.
//
// Keep `KNOWN_TARGETS` in sync with `TARGETS` in server/scripts/release/build-target.mjs.

/** The P0 wave: macOS-arm64 + Linux-x64-glibc. Every release MUST ship all of these. */
export const P0_TARGETS = ['macos-arm64', 'linux-x64']

/** Friendly target names the orchestrator accepts (P0 today; later waves extend). */
export const KNOWN_TARGETS = ['macos-arm64', 'linux-x64']

/** Default build matrix when `--targets` is omitted. */
export const DEFAULT_TARGETS = [...P0_TARGETS]

/**
 * The friendly target name runnable on THIS host (`<os>-<arch>`), e.g. `macos-arm64`.
 * `darwin` normalizes to `macos` to match the artifact naming convention.
 */
export function hostTarget(platform = process.platform, arch = process.arch) {
  const os = platform === 'darwin' ? 'macos' : platform
  return `${os}-${arch}`
}

/**
 * Can a binary built for `target` execute on this host? A cross-compiled binary
 * (e.g. a linux-x64 artifact sitting on a macOS runner) cannot — so its smoke gate
 * is skipped and left to that platform's CI runner.
 */
export function isHostRunnable(target, platform = process.platform, arch = process.arch) {
  return target === hostTarget(platform, arch)
}
