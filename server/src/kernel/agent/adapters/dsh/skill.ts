import type { SkillLoader } from '../types.js'
import {
  createSkillLoader,
  type SkillLoaderDeps,
  type SkillSupportProbe,
} from '../skill-loader-base.js'
import { cliVersion } from '../skill-probe-util.js'

const DSH_SKILL_DIR = ['.dsh', 'skills'] as const

const dshSkillProbe: SkillSupportProbe = {
  version: async () => cliVersion('dsh'),
  support: async () => ((await cliVersion('dsh')) === 'unavailable' ? 'none' : 'partial'),
}

export function createDshSkillLoader(deps?: SkillLoaderDeps): SkillLoader {
  return createSkillLoader('dsh', DSH_SKILL_DIR, dshSkillProbe, deps)
}
