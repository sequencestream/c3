/**
 * Cursor {@link SkillLoader} (mount layer, ADR-0016/0017). Discovery dir is the
 * project-level `<projectDir>/.cursor/skills`: the SDK's local runtime walks the
 * workspace for rules, skills, `AGENTS.md` and ignore files whenever the run
 * loads the `project` settings layer, which is what {@link cursorAgentOptions}
 * pins on. Support is gated on the SDK being resolvable ⇒ `full`, unresolvable ⇒
 * `none` (no link, console greyed) — through the shared resolution boundary, so
 * skill support can never disagree with what the driver will actually load.
 */
import type { SkillLoader } from '../types.js'
import {
  createSkillLoader,
  type SkillLoaderDeps,
  type SkillSupportProbe,
} from '../skill-loader-base.js'
import { cursorSdkAvailable, resolveCursorSdk, resolvedCursorSdkVersion } from './sdk-resolve.js'

const CURSOR_SKILL_DIR = ['.cursor', 'skills'] as const

/**
 * The resolved SDK version, or `'unavailable'` when the SDK is absent.
 *
 * The value only has to be stable per version and different across upgrades — it
 * keys the support cache. It is read off the copy that will actually be loaded, so
 * swapping the sidecar for a different version invalidates the cache.
 */
async function cursorSdkVersion(): Promise<string> {
  const resolution = resolveCursorSdk()
  return resolution.available ? resolvedCursorSdkVersion(resolution) : 'unavailable'
}

const cursorSkillProbe: SkillSupportProbe = {
  version: cursorSdkVersion,
  support: async () => (cursorSdkAvailable() ? 'full' : 'none'),
}

export function createCursorSkillLoader(deps?: SkillLoaderDeps): SkillLoader {
  return createSkillLoader('cursor', CURSOR_SKILL_DIR, cursorSkillProbe, deps)
}
