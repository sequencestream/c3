/**
 * Unit tests for the shared {@link SkillLoader} engine (mount layer 2/3).
 * Covers: path math, detectSkillSupport cache hit/miss/invalidation,
 * and ensureLink idempotency / conflict handling.
 *
 * From repo root: `rtk proxy npx vitest run adapters/skill-loader-base.test.ts`
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, readlink, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createSkillLoader, type SkillSupportProbe } from './skill-loader-base.js'
import { resetStateCacheForTests } from '../../../state.js'
import { rm } from 'node:fs/promises'

function fakeProbe(
  version: string,
  state: 'full' | 'none' | 'partial' = 'full',
): SkillSupportProbe {
  return {
    version: async () => version,
    support: async () => state,
  }
}

describe('SkillLoader base', () => {
  let tmpRoot: string
  let tmpProject: string
  let origConfigDir: string | undefined

  beforeEach(async () => {
    origConfigDir = process.env.CLAUDE_CONFIG_DIR
    resetStateCacheForTests()
    tmpRoot = await mkdtemp(join(tmpdir(), 'skill-loader-base-'))
    // Isolate state.json reads to a temp dir so tests don't hit the real file.
    process.env.CLAUDE_CONFIG_DIR = tmpRoot
    tmpProject = join(tmpRoot, 'project')
    await mkdir(tmpProject, { recursive: true })
  })

  afterEach(async () => {
    if (origConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = origConfigDir
    else delete process.env.CLAUDE_CONFIG_DIR
    resetStateCacheForTests()
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  describe('getVendorSkillDir', () => {
    it('joins projectDir with vendor segments', () => {
      const loader = createSkillLoader('claude', ['.claude', 'skills'], fakeProbe('v1'))
      expect(loader.getVendorSkillDir(tmpProject)).toBe(join(tmpProject, '.claude', 'skills'))
    })
    it('opencode uses .agents/skills', () => {
      const loader = createSkillLoader('opencode', ['.agents', 'skills'], fakeProbe('v1'))
      expect(loader.getVendorSkillDir(tmpProject)).toBe(join(tmpProject, '.agents', 'skills'))
    })
  })

  describe('detectSkillSupport', () => {
    it('returns the probed state', async () => {
      const loader = createSkillLoader('claude', ['.claude', 'skills'], fakeProbe('v1'))
      const report = await loader.detectSkillSupport()
      expect(report.state).toBe('full')
      expect(report.sdkVersion).toBe('v1')
    })

    it('caches when the version matches', async () => {
      let probeCalls = 0
      const probe: SkillSupportProbe = {
        version: async () => 'v1',
        support: async () => {
          probeCalls++
          return 'full' as const
        },
      }
      const loader = createSkillLoader('claude', ['.claude', 'skills'], probe)
      await loader.detectSkillSupport()
      await loader.detectSkillSupport()
      expect(probeCalls).toBe(1) // support() called only once (cache hit)
    })

    it('re-probes when the version changes (SDK upgrade)', async () => {
      let probeCalls = 0
      const versions = ['v1', 'v2']
      let idx = 0
      const probe: SkillSupportProbe = {
        version: async () => versions[idx++],
        support: async () => {
          probeCalls++
          return 'full' as const
        },
      }
      const loader = createSkillLoader('claude', ['.claude', 'skills'], probe)
      await loader.detectSkillSupport()
      expect(probeCalls).toBe(1)
      await loader.detectSkillSupport()
      expect(probeCalls).toBe(2) // version changed ⇒ re-probe
    })

    it('supports=false vendor (none) still records the report', async () => {
      const loader = createSkillLoader('opencode', ['.agents', 'skills'], fakeProbe('v1', 'none'))
      const report = await loader.detectSkillSupport()
      expect(report.state).toBe('none')
      expect(report.sdkVersion).toBe('v1')
    })
  })

  describe('ensureLink', () => {
    it('creates a new symlink', async () => {
      const target = join(tmpRoot, 'source')
      await mkdir(target, { recursive: true })
      const loader = createSkillLoader('claude', ['.claude', 'skills'], fakeProbe('v1'))
      const skillDir = loader.getVendorSkillDir(tmpProject)
      const linkPath = join(skillDir, '_c3_test')

      await loader.ensureLink(target, linkPath)

      const stat = await readlink(linkPath)
      expect(stat).toBe(target)
    })

    it('is idempotent: second call with same target is a no-op', async () => {
      const target = join(tmpRoot, 'source')
      await mkdir(target, { recursive: true })
      const loader = createSkillLoader('claude', ['.claude', 'skills'], fakeProbe('v1'))
      const skillDir = loader.getVendorSkillDir(tmpProject)
      const linkPath = join(skillDir, '_c3_test')

      await loader.ensureLink(target, linkPath)
      await loader.ensureLink(target, linkPath) // should not throw

      expect(await readlink(linkPath)).toBe(target)
    })

    it('throws when a non-symlink file occupies the path', async () => {
      const target = join(tmpRoot, 'source')
      await mkdir(target, { recursive: true })
      const loader = createSkillLoader('claude', ['.claude', 'skills'], fakeProbe('v1'))
      const skillDir = loader.getVendorSkillDir(tmpProject)
      const linkPath = join(skillDir, '_c3_test')
      await mkdir(join(skillDir), { recursive: true })
      await writeFile(linkPath, 'not a link')

      await expect(loader.ensureLink(target, linkPath)).rejects.toThrow(
        '挂载点已存在且不指向预期目标',
      )
    })

    it('throws when a symlink points at the wrong target', async () => {
      const target = join(tmpRoot, 'source')
      const wrongTarget = join(tmpRoot, 'wrong')
      await mkdir(target, { recursive: true })
      await mkdir(wrongTarget, { recursive: true })
      const loader = createSkillLoader('claude', ['.claude', 'skills'], fakeProbe('v1'))
      const skillDir = loader.getVendorSkillDir(tmpProject)
      const linkPath = join(skillDir, '_c3_test')

      await loader.ensureLink(wrongTarget, linkPath)
      await expect(loader.ensureLink(target, linkPath)).rejects.toThrow(
        '挂载点已存在且不指向预期目标',
      )
    })

    it('creates intermediate directories', async () => {
      const target = join(tmpRoot, 'source')
      await mkdir(target, { recursive: true })
      const loader = createSkillLoader('claude', ['.claude', 'skills'], fakeProbe('v1'))
      const linkPath = join(tmpProject, '.claude', 'skills', '_c3_test')

      await loader.ensureLink(target, linkPath)

      expect(await readlink(linkPath)).toBe(target)
    })
  })
})
