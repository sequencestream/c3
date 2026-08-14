/**
 * Workspace identity, per-workspace settings (sandbox, git, MCP) and workspace rollups.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 */

import type { UiError } from '../ui-codes.js'
import type { ConsensusConfig } from './consensus.js'
import type { SessionKind } from './session.js'
import type { SkillRepoConfig } from './skill.js'
import type { CodexPolicy, ModeToken, VendorId } from './vendor.js'

/** A project directory the user manages in the c3 sidebar. */
export interface WorkspaceInfo {
  /** Immutable, globally unique workspace identity (1–64 Unicode characters). */
  name: string
  /**
   * Resolved absolute path on disk. Display-only: shown under the name in the
   * WorkspaceSwitcher dropdown to make the filesystem location explicit.
   * NOT an identity field — every workspace-scoped operation uses `name`, and the
   * server never accepts `path` back as identity.
   */
  path: string
  /** Last time a session in this workspace was selected, ms since epoch. Sort key (desc). */
  lastAccessed: number
}

// ─── Sandbox Config Types ───────────────────────────────────────────────────
// Wire representation of the kernel's WorkspaceSandboxConfig. The kernel
// maintains its own copy in server/src/kernel/sandbox/types.ts (with runtime
// types like ResolvedSandboxPaths); this protocol-level interface is the
// persistence shape, kept in sync by the normalize layer.
//
// Backend: arapuca process-level isolation (kernel-enforced MAC — Linux
// Landlock / macOS Seatbelt / Windows AppContainer). No container / image /
// bind mount / rootfs. Current scope: directory ro/rw only; network fully open.

/**
 * A supplementary allowed directory for the sandbox (same-path passthrough).
 *
 * Each entry is a host absolute path exposed to the sandboxed process at the
 * SAME path (no rewrite). Read-only by default; set {@link readonly} to false
 * to grant read-write. Used to bring extra dependency dirs, shared caches, or
 * reference repos into the deny-by-default allow set. Reserved paths (execution
 * root / workspace root / specsBase) cannot be overridden here — the server drops
 * any such overlap during resolution.
 */
export interface SandboxExtraMount {
  /** Host absolute path, exposed at the same path inside the sandbox. */
  path: string
  /** Read-only when true or absent; false grants read-write. */
  readonly?: boolean
}

/**
 * A built-in (system default) allowed directory for the sandbox, derived
 * server-side from the owning workspace path. These are the WORKSPACE-scoped
 * fixed allowances (project directory ro, specs root rw) — a single source of
 * truth (`sysExtraMounts(workspace)`) consumed BOTH at sandbox launch (merged
 * into the resolved allow set) and for read-only display in the workspace
 * setting UI. Users cannot edit or remove them.
 *
 * The run's execution root (rw) is another fixed allowance but is per-run (not
 * workspace-derivable), so it is not part of this list. When it is a worktree it
 * is shown alongside the ro project directory; when it IS the workspace
 * (current-branch) resolution collapses the two into a single rw grant.
 */
export interface SysExtraMount {
  /** Stable id for display/i18n (e.g. `workspaceRoot`, `specs`). */
  key: string
  /** Host absolute path, exposed at the same path inside the sandbox. */
  path: string
  /** Read-only when true; false grants read-write. */
  readonly: boolean
}

/**
 * Workspace-level sandbox configuration (arapuca process-level isolation).
 *
 * Applicability is decided at run time from `enabled` + `sandboxSessionKinds`,
 * NOT from the git branch mode. Two properties hold (see `normalizeSandboxConfig`):
 * - **branch-independent**: the config is validated on its own content and
 *   preserved under both `gitBranchMode` values — switching modes never drops a
 *   saved config. Which directories are read-write is resolved per run from its
 *   execution root (worktree rw + workspace ro, or workspace rw for current-branch).
 * - **agent selection is NOT overridden**: the run reuses the agent its normal
 *   resolution chain produced (session binding, else the `default`/`tool`/
 *   `intent`/`spec` role entry through `resolveAgent`); the sandbox only wraps
 *   that agent's vendor CLI in arapuca. There is no sandbox-specific agent
 *   selection — a `system`-mode agent authenticates inside the sandbox through
 *   the host keychain the wrapper opens for it (`--allow-keychain`).
 */
