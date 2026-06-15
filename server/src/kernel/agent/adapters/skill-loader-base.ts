/**
 * The shared {@link SkillLoader} engine (mount layer 2/3, ADR-0016/0017). The three
 * vendor skill loaders (`claude/skill.ts`, `codex/skill.ts`)
 * differ only in (a) their vendor id, (b) their project-level discovery dir
 * segments, and (c) how support is probed — so the path math, the cache +
 * SDK-version invalidation, and the idempotent symlink all live here once.
 *
 * `detectSkillSupport` caches its verdict in `state.json` keyed by vendor and
 * re-probes only when the probed SDK/CLI version changes (an upgrade may flip
 * discovery behaviour). A `none`/`temporarily-unavailable` verdict tells the upper
 * layer to build NO link for the vendor (the console greys it, the session still
 * launches). `ensureLink` is idempotent: an existing symlink that already points at
 * the same target is a no-op; anything else occupying the path throws rather than
 * being silently clobbered.
 */
import { lstat, mkdir, readlink, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { VendorId } from '@ccc/shared/protocol'
import type { SkillLoader, SkillSupportReport } from './types.js'
import { getSkillSupport, setSkillSupport } from '../../../state.js'

/**
 * How a vendor reports its skill-discovery support. Split into a cheap `version()`
 * (the cache key) and a `support()` verdict so the loader can skip the verdict work
 * on a cache hit. Both are injectable so tests drive support/invalidation without a
 * real SDK/CLI.
 */
export interface SkillSupportProbe {
  /** Current vendor SDK/CLI version; a change invalidates the cached verdict. */
  version(): Promise<string>
  /** Whether this vendor discovers c3's mounted skills at the current version. */
  support(): Promise<SkillSupportReport['state']>
}

export interface SkillLoaderDeps {
  /** Clock injection (tests). Defaults to `Date.now`. */
  now?: () => number
  /** Override the support probe (tests). Defaults to the vendor's own probe. */
  probe?: SkillSupportProbe
}

/**
 * Build a {@link SkillLoader} for `vendor` whose discovery dir is `projectDir`
 * joined with `vendorDirSegments` (e.g. `['.claude','skills']`). `defaultProbe`
 * is the vendor's production support probe; `deps.probe` overrides it in tests.
 */
export function createSkillLoader(
  vendor: VendorId,
  vendorDirSegments: readonly string[],
  defaultProbe: SkillSupportProbe,
  deps: SkillLoaderDeps = {},
): SkillLoader {
  const probe = deps.probe ?? defaultProbe
  const now = deps.now ?? Date.now

  return {
    vendor,

    getVendorSkillDir(projectDir: string): string {
      return join(projectDir, ...vendorDirSegments)
    },

    async detectSkillSupport(): Promise<SkillSupportReport> {
      const version = await probe.version()
      const cached = getSkillSupport(vendor)
      // Cache hit only when the probed version still matches — an SDK upgrade
      // (different version) forces a fresh verdict (ADR-0017 active invalidation).
      if (cached && cached.sdkVersion === version) return cached
      const state = await probe.support()
      const report: SkillSupportReport = { state, sdkVersion: version, checkedAt: now() }
      setSkillSupport(vendor, report)
      return report
    },

    async ensureLink(target: string, linkPath: string): Promise<void> {
      let existing: Awaited<ReturnType<typeof lstat>> | null = null
      try {
        existing = await lstat(linkPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      if (existing) {
        if (existing.isSymbolicLink() && (await readlink(linkPath)) === target) {
          return // already linked to the same source — idempotent no-op
        }
        throw new Error(`挂载点已存在且不指向预期目标,拒绝覆盖: ${linkPath}`)
      }
      await mkdir(dirname(linkPath), { recursive: true })
      await symlink(target, linkPath, 'dir')
    },
  }
}
