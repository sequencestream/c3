/**
 * Cursor {@link SkillLoader} (mount layer, ADR-0016/0017). Discovery dir is the
 * project-level `<projectDir>/.cursor/skills`, mirroring where the CLI keeps its
 * own bundled skills under the user data root. Support is gated on the
 * `cursor-agent` CLI being present: a resolvable `--version` ⇒ `full`, an absent
 * CLI ⇒ `none` (no link, console greyed).
 */
import type { SkillLoader } from '../types.js'
import {
  createSkillLoader,
  type SkillLoaderDeps,
  type SkillSupportProbe,
} from '../skill-loader-base.js'
import { cliVersion } from '../skill-probe-util.js'

const CURSOR_SKILL_DIR = ['.cursor', 'skills'] as const

const cursorSkillProbe: SkillSupportProbe = {
  version: async () => cliVersion('cursor-agent'),
  support: async () => ((await cliVersion('cursor-agent')) === 'unavailable' ? 'none' : 'full'),
}

export function createCursorSkillLoader(deps?: SkillLoaderDeps): SkillLoader {
  return createSkillLoader('cursor', CURSOR_SKILL_DIR, cursorSkillProbe, deps)
}