export interface WorkspaceSandboxConfig {
  /** Master switch — sandboxing is off by default (absent or false ⇔ disabled). */
  enabled?: boolean
  /**
   * Supplementary allowed directories (same-path). Each entry is read-only by
   * default; declare `readonly: false` per item to grant read-write. Fixed
   * allowances (workspace root ro, worktree rw, specsBase rw) are implicit and
   * not listed here. Absent / empty ⇒ only the fixed allowances apply.
   */
  extraMounts?: SandboxExtraMount[]
  /**
   * Session kinds that run inside the sandbox when enabled. Absent ⇒ defaults
   * to `['work']`. A run enters the sandbox exactly when `enabled` is true and
   * its {@link SessionKind} is in this set — independent of the run's source or
   * git branch mode. Server normalize dedupes and drops values outside
   * {@link SESSION_KINDS}; an empty set after normalize falls back to `['work']`.
   */
  sandboxSessionKinds?: SessionKind[]
}

/**
 * System-wide session-store cleanup configuration.
 *
 * Governs retention of the session transcripts every vendor writes to disk, and
 * is deliberately **global and vendor-neutral**: the stores it prunes are shared
 * homes, not per-workspace ones (a vendor's host home holds every workspace's
 * sessions), so a per-workspace switch could not describe them. It is unrelated
 * to {@link WorkspaceSandboxConfig} — the sandbox merely decides *which* home a
 * run writes into, never whether old sessions are kept.
 *
 * The server keeps a kernel copy of this shape; the Zod schema and its
 * compile-time pin (`server/src/kernel/config/session-cleanup.ts`) enforce that
 * all three stay identical.
 */
export interface SessionCleanupConfig {
  /** Master switch — cleanup is off by default (absent or false ⇔ never prunes). */
  enabled?: boolean
  /**
   * Retention window in days: a session transcript whose mtime is older is
   * pruned. Absent ⇒ 30 days; server normalize floors to a whole day, clamps up
   * to a minimum of 1, and drops non-finite or non-positive values.
   */
  retentionDays?: number
}

/**
 * Git branch strategy for `start_development` in a workspace (2026-06-10).
 * - `current-branch`: the dev agent runs directly in the project checkout on its
 *   current branch — no worktree is created.
 * - `worktree`: the dev agent runs in an isolated git worktree branched from the
 *   workspace's {@link WorkspaceSetting.defaultMainBranch} (existing isolation path).
 */
export const GIT_BRANCH_MODES = ['current-branch', 'worktree'] as const
export type GitBranchMode = (typeof GIT_BRANCH_MODES)[number]

/**
 * Per-project (workspace) configuration, keyed by immutable workspace name in
 * {@link SystemSettings.projectConfigs}. Each project holds its own copy of the
 * workspace-level knobs (including sandbox and git commit strategy) — independent
 * of every other project's values. Absent or partial entries fall back to the
 * normalized defaults.
 */
