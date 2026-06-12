/**
 * External skill install + link-status (ADR-0016/0017, 2026-06-12 lifecycle change).
 *
 * External skills are NO LONGER mounted at session launch. Instead the settings
 * panel drives two explicit operations against the two **shared public skill dirs**
 * (`.claude/skills`, `.agents/skills`) — both consumed by multiple vendors, so we
 * target the dirs directly rather than enumerating vendors:
 *
 *  - {@link getSkillLinkStatuses} — read-only: per configured `id`, is `_c3_<id>`
 *    a live symlink under each public dir? Zero network. Backs the status query and
 *    (via {@link hasAnyInstalledSkill}) the launch-time supply-chain write guard.
 *  - {@link installSkill} — clone/pull the configured `ref`'s latest head, then
 *    OVERWRITE-relink `_c3_<id>` into both public dirs (old link/dir removed first).
 *    Keeps the one-time `.gitignore` append ack. Always pulls latest — there is no
 *    cache-hit / ref-staleness logic (updates are user-triggered, never silent).
 *
 * Orchestration is dependency-injected (`requestApproval`, `ensureRepo`) so it
 * unit-tests without a WS or a real git remote.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { lstat, mkdir, rm, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SkillLinkStatus, SkillRepoConfig } from '@ccc/shared/protocol'
import { ensureSkillRepo, type EnsureSkillRepoResult } from '../../skill-repo.js'
import {
  needsGitignoreAck,
  recordGitignoreAck,
  requestSkillApproval,
  type SkillApprovalAsk,
} from './approval.js'

/**
 * The two shared public skill-discovery dirs (project-relative segments). Claude
 * reads `.claude/skills`; the OpenCode-family agents read `.agents/skills`. Both
 * are vendor-shared, so external-skill install/status targets these dirs directly.
 */
export const PUBLIC_SKILL_DIRS = {
  claudeSkills: ['.claude', 'skills'],
  agentsSkills: ['.agents', 'skills'],
} as const

type PublicDirKey = keyof typeof PUBLIC_SKILL_DIRS
const PUBLIC_DIR_KEYS = Object.keys(PUBLIC_SKILL_DIRS) as PublicDirKey[]

/** The flat `_c3_<id>` link path under one public dir, for a project. */
function linkPathFor(projectDir: string, dir: readonly string[], id: string): string {
  return join(projectDir, ...dir, `_c3_${id}`)
}

// ---------------------------------------------------------------------------
// Status query (read-only)
// ---------------------------------------------------------------------------

/** Whether `linkPath` exists and is a symbolic link (a live `_c3_<id>` mount). */
async function isLiveLink(linkPath: string): Promise<boolean> {
  try {
    return (await lstat(linkPath)).isSymbolicLink()
  } catch {
    return false // ENOENT or unreadable ⇒ not linked
  }
}

/**
 * Per configured skill repo, report whether `_c3_<id>` is a live symlink under each
 * of the two public dirs. Read-only, zero network — backs `get_skill_link_status`.
 */
export async function getSkillLinkStatuses(
  projectDir: string,
  configs: SkillRepoConfig[],
): Promise<SkillLinkStatus[]> {
  return Promise.all(
    configs.map(async (config) => ({
      id: config.id,
      claudeSkills: await isLiveLink(
        linkPathFor(projectDir, PUBLIC_SKILL_DIRS.claudeSkills, config.id),
      ),
      agentsSkills: await isLiveLink(
        linkPathFor(projectDir, PUBLIC_SKILL_DIRS.agentsSkills, config.id),
      ),
    })),
  )
}

/**
 * True if ANY configured skill has a live link in EITHER public dir. Drives the
 * supply-chain write guard at launch (`skillWriteGuard`) without mounting: an
 * installed external skill ⇒ guard on; configured-but-not-installed ⇒ guard off
 * (and the skill is genuinely unavailable to the run). Replaces the old mount-time
 * `mounted.length > 0` signal (2026-06-12).
 */
export async function hasAnyInstalledSkill(
  projectDir: string,
  configs: SkillRepoConfig[],
): Promise<boolean> {
  const statuses = await getSkillLinkStatuses(projectDir, configs)
  return statuses.some((s) => s.claudeSkills || s.agentsSkills)
}

// ---------------------------------------------------------------------------
// Install action (write)
// ---------------------------------------------------------------------------

