/**
 * OpenCode {@link SkillLoader} (mount layer 2/3, ADR-0016/0017). Discovery dir is
 * the project-level `<projectDir>/.agents/skills`. Per ADR-0016 spike B, opencode's
 * skill-discovery mechanism is **unverified** (no opencode host was available to
 * probe), so by the "any vendor we can't confirm scans ⇒ build no link" safety rule
 * its support is hard-`none`: the path math exists (so a future spike can flip it by
 * editing only this probe), but the upper layer builds no link and the console greys
 * opencode. The session still launches.
 */
import type { SkillLoader } from '../types.js'
import {
  createSkillLoader,
  type SkillLoaderDeps,
  type SkillSupportProbe,
} from '../skill-loader-base.js'
import { cliVersion } from '../skill-probe-util.js'

const OPENCODE_SKILL_DIR = ['.agents', 'skills'] as const

const opencodeSkillProbe: SkillSupportProbe = {
  version: async () => cliVersion('/Users/tiltwind/.opencode/bin/opencode'),
  support: async () =>
    (await cliVersion('/Users/tiltwind/.opencode/bin/opencode')) === 'unavailable'
      ? 'none'
      : 'partial',
}

export function createOpencodeSkillLoader(deps?: SkillLoaderDeps): SkillLoader {
  return createSkillLoader('opencode', OPENCODE_SKILL_DIR, opencodeSkillProbe, deps)
}
