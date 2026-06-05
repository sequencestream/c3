// Build-time version source-of-truth (release 2/7).
//
// SoT for the version is the **git tag** (`git describe --tags`), NOT a package.json
// bump — releases are cut by tagging. package.json `version` is the fallback baseline
// (kept in sync with the most recent tag) used when no tag is reachable (e.g. a fresh
// clone with zero tags, as is the case today).
//
// Pure Node, no deps. Imported by both build chains (esbuild server/build.mjs and the
// Bun build-target.mjs) and by the release orchestrator, so they inject identical
// `define` constants. The orchestrator computes this ONCE and threads the values down
// to every target so all artifacts (and the manifest) share one build time.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeVersion } from './artifact-name.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

function git(args) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf-8' })
  return r.status === 0 ? r.stdout.trim() : null
}

/** Read the package.json baseline version (fallback when no git tag is reachable). */
export function baselineVersion() {
  try {
    return JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Resolve the version info injected at build time.
 * @param {{ buildTime?: string }} [o]
 * @returns {{ version: string, commit: string, buildTime: string, baseline: string }}
 */
export function computeVersionInfo({ buildTime } = {}) {
  const baseline = baselineVersion()
  // Precedence: explicit C3_RELEASE_VERSION override (CI release cut with a chosen
  // version, e.g. `v0.1.0`) > git tag (SoT) > package.json baseline (no tag reachable).
  // The override is normalized (a single leading `v` stripped) so it matches the
  // v-less convention of the baseline — packageName/notes re-prefix the `v`.
  const override = (process.env.C3_RELEASE_VERSION || '').trim()
  const version = override
    ? normalizeVersion(override)
    : git(['describe', '--tags', '--abbrev=7']) || baseline
  const commit = git(['rev-parse', '--short=7', 'HEAD']) || 'unknown'
  return { version, commit, buildTime: buildTime ?? new Date().toISOString(), baseline }
}

/** Map version info to esbuild/Bun `define` constants (string-literal injection). */
export function versionDefines(info) {
  return {
    __C3_VERSION__: JSON.stringify(info.version),
    __C3_COMMIT__: JSON.stringify(info.commit),
    __C3_BUILD_TIME__: JSON.stringify(info.buildTime),
  }
}