export interface WorkspaceSetting {
  /**
   * Hosting forge used when creating a pull or merge request for this workspace.
   * `auto` (the normalized default) detects the forge from the repository origin;
   * an explicit provider corrects detection for installations such as self-hosted
   * GitLab.
   */
  forge?: 'auto' | 'github' | 'gitlab'
  /**
   * Per-vendor default permission mode map (2026-06-07-017).
   * Each vendor gets its own {@link ModeToken}, validated against that vendor's
   * {@link VendorModeCatalog} at save time. A vendor absent from the map falls
   * back to that vendor's `defaultToken` at launch. Migrated from the legacy
   * single `ModeToken` (pre-017) on first read.
   */
  /**
   * Per-vendor default permission mode map (2026-06-07-017).
   * For `claude`: value is a {@link ModeToken} validated against
   * that vendor's {@link VendorModeCatalog} at save time.
   * For `codex`: value is either a {@link CodexPolicy} (new dual-policy format)
   * or a {@link ModeToken} (legacy, migrated on read via `gateToCodexPolicy`).
   * A vendor absent from the map falls back to its vendor `defaultToken` at
   * launch. Migrated from the legacy single `ModeToken` (pre-017) on first read.
   */
  defaultMode?: Record<VendorId, ModeToken | CodexPolicy>
  /** Multi-agent consensus voting on permission prompts. Optional; off by default. */
  consensus?: ConsensusConfig
  /** Slash command (leading `/`) prefixed when launching dev for this project. Optional; empty ⇒ no prefix. */
  devSkill?: string
  /** Per-stage round cap for multi-agent discussions in this project. Minimum 8 (clamped up). */
  maxRoundsPerStage?: number
  /** Per-turn character guidance for participant speech in this project. Minimum 300 (clamped up). */
  maxSpeechChars?: number
  /** External git repositories configured as skill sources (ADR-0016). c3 clones
   * each into a shared `~/.c3/repo/` cache and soft-links its skills into every
   * build-link-capable vendor's discovery directory. Validated by `getSkillRepos()`
   * (fail-hard). Absent/empty ⇒ no external skills configured for this project. */
  skillRepos?: SkillRepoConfig[]
  /** Project-level sandbox configuration (arapuca process-level isolation).
   * Absent or undefined ⇒ sandboxing is not configured (equivalent to disabled). */
  sandbox?: WorkspaceSandboxConfig
  /**
   * Git branch strategy for `start_development` (2026-06-10). See
   * {@link GitBranchMode}. Absent or invalid ⇒ `worktree` (normalized on read).
   * The legacy on-disk key is still
   * read as a fallback — see `normalizeWorkspaceSetting`.
   */
  gitBranchMode?: GitBranchMode
  /**
   * Base / merge-target branch used when {@link gitBranchMode} is `worktree` —
   * new worktrees branch from it. Optional; absent ⇒ branch from current HEAD.
   * The settings form auto-detects it (origin/HEAD → current HEAD) on open.
   */
  defaultMainBranch?: string
  /**
   * Master switch for spec-driven development (SDD) in this workspace. When off,
   * the SDD spec quality gate and approval checkpoints are inactive. Absent or
   * non-boolean ⇒ `true` (normalized on read).
   */
  sddEnabled?: boolean
  /**
   * Explicit, persisted **opt-in** for machine spec approval (2026-07-31). When
   * `true` AND {@link sddEnabled} is on, a `pass` review conclusion lets the queue
   * approve the spec itself, writing {@link MACHINE_SPEC_APPROVER} as the approver.
   * Absent / non-boolean ⇒ `false` — only an explicit `true` opens this path, so a
   * migrated workspace never changes behaviour silently and a `pass` conclusion
   * still stops at the human approval checkpoint. Turning it back off never
   * revokes an already-approved spec and never affects human approval.
   */
  specMachineApprovalEnabled?: boolean
  /**
   * Upper bound on the number of distinct changed files a `fast`-mode intent may
   * produce in one manual turn and still be treated as a small change. Strictly
   * LESS-THAN semantics: a diff touching exactly this many files is over the
   * threshold. Positive integer, normalized on read; invalid values fall back to
   * the default `3`.
   */
  fastSpecMaxFiles?: number
  /**
   * Upper bound on the number of changed lines (additions + deletions) a
   * `fast`-mode intent may produce in one manual turn and still be treated as a
   * small change. Strictly LESS-THAN semantics: reaching this many lines is over
   * the threshold. Positive integer, normalized on read; invalid values fall
   * back to the default `50`. A binary changed file always counts as over the
   * line threshold.
   */
  fastSpecMaxLines?: number
  /**
   * Workspace-level master gate for automation *auto-dispatch*. When off, neither
   * the cron tick loop nor the event-trigger dispatcher fires any automation in
   * this workspace, regardless of each automation's own `active` / `paused`
   * status (which the gate never mutates); manual "run now" is unaffected.
   * Absent / non-boolean / legacy values ⇒ `true` (only an explicit boolean
   * `false` closes the gate, normalized on read), so existing workspaces keep
   * dispatching after upgrade.
   */
  automationEnabled?: boolean
  /**
   * Upper bound on how many intents the automation queue drives in DEVELOPMENT
   * at once (2026-08-05). It limits automatic dispatch of dev work sessions only:
   * spec authoring/review stays serial and is never counted, and manual
   * "start work" / MCP starts are not quota-gated.
   *
   * Under `gitBranchMode` `worktree` each intent owns its own directory, so the
   * queue may run up to this many intents concurrently; `current-branch` shares
   * one checkout and is therefore always serial (effective cap 1, the config is
   * ignored there). Absent / non-finite ⇒ `2`; finite values are floored and
   * clamped to a minimum of `1` (normalized on read). Lowering the cap never
   * cancels in-flight sessions — it only stops new auto-dispatch until
   * occupancy drops below the cap.
   */
  automationConcurrency?: number
}

