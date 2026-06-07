/**
 * Skill mount lifecycle (mount layer 2/3, ADR-0016/0017) — turns a validated
 * `SkillRepoConfig` into a live, vendor-discovered skill by soft-linking the
 * on-disk clone (1/3's `ensureSkillRepo`) into each target vendor's project-level
 * discovery dir, gated by trust + `.gitignore` acks.
 *
 * Lifecycle contract (spec §6):
 *  - **per session, before `driver.start`** — `ensureLinksForLaunch` runs in
 *    `launchRun` ahead of the run.
 *  - **idempotent** — a recorded mount whose symlink still points at the same
 *    target and whose ref is unchanged is fully skipped (no clone, no relink).
 *  - **no cleanup** — links survive session end; a later session cache-hits them.
 *  - **cache invalidation** — a ref change (resolved SHA ≠ recorded) re-gates per
 *    trust tier (`unreviewed`/`review-on-update` re-ask; `pinned` re-verifies and
 *    errors on a vanished commit).
 *  - **support-gated** — a vendor whose `detectSkillSupport` is not `full` builds
 *    NO link (greyed); the session still launches.
 *  - **unreviewed cancel ⇒ no launch** — throws {@link SkillLoadCancelled}.
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
import {
  getSkillLink,
  listSkillLinks,
  markSkillLinkConsumed,
  setSkillLink,
  skillLinkKey,
  type SkillLinkRecord,
} from '../../state.js'
import {
  evaluateTrustGate,
  needsGitignoreAck,
  recordGitignoreAck,
  recordTrustAck,
  requestSkillApproval,
  type SkillApprovalAsk,
} from './approval.js'

/** Thrown when an `unreviewed` trust gate is cancelled — the session must NOT launch. */
export class SkillLoadCancelled extends Error {
  constructor(
    readonly id: string,
    readonly vendor: VendorId,
  ) {
    super(`外部 skill 加载被取消 (unreviewed 未确认): ${id} → ${vendor}`)
    this.name = 'SkillLoadCancelled'
  }
}

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
  reason: 'unsupported' | 'cache-hit' | 'gitignore-cancelled' | 'review-cancelled' | 'repo-error'
  detail?: string
}

export interface SkillMountOutcome {
  mounted: MountedSkill[]
  skipped: SkippedSkill[]
  /** Vendors that had a config targeting them but were not `full` (console greys them). */
  greyed: VendorId[]
  /**
   * Idempotency keys of the links this launch actually uses (freshly mounted +
   * cache-hit). A link is "consumed" only once the run truly starts, so the caller
   * (`launchRun`, Phase 2) calls {@link markMountsConsumed} with these AFTER
   * `driver.start` succeeds — a mount recorded but never started stays unconsumed
   * and surfaces as an orphan at the next boot ({@link scanOrphans}).
   */
  consumableKeys: string[]
}

export interface EnsureLinksDeps {
  projectDir: string
  configs: SkillRepoConfig[]
  /** vendor → its SkillLoader (from the available adapters). A missing key ⇒ vendor not available. */
  loaders: Partial<Record<VendorId, SkillLoader>>
  /** Ask the human to resolve a gate (true = approve). Production wires this to {@link requestSkillApproval}. */
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

/** The build-link target vendors for a config: its single vendor, or every available `full` vendor for `'all'`. */
async function targetVendors(
  config: SkillRepoConfig,
  loaders: Partial<Record<VendorId, SkillLoader>>,
): Promise<{ supported: VendorId[]; greyed: VendorId[] }> {
  const requested: VendorId[] =
    config.vendor === 'all'
      ? (Object.keys(loaders) as VendorId[])
      : [(config.vendor ?? 'claude') as VendorId]
  const supported: VendorId[] = []
  const greyed: VendorId[] = []
  for (const v of requested) {
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
 * See the module contract. Throws {@link SkillLoadCancelled} only on an
 * `unreviewed` cancel; every other failure degrades to a `skipped` entry.
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
  const consumableKeys: string[] = []

  for (const config of configs) {
    const { supported, greyed } = await targetVendors(config, loaders)
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

      // Cache hit: recorded, symlink present, ref unchanged ⇒ fully skip (no clone,
      // no relink). It IS used this launch, so it joins the consumable set.
      if (existing && existing.ref === resolvedRef && existsSync(existing.linkPath)) {
        consumableKeys.push(key)
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

      // Trust gate.
      const trust = evaluateTrustGate(projectDir, config, vendor, resolvedRef)
      if (trust.needsApproval) {
        const ok = await requestApproval({
          kind: 'trust',
          id: config.id,
          vendor,
          repo: config.repo,
          ref: config.ref,
          detail:
            trust.reason === 'ref-change'
              ? `外部 skill 内容自上次确认后变动 (ref→${resolvedRef.slice(0, 12)}),请复核: ${config.id}`
              : `首次加载外部 skill,请确认信任: ${config.id} (${config.repo})`,
        })
        if (!ok) {
          if (config.trust === 'unreviewed') throw new SkillLoadCancelled(config.id, vendor)
          skipped.push({ id: config.id, vendor, reason: 'review-cancelled' })
          continue
        }
        recordTrustAck(projectDir, config, vendor, resolvedRef)
      }

      // Bring the repo to disk (clone/pull + pinned cat-file verify).
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
        trust: config.trust,
        createdAt: now(),
        consumedAt: now(),
      }
      setSkillLink(key, record)
      consumableKeys.push(key)
      mounted.push({ id: config.id, vendor, linkPath, target: repo.skillDir })
    }
  }

  return { mounted, skipped, greyed: [...greyedSet], consumableKeys }
}

/**
 * Mark mounts as consumed AFTER a successful `driver.start` (spec §6: consumed =
 * a run actually used the link). This prevents a mount that was *recorded* but
 * whose launch was subsequently aborted from being silently "known-good" at the
 * next boot — unconsumed mounts surface as orphans via {@link scanOrphans}.
 */
export function markMountsConsumed(keys: string[], now: () => number = Date.now): void {
  for (const key of keys) markSkillLinkConsumed(key, now())
}

/** One orphan link found at boot (an `unreviewed`, never-consumed mount). */
export interface SkillOrphan {
  key: string
  id: string
  vendor: VendorId
  linkPath: string
}

/**
 * Scan recorded mounts at c3 boot for `unreviewed` links that were never consumed
 * by a launch (left from a prior session) and emit a one-time ack reminder for each
 * via `emit`. Informational only — never blocks. Returns the orphans found.
 */
export function scanOrphans(emit?: (orphan: SkillOrphan) => void): SkillOrphan[] {
  const orphans: SkillOrphan[] = []
  for (const rec of listSkillLinks()) {
    if (rec.trust === 'unreviewed' && rec.consumedAt === undefined) {
      const orphan: SkillOrphan = {
        key: skillLinkKey(rec.projectDir, rec.vendor, rec.id),
        id: rec.id,
        vendor: rec.vendor,
        linkPath: rec.linkPath,
      }
      orphans.push(orphan)
      emit?.(orphan)
    }
  }
  return orphans
}
