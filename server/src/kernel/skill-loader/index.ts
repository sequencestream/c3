/**
 * Skill mount lifecycle (mount layer 2/3, ADR-0016/0017) — turns a validated
 * `SkillRepoConfig` into a live, vendor-discovered skill by soft-linking the
 * on-disk clone (1/3's `ensureSkillRepo`) into EVERY build-link-capable vendor's
 * project-level discovery dir. The mount is silent — the configured `ref`'s head
 * is resolved and linked with no trust/vendor knobs and no pre-mount approval; the
 * only remaining gate is the one-time `.gitignore` append ack.
 *
 * Lifecycle contract (spec §6):
 *  - **per session, before `driver.start`** — `ensureLinksForLaunch` runs in
 *    `launchRun` ahead of the run.
 *  - **idempotent** — a recorded mount whose symlink still points at the same
 *    target and whose ref is unchanged is fully skipped (no clone, no relink).
 *  - **no cleanup** — links survive session end; a later session cache-hits them.
 *  - **cache invalidation** — a ref change (resolved SHA ≠ recorded) relinks the
 *    latest head silently.
 *  - **support-gated** — a vendor whose `detectSkillSupport` is not `full` builds
 *    NO link (greyed); the session still launches.
 *
 * The orchestrator is dependency-injected (`requestApproval`, `ensureRepo`,
 * `resolveRef`, `loaders`, `now`) so it unit-tests without a WS, a real git
 * remote, or live adapters.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { SkillRepoConfig, VendorId } from '@ccc/shared/protocol'
import type { SkillLoader } from '../agent/adapters/types.js'
import { ensureSkillRepo, lsRemote, type EnsureSkillRepoResult } from '../../skill-repo.js'
import { getSkillLink, setSkillLink, skillLinkKey, type SkillLinkRecord } from '../../state.js'
import {
  needsGitignoreAck,
  recordGitignoreAck,
  requestSkillApproval,
  type SkillApprovalAsk,
} from './approval.js'

/** One successfully mounted skill. */
export interface MountedSkill {
  id: string
  vendor: VendorId
  linkPath: string
  target: string
}

/** One skill not mounted, with a machine reason (never aborts the launch). */
export interface SkippedSkill {
  id: string
  vendor: VendorId
  reason: 'unsupported' | 'cache-hit' | 'gitignore-cancelled' | 'repo-error'
  detail?: string
}

export interface SkillMountOutcome {
  mounted: MountedSkill[]
  skipped: SkippedSkill[]
  /** Vendors that had a config targeting them but were not `full` (console greys them). */
  greyed: VendorId[]
}

export interface EnsureLinksDeps {
  projectDir: string
  configs: SkillRepoConfig[]
  /** vendor → its SkillLoader (from the available adapters). A missing key ⇒ vendor not available. */
  loaders: Partial<Record<VendorId, SkillLoader>>
  /** Ask the human to resolve the `.gitignore` gate (true = approve). Production wires this to {@link requestSkillApproval}. */
  requestApproval?: (ask: SkillApprovalAsk) => Promise<boolean>
  /** Aborts the launch (also resolves pending asks to cancel). */
  signal?: AbortSignal
  /** Bring a repo to disk (1/3). Default {@link ensureSkillRepo}. */
  ensureRepo?: (config: SkillRepoConfig) => Promise<EnsureSkillRepoResult>
  /** Resolve the remote ref to a SHA for change detection. Default {@link lsRemote}. */
  resolveRef?: (repo: string, ref: string) => Promise<string | null>
  /** Clock injection. Default `Date.now`. */
  now?: () => number
}

/** Default production approval: bridge to the WS transport. */
function defaultRequestApproval(signal?: AbortSignal) {
  return (ask: SkillApprovalAsk) => requestSkillApproval(ask, signal)
}

/** The build-link target vendors: every available vendor whose skill discovery is `full`. */
async function targetVendors(
  loaders: Partial<Record<VendorId, SkillLoader>>,
): Promise<{ supported: VendorId[]; greyed: VendorId[] }> {
  const supported: VendorId[] = []
  const greyed: VendorId[] = []
  for (const v of Object.keys(loaders) as VendorId[]) {
    const loader = loaders[v]
    if (!loader) {
      greyed.push(v)
      continue
    }
    const report = await loader.detectSkillSupport()
    if (report.state === 'full') supported.push(v)
    else greyed.push(v)
  }
  return { supported, greyed }
}

