// Shared target knowledge (release 5/7) — single source for the P0 matrix, the
// known-target whitelist, and host-runnability. Both the build orchestrator and
// the quality gates (smoke, publish verify-dist) consume these so the P0 set is
// defined exactly once.
//
// Keep `KNOWN_TARGETS` in sync with `TARGETS` in server/scripts/release/build-target.mjs.

/** The P0 wave: macOS-arm64 + Linux-x64-glibc. Every release MUST ship all of these. */
export const P0_TARGETS = ['macos-arm64', 'linux-x64']

/**
 * The P1 wave (release 4/7): additive platforms. NOT required for a release — a P1
 * absence never blocks publish (postgate gates only on P0). macos-x64 is host-runnable
 * on Intel macs; windows-x64 ships experimental until a real windows-latest smoke is green.
 */
export const P1_TARGETS = ['macos-x64', 'windows-x64']

/**
 * Targets whose binaries ship marked `⚠️experimental` because they have NOT yet passed
 * a real headless smoke on their own OS runner (release 4/7). A target leaves this set
 * only once its platform CI smoke is green. windows-x64 is cross-compiled here but never
 * executed on windows-latest in this repo's current state (no release CI workflow yet),
 * so it stays experimental.
 */
export const EXPERIMENTAL_TARGETS = ['windows-x64']

/** Friendly target names the orchestrator accepts (P0 + P1; later waves extend). */
export const KNOWN_TARGETS = [...P0_TARGETS, ...P1_TARGETS]

/** Default build matrix when `--targets` is omitted: the full P0 + P1 wave. */
export const DEFAULT_TARGETS = [...P0_TARGETS, ...P1_TARGETS]

/** Whether `target`'s artifact must be marked experimental (smoke-unverified on its OS). */
export function isExperimental(target) {
  return EXPERIMENTAL_TARGETS.includes(target)
}

/**
 * The friendly target name runnable on THIS host (`<os>-<arch>`), e.g. `macos-arm64`.
 * `darwin` → `macos` and `win32` → `windows` to match the artifact naming convention.
 */
export function hostTarget(platform = process.platform, arch = process.arch) {
  const os = platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform
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
