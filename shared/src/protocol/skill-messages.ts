/**
 * External skill wire messages.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`, which is their only definition site. These arm
 * types are internal to the partition and are NOT part of the public
 * `@ccc/shared/protocol` surface.
 */

import type { SkillApprovalKind, SkillLinkStatus } from './skill.js'
import type { VendorId } from './vendor.js'

/**
 * Resolve a pending pre-launch skill-load gate (mount layer 2/3). `approve`
 * lets the mount proceed and persists the `.gitignore` ack; `cancel` skips
 * appending the `.gitignore` line (the skill is then not mounted, but the
 * session still launches). Correlated to a {@link SkillLoadApprovalRequest} by
 * `requestId`.
 */
export type ClientSkillLoadApprovalResolve = {
  type: 'skill_load_approval_resolve'
  requestId: string
  decision: 'approve' | 'cancel'
}

/**
 * Query the install-link status of every configured skill repo in a project
 * (2026-06-12). Server replies with {@link skill_link_status}: per `id`, whether
 * `_c3_<id>` is a live symlink under each of the two shared public skill dirs
 * (`.claude/skills`, `.agents/skills`). Read-only, zero network.
 */
export type ClientGetSkillLinkStatus = { type: 'get_skill_link_status'; workspaceId: string }

/**
 * Explicitly install (or update) one configured skill repo (2026-06-12): clone/
 * pull the configured ref's latest head, then force-relink `_c3_<id>` into the
 * two shared public skill dirs (old link/dir removed first). Keeps the one-time
 * `.gitignore` ack. Server replies with {@link skill_install_result}. This
 * replaces the removed launch-time auto-mount — installs happen on user action.
 */
export type ClientInstallSkill = { type: 'install_skill'; workspaceId: string; skillId: string }

/**
 * A pre-launch skill-load gate awaiting a human decision (mount layer 2/3; the
 * modal is rendered by 3/3). The backend emits one before the first external-skill
 * mount in a project, when the one-time `.gitignore` write needs an ack, then
 * blocks that mount on the matching {@link SkillLoadApprovalRequest}
 * `skill_load_approval_resolve`. `detail` is a human-readable summary of what is
 * about to happen (the `.gitignore` line to append).
 */
export type ServerSkillLoadApprovalRequest = {
  type: 'skill_load_approval_request'
  requestId: string
  kind: SkillApprovalKind
  /** The {@link SkillRepoConfig.id} being mounted. */
  id: string
  /** The vendor whose discovery dir is the mount target. */
  vendor: VendorId
  repo: string
  ref: string
  detail: string
}

/**
 * Reply to {@link get_skill_link_status} (2026-06-12): one {@link SkillLinkStatus}
 * per configured skill repo, reporting `_c3_<id>` symlink presence in each of the
 * two shared public skill dirs.
 */
export type ServerSkillLinkStatus = {
  type: 'skill_link_status'
  workspaceId: string
  statuses: SkillLinkStatus[]
}

/**
 * Reply to {@link install_skill} (2026-06-12). `ok` ⇒ the skill is cloned/pulled
 * to its ref's latest head and (re)linked into both public dirs. On failure,
 * `reason` is a machine token (UI maps it to copy; mirrors `SkippedSkill.reason`)
 * and `detail` carries English debug text (not UI copy).
 */
export type ServerSkillInstallResult = {
  type: 'skill_install_result'
  workspaceId: string
  skillId: string
  ok: boolean
  reason?: 'not-configured' | 'repo-error' | 'gitignore-cancelled'
  detail?: string
}