/** Workspace-level MCP server connections and denylist configuration. */
export interface WorkspaceMcpConfig {
  /** MCP server connection definitions, keyed by server name. */
  mcpServers: Record<
    string,
    {
      command: string
      args?: string[]
      env?: Record<string, string>
    }
  >
  /** Workspace-level global denylist (subtraction-based disable). */
  denylist: string[]
}

/**
 * One workspace's WorkCenter rollup — aggregate counts across the four work
 * surfaces, scoped to an optional time range (see {@link get_timerange_stats}).
 * `running` fields reflect live runtime/execution state (time-range independent);
 * all other counts honour the request's `startTime`/`endTime`.
 */
export interface TimeRangeProjectStats {
  /** Immutable workspace name (the project key). */
  workspaceName: string
  /** Display name — the workspace directory's basename. */
  projectName: string
  /** Work sessions: `total` real projection rows in range; `running` live non-idle runtimes. */
  workSessions: { running: number; total: number }
  /** Intent counts by status, in range. */
  intents: { in_progress: number; todo: number; done: number }
  /** Discussion counts by status, in range. */
  discussions: { in_progress: number; completed: number }
  /** Automations: `total`/`active` rows in range; `running` automations with a live execution log. */
  automations: { running: number; active: number; total: number }
}

/**
 * One workspace's row in the Workcenter Dashboard snapshot — a single, live,
 * time-range-independent aggregation of a workspace's scale and current activity
 * (reply to {@link get_workspace_dashboard}). Unlike {@link TimeRangeProjectStats}
 * this deliberately has no time filter and counts **every** `SessionKind` in
 * `sessions.total` (not just work sessions).
 */
export interface WorkspaceDashboardRow {
  /** Immutable workspace name (never a path). */
  workspaceName: string
  /** Display name — the workspace directory's basename. */
  name: string
  /** Resolved absolute path on disk. Display-only, for distinguishing same-named workspaces. */
  path: string
  /**
   * `total`: all real (`bound=1`) session projections across every `SessionKind`.
   * `running`: distinct live sessions — non-idle runtimes plus automation sessions
   * with a running execution log, de-duplicated by session id (idle / completed /
   * failed / terminated never counted).
   */
  sessions: { running: number; total: number }
  /** All intent rows in the workspace (no status or time filter). */
  intents: { total: number }
  /** All discussion rows in the workspace (no status or time filter). */
  discussions: { total: number }
  /** All automation config rows in the workspace (a config count, not running tasks). */
  automations: { total: number }
  /**
   * The workspace-level automation master gate, normalized on read
   * ({@link WorkspaceSetting.automationEnabled}); absent / non-boolean / legacy ⇒ `true`.
   */
  automationEnabled: boolean
}

/**
 * Per-workspace outcome of a bulk automation-gate write
 * ({@link set_workspaces_automation_enabled}). The batch is NOT transactional:
 * each workspace settles independently, so a result carries `ok: false` + a
 * structured {@link UiError} for that one workspace without failing the rest.
 */
export interface WorkspaceAutomationGateResult {
  /** Opaque id of the workspace this outcome is for. */
  workspaceName: string
  /** Whether the gate write for this workspace succeeded. */
  ok: boolean
  /** Structured, localizable failure reason when `ok` is false. */
  error?: UiError
}
