/**
 * Claude {@link SkillLoader} (mount layer 2/3, ADR-0016/0017). Discovery dir is the
 * project-level `<projectDir>/.claude/skills`; spike A proved the SDK discovers the
 * flat `skills/_c3_<id>/SKILL.md` layout, so Claude is a build-link-capable vendor
 * (`support: 'full'`). The cache key is the installed `@anthropic-ai/claude-agent-sdk`
 * version, so an SDK upgrade re-probes (active invalidation) — the 0.3.195 upgrade
 * (which fixes `commands_changed` not firing for synced skills) re-probes here and
 * still resolves `full`; skill discovery for the flat mount is unchanged.
 */
import type { SkillLoader } from '../types.js'
import {
  createSkillLoader,
  type SkillLoaderDeps,
  type SkillSupportProbe,
} from '../skill-loader-base.js'
import { pkgVersion } from '../skill-probe-util.js'

const CLAUDE_SKILL_DIR = ['.claude', 'skills'] as const

const claudeSkillProbe: SkillSupportProbe = {
  version: async () => pkgVersion('@anthropic-ai/claude-agent-sdk'),
  // Spike A (ADR-0016): the flat `skills/<name>/SKILL.md` glob is discovered.
  support: async () => 'full',
}

export function createClaudeSkillLoader(deps?: SkillLoaderDeps): SkillLoader {
  return createSkillLoader('claude', CLAUDE_SKILL_DIR, claudeSkillProbe, deps)
}
