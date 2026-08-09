/**
 * Cursor {@link SkillLoader} (mount layer). Discovery dir is the project-level
 * `<projectDir>/.cursor/skills`: the CLI walks the workspace for rules, skills,
 * `AGENTS.md` and ignore files under the workspace it is launched against, which
 * is what the run's `--workspace` pins. Support is gated on the CLI resolving ⇒
 * `full`, unresolved ⇒ `none` (no link, console greyed) — through the same probe
 * the driver launches through, so skill support can never disagree with what a
 * run will actually load.
 */
import type { SkillLoader } from '../types.js'
import {
  createSkillLoader,
  type SkillLoaderDeps,
  type SkillSupportProbe,
} from '../skill-loader-base.js'
import { probe } from '../../process/launcher.js'

const CURSOR_SKILL_DIR = ['.cursor', 'skills'] as const

/**
 * The resolved CLI version, or `'unavailable'` when it is absent.
 *
 * The value only has to be stable per version and different across upgrades — it
 * keys the support cache. It is read off the binary that will actually run, so an
 * upgrade invalidates the cache.
 */
async function cursorCliVersion(): Promise<string> {
  return probe('cursor').version ?? 'unavailable'
}

const cursorSkillProbe: SkillSupportProbe = {
  version: cursorCliVersion,
  support: async () => (probe('cursor').path ? 'full' : 'none'),
}

export function createCursorSkillLoader(deps?: SkillLoaderDeps): SkillLoader {
  return createSkillLoader('cursor', CURSOR_SKILL_DIR, cursorSkillProbe, deps)
}
