/**
 * Cursor {@link SkillLoader} (mount layer, ADR-0016/0017). Discovery dir is the
 * project-level `<projectDir>/.cursor/skills`: the SDK's local runtime walks the
 * workspace for rules, skills, `AGENTS.md` and ignore files whenever the run
 * loads the `project` settings layer, which is what {@link cursorAgentOptions}
 * pins on. Support is gated on the SDK being installed — resolvable ⇒ `full`,
 * unresolvable ⇒ `none` (no link, console greyed).
 *
 * Resolution deliberately stops at `require.resolve`: actually importing the SDK
 * would load its local runtime and platform-native package, which is far too much
 * work for a probe that only needs to answer "is it there".
 */
import { createRequire } from 'node:module'
import type { SkillLoader } from '../types.js'
import {
  createSkillLoader,
  type SkillLoaderDeps,
  type SkillSupportProbe,
} from '../skill-loader-base.js'
import { pkgVersion } from '../skill-probe-util.js'

const CURSOR_SKILL_DIR = ['.cursor', 'skills'] as const

/**
 * Whether `@cursor/sdk` is installed and resolvable from this process — the
 * whole of Cursor's availability check, since the SDK ships as a c3 dependency
 * rather than a host CLI the operator installs.
 */
export function cursorSdkAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve('@cursor/sdk')
    return true
  } catch {
    return false
  }
}

/**
 * The installed SDK version, or `'unavailable'` when the SDK is absent.
 *
 * The value only has to be stable per version and different across upgrades — it
 * keys the support cache. `@cursor/sdk` does not export its `package.json`, so
 * {@link pkgVersion} may answer `'unknown'`; that is still a usable key (it just
 * cannot observe an upgrade on its own), which is why it is passed through rather
 * than treated as a failure.
 */
async function cursorSdkVersion(): Promise<string> {
  return cursorSdkAvailable() ? pkgVersion('@cursor/sdk') : 'unavailable'
}

const cursorSkillProbe: SkillSupportProbe = {
  version: cursorSdkVersion,
  support: async () => (cursorSdkAvailable() ? 'full' : 'none'),
}

export function createCursorSkillLoader(deps?: SkillLoaderDeps): SkillLoader {
  return createSkillLoader('cursor', CURSOR_SKILL_DIR, cursorSkillProbe, deps)
}