/**
 * Append `pattern` (a project-relative glob like `.claude/skills/_c3_` + wildcard
 * per the flat layout, e.g. `.claude/skills/_c3_<id>/`) to the project's
 * `.gitignore` if not already present. Idempotent; creates the file if absent.
 * The first-mount ack is asked separately (this just keeps the line present).
 */
function ensureGitignorePattern(projectDir: string, pattern: string): void {
  const file = join(projectDir, '.gitignore')
  let body = ''
  if (existsSync(file)) body = readFileSync(file, 'utf-8')
  const lines = body.split('\n').map((l) => l.trim())
  if (lines.includes(pattern)) return
  const prefix = body.length > 0 && !body.endsWith('\n') ? '\n' : ''
  appendFileSync(file, `${prefix}${pattern}\n`, 'utf-8')
}

/** The `.gitignore` glob for a vendor's mount dir, relative to the project root. */
function gitignorePatternFor(projectDir: string, loader: SkillLoader): string {
  const rel = relative(projectDir, loader.getVendorSkillDir(projectDir))
  return `${rel}/_c3_*/`
}

/**
 * Bring every `config` to a mounted, vendor-discovered state for this launch.
 * See the module contract. Silent: the only human gate is the one-time
 * `.gitignore` append; every failure degrades to a `skipped` entry, never throws.
 */
export async function ensureLinksForLaunch(deps: EnsureLinksDeps): Promise<SkillMountOutcome> {
  const {
    projectDir,
    configs,
    loaders,
    signal,
    ensureRepo = ensureSkillRepo,
    resolveRef = lsRemote,
    now = Date.now,
  } = deps
  const requestApproval = deps.requestApproval ?? defaultRequestApproval(signal)

  const mounted: MountedSkill[] = []
  const skipped: SkippedSkill[] = []
  const greyedSet = new Set<VendorId>()

  for (const config of configs) {
    const { supported, greyed } = await targetVendors(loaders)
    for (const v of greyed) {
      greyedSet.add(v)
      skipped.push({ id: config.id, vendor: v, reason: 'unsupported' })
    }

    for (const vendor of supported) {
      const loader = loaders[vendor]!
      const key = skillLinkKey(projectDir, vendor, config.id)
      const existing = getSkillLink(key)

      // Resolve the current remote ref identity (SHA) for cache-hit + change detection.
      let resolvedRef = config.ref
      try {
        resolvedRef = (await resolveRef(config.repo, config.ref)) ?? config.ref
      } catch {
        // ls-remote unreachable: fall back to the configured ref string; a recorded
        // mount still cache-hits on an unchanged config, an unrecorded one proceeds.
      }

      // Cache hit: recorded, symlink present, ref unchanged ⇒ fully skip (no clone, no relink).
      if (existing && existing.ref === resolvedRef && existsSync(existing.linkPath)) {
        skipped.push({ id: config.id, vendor, reason: 'cache-hit' })
        continue
      }

      // .gitignore gate (per project, once) — but always keep the vendor pattern present.
      const pattern = gitignorePatternFor(projectDir, loader)
      if (needsGitignoreAck(projectDir)) {
        const ok = await requestApproval({
          kind: 'gitignore',
          id: config.id,
          vendor,
          repo: config.repo,
          ref: config.ref,
          detail: `即将向 ${projectDir}/.gitignore 追加: ${pattern}`,
        })
        if (!ok) {
          skipped.push({ id: config.id, vendor, reason: 'gitignore-cancelled' })
          continue
        }
        recordGitignoreAck(projectDir)
      }
      ensureGitignorePattern(projectDir, pattern)

      // Bring the repo to disk (clone/pull the configured ref's head).
      const repo = await ensureRepo(config)
      if (!repo.ok || !repo.skillDir) {
        skipped.push({ id: config.id, vendor, reason: 'repo-error', detail: repo.error })
        continue
      }

      // Build the flat `_c3_<id>` symlink into the vendor's discovery dir.
      const linkPath = join(loader.getVendorSkillDir(projectDir), `_c3_${config.id}`)
      await loader.ensureLink(repo.skillDir, linkPath)

      const record: SkillLinkRecord = {
        id: config.id,
        projectDir,
        vendor,
        linkPath,
        target: repo.skillDir,
        ref: resolvedRef,
        createdAt: now(),
      }
      setSkillLink(key, record)
      mounted.push({ id: config.id, vendor, linkPath, target: repo.skillDir })
    }
  }

  return { mounted, skipped, greyed: [...greyedSet] }
}