/**
 * Append `pattern` (a project-relative glob like `.claude/skills/_c3_<star>/`) to
 * the project's `.gitignore` if absent. Idempotent; creates the file if needed. The
 * first-install ack is asked separately (this just keeps the line present).
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

/** The `.gitignore` glob for a public skill dir, relative to the project root. */
function gitignorePatternFor(dir: readonly string[]): string {
  return `${dir.join('/')}/_c3_*/`
}

/**
 * Remove whatever occupies `linkPath` (an old `_c3_<id>` symlink or directory) and
 * create a fresh dir-symlink to `target`. Unlike the launch-time `ensureLink` (which
 * refused to clobber), install OVERWRITES — it is the explicit update path. Only ever
 * touches the c3 `_c3_<id>` namespace, never a user-owned skill dir.
 */
async function forceLink(target: string, linkPath: string): Promise<void> {
  await rm(linkPath, { recursive: true, force: true })
  await mkdir(dirname(linkPath), { recursive: true })
  await symlink(target, linkPath, 'dir')
}

export interface InstallSkillDeps {
  projectDir: string
  config: SkillRepoConfig
  /** Resolve the `.gitignore` ack (true = approve). Default bridges to the WS transport. */
  requestApproval?: (ask: SkillApprovalAsk) => Promise<boolean>
  /** Aborts the install (also cancels a pending ack). */
  signal?: AbortSignal
  /** Bring the repo to disk at the ref's latest head. Default {@link ensureSkillRepo}. */
  ensureRepo?: (config: SkillRepoConfig) => Promise<EnsureSkillRepoResult>
}

export interface InstallSkillResult {
  ok: boolean
  /** Machine reason on failure (mirrors the wire `skill_install_result.reason`). */
  reason?: 'repo-error' | 'gitignore-cancelled'
  /** English debug detail (exception text); not UI copy. */
  detail?: string
  /** Public-dir keys that were (re)linked on success. */
  linkedDirs?: PublicDirKey[]
}

/** Default production approval: bridge to the WS transport. */
function defaultRequestApproval(signal?: AbortSignal) {
  return (ask: SkillApprovalAsk) => requestSkillApproval(ask, signal)
}

/**
 * Install (or update) one configured skill: ack `.gitignore` once → clone/pull the
 * configured ref's latest head → force-relink `_c3_<id>` into BOTH public dirs.
 * Never throws — failures degrade to an `{ ok: false, reason }` result.
 */
export async function installSkill(deps: InstallSkillDeps): Promise<InstallSkillResult> {
  const { projectDir, config, signal, ensureRepo = ensureSkillRepo } = deps
  const requestApproval = deps.requestApproval ?? defaultRequestApproval(signal)

  // .gitignore gate (per project, one-time ack) — then always keep both patterns present.
  if (needsGitignoreAck(projectDir)) {
    const patterns = PUBLIC_DIR_KEYS.map((k) => gitignorePatternFor(PUBLIC_SKILL_DIRS[k]))
    const ok = await requestApproval({
      kind: 'gitignore',
      id: config.id,
      // `vendor` is a legacy field on the ask shape; install targets shared dirs,
      // so report the primary (claude) discovery dir for the human-readable detail.
      vendor: 'claude',
      repo: config.repo,
      ref: config.ref,
      detail: `即将向 ${projectDir}/.gitignore 追加: ${patterns.join(' , ')}`,
    })
    if (!ok) return { ok: false, reason: 'gitignore-cancelled' }
    recordGitignoreAck(projectDir)
  }
  for (const key of PUBLIC_DIR_KEYS) {
    ensureGitignorePattern(projectDir, gitignorePatternFor(PUBLIC_SKILL_DIRS[key]))
  }

  // Clone/pull the configured ref's latest head (always latest — no cache-hit).
  const repo = await ensureRepo(config)
  if (!repo.ok || !repo.skillDir) {
    return { ok: false, reason: 'repo-error', detail: repo.error }
  }

  // Overwrite-relink `_c3_<id>` into both public dirs.
  const linkedDirs: PublicDirKey[] = []
  for (const key of PUBLIC_DIR_KEYS) {
    const linkPath = linkPathFor(projectDir, PUBLIC_SKILL_DIRS[key], config.id)
    await forceLink(repo.skillDir, linkPath)
    linkedDirs.push(key)
  }
  return { ok: true, linkedDirs }
}
