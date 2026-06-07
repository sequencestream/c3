/**
 * Codex {@link SkillLoader} (mount layer 2/3, ADR-0016/0017). Discovery dir is the
 * project-level `<projectDir>/.codex/skills` (decision D1: follow the task table's
 * project-level layout; ADR-0016 only verified codex's *user*-level discovery, so
 * project-level is a best-effort assumption recorded as an open gap in ADR-0017).
 * Support is gated on the `codex` CLI being present: a resolvable `--version` ⇒
 * `full`, an absent CLI (`'unavailable'`) ⇒ `none` (no link, console greyed).
 */
import type { SkillLoader } from '../types.js'
import {
  createSkillLoader,
  type SkillLoaderDeps,
  type SkillSupportProbe,
} from '../skill-loader-base.js'
import { cliVersion } from '../skill-probe-util.js'

const CODEX_SKILL_DIR = ['.codex', 'skills'] as const

const codexSkillProbe: SkillSupportProbe = {
  version: async () => cliVersion('codex'),
  // codex-cli ships a Claude-compatible skill system (ADR-0016 spike B); treat a
  // present CLI as supporting discovery, an absent one as unsupported.
  support: async () => ((await cliVersion('codex')) === 'unavailable' ? 'none' : 'full'),
}

export function createCodexSkillLoader(deps?: SkillLoaderDeps): SkillLoader {
  return createSkillLoader('codex', CODEX_SKILL_DIR, codexSkillProbe, deps)
}
