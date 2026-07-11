// Shared target knowledge (release 5/7 + 6/7) — single source for the P0 matrix, the
// known-target whitelist, and host-runnability. Both the build orchestrator and
// the quality gates (smoke, publish verify-dist) consume these so the P0 set is
// defined exactly once.
//
// Keep `KNOWN_TARGETS` in sync with `TARGETS` in server/scripts/release/build-target.mjs.

/**
 * The P0 wave: macOS-arm64 + Linux-x64-glibc. Every release MUST ship all of these.
 * The GH Actions native matrix builds each on its own OS runner with a green headless
 * smoke — see doc/non-functional/release.md.
 */
export const P0_TARGETS = ['macos-arm64', 'linux-x64']

/**
 * The P1 wave: additive platforms still in queue. NOT required for a release —
 * a P1 absence never blocks publish (postgate gates only on P0). Empty; the slot
 * is reserved for the next de-experimental candidate (windows-x64 once a real
 * windows-latest smoke is green).
 */
export const P1_TARGETS = []

/**
 * Targets whose binaries ship marked `⚠️experimental` because they have NOT yet passed
 * a real headless smoke on their own OS runner (release 4/7 + 6/7). A target leaves
 * this set only once its platform CI smoke is green. windows-x64 is the last holdout:
 * the 6/7 GH Actions matrix includes a windows-latest job that runs the smoke natively,
 * so removing it is a one-line change once that job is green.
 *
 * Experimental targets are STILL buildable — `release:build` accepts them via
 * `KNOWN_TARGETS` (below) and a failed experimental build is treated as best-effort
 * (warns + drops, never blocks the P0 cut). The flag exists for the manifest entry /
 * README ⚠️, not for gating the build itself.
 */
export const EXPERIMENTAL_TARGETS = ['windows-x64']

/**
 * Friendly target names the orchestrator accepts (P0 + P1 + experimental).
 * The experimental set must be included so `--targets=windows-x64` (the
 * windows-latest probe job in the GH Actions matrix) is accepted; gating
 * still lives in `postgate` (P0-only) and `release-build.mjs`
 * (`isExperimental` → best-effort drop on failure).
 */
export const KNOWN_TARGETS = [...P0_TARGETS, ...P1_TARGETS, ...EXPERIMENTAL_TARGETS]

/** Default build matrix when `--targets` is omitted: the full P0 + P1 wave
 *  (experimental targets must be opted in explicitly so a casual
 *  `pnpm release:build` on a dev box never accidentally tries to build
 *  an unsupported platform). */
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
