/**
 * External skill git mount contracts.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 */

import type { CapabilityState } from './vendor.js'

// ---- External skill git mount (ADR-0016) ----

/**
 * One external git repository configured as a skill source (ADR-0016). c3 clones
 * it into a shared `~/.c3/repo/` cache and (mount layer, 2/3) soft-links its
 * skills into EVERY build-link-capable vendor's discovery directory under a flat
 * `_c3_<id>/SKILL.md` layout (spike A: nested dirs are not discovered). The mount
 * is silent — the configured `ref`'s current head is resolved and linked with no
 * trust/vendor knobs and no pre-mount approval (only the one-time `.gitignore`
 * append still asks). Vendors whose skill discovery is not `full` are skipped.
 */
export interface SkillRepoConfig {
  /** Stable, user-meaningful id; globally unique across `skillRepos`. Also the mount dir suffix (`_c3_<id>`). */
  id: string
  /** Git repo address, e.g. `https://github.com/owner/repo` (or an SSH/ssh-config remote). */
  repo: string
  /**
   * Required git ref (branch / tag / commit) to check out. Missing is a hard
   * config error — c3 never silently falls back to the remote's default branch.
   */
  ref: string
  /** Optional sub-directory within the repo that holds the skill(s). Repo root when absent. */
  subpath?: string
}

/**
 * The install-link presence of one configured skill in the two shared public
 * skill dirs (`get_skill_link_status` reply, 2026-06-12). External skills are no
 * longer mounted at launch; the settings panel queries this and triggers an
 * explicit `install_skill`. Both flags report whether `_c3_<id>` is a live
 * symlink under that dir — the dirs are shared across vendors, so we check the
 * directories directly rather than enumerating vendors.
 */
export interface SkillLinkStatus {
  /** The {@link SkillRepoConfig.id} this status is for. */
  id: string
  /** `_c3_<id>` exists as a symlink under `<project>/.claude/skills/`. */
  claudeSkills: boolean
  /** `_c3_<id>` exists as a symlink under `<project>/.agents/skills/`. */
  agentsSkills: boolean
}

/**
 * How a target vendor's SKILL-discovery support is reported to the console
 * (mount layer 2/3). Reuses {@link CapabilityState} (single SoT): `full` ⇒ c3's
 * soft-linked `_c3_<id>` skills are discovered and the vendor builds links;
 * `none` ⇒ the vendor's SDK/CLI does not (or cannot be confirmed to) discover
 * them, so c3 builds NO link and the console greys the vendor (the session still
 * launches). `temporarily-unavailable` is the host-down overlay. Persisted in
 * `state.json` and invalidated on an SDK-version change (re-probed).
 */
export type SkillSupportState = CapabilityState

/**
 * Which kind of pre-launch skill-load gate the backend is asking the human to
 * resolve (mount layer 2/3; the modal UI is rendered by 3/3). External skills now
 * mount silently (the configured `ref`'s head is resolved and linked with no trust
 * check), so the only remaining gate is:
 * - `gitignore` — the one-time confirm to append a `_c3_` + wildcard line to the
 *   project's `.gitignore` before the first mount; acked once, then silent.
 */
export type SkillApprovalKind = 'gitignore'
