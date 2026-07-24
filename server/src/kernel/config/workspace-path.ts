/**
 * Deterministic paths derived from an owning workspace identity.
 */
import { join, resolve } from 'node:path'
import os from 'node:os'
import type { StoreScope, VendorId } from '@ccc/shared/protocol'
import { c3HomeDir } from './index.js'

/**
 * Convert an absolute project path to a safe filesystem segment under c3 home.
 */
export function projectDirName(workspacePath: string): string {
  return workspacePath.replace(/^\/+/, '').replace(/[/:]/g, '-')
}

/**
 * The fixed centralized SDD spec root for an owning workspace.
 */
export function getSpecsBase(workspacePath: string): string {
  return join(c3HomeDir(), 'specs', projectDirName(workspacePath))
}

/**
 * The persistent per-workspace sandbox CODEX_HOME.
 *
 * Codex thread `resume` needs the rollout file its `startThread` wrote (under
 * `CODEX_HOME/sessions/`) to survive across runs — but the sandbox's per-run
 * temp dir is deleted on cleanup, so a rollout written into it is gone before the
 * next turn resumes. This anchors CODEX_HOME at a fixed, workspace-scoped path
 * that outlives any single run, so all sessions in a workspace share one home and
 * each thread's rollout (named by thread id) persists for the follow-up resume.
 *
 * It is NOT the host `~/.codex`: kept isolated under c3 home to preserve
 * deny-by-default (never exposes host credentials to the sandbox). A daily
 * janitor prunes rollouts older than the workspace's retention window.
 *
 * This isolated home is for CUSTOM (relay) codex only. A subscription
 * (`system`-mode) codex authenticates in DIRECT mode from `$CODEX_HOME/auth.json`,
 * which this dir lacks — so the sandbox wrapper points its CODEX_HOME at the HOST
 * `~/.codex` instead (see `codexSystemMode` in createSandboxWrapper), and those
 * sessions freeze their store scope to `host`, never reaching here.
 */
export function getSandboxCodexHome(workspacePath: string): string {
  return join(c3HomeDir(), 'sandbox-home', projectDirName(workspacePath), '.codex')
}

/**
 * The host codex home (`CODEX_HOME` or `~/.codex`) — where a non-sandbox codex
 * run writes its rollouts and where the host-side transcript reader looks by
 * default. Mirrors the codex CLI's own resolution so read and write agree.
 */
export function hostCodexHome(): string {
  return process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(os.homedir(), '.codex')
}

/**
 * The host claude config dir (`CLAUDE_CONFIG_DIR` or `~/.claude`). Identical to
 * the resolution in `state.ts` and, crucially, to the claude SDK's own
 * (`getSessionMessages` keys its projects root off the SAME env), so the server
 * always reads claude transcripts from here regardless of workspace.
 */
export function hostClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR)
    : join(os.homedir(), '.claude')
}

/**
 * The claude config dir a SANDBOX run uses.
 *
 * Unlike codex (whose sandbox home is an isolated per-workspace dir, read back
 * by c3 directly from disk), claude's transcript is read host-side through the
 * claude SDK, which locates the projects root from the SERVER process's
 * `CLAUDE_CONFIG_DIR` — a value the multi-workspace server cannot repoint per
 * call. A per-workspace isolated claude dir would therefore be unreadable from
 * the host. The sandbox instead reuses the HOST claude config dir so transcripts
 * land exactly where the server reads them.
 *
 * This is only where transcripts LAND — it does not follow that the wrapper should
 * pin `CLAUDE_CONFIG_DIR` to it. On macOS a subscription login lives in the
 * Keychain, which Claude Code consults ONLY in its default profile; setting
 * `CLAUDE_CONFIG_DIR` flips it to a non-existent file store and it reports "Not
 * logged in". The wrapper (`createSandboxWrapper`) therefore leaves the env unset
 * for the keychain path and lets claude resolve this same dir from HOME — see
 * `claudeKeychainMode` there.
 */
export function getSandboxClaudeConfigDir(_workspacePath: string): string {
  return hostClaudeConfigDir()
}

/**
 * Vendor-neutral resolution of the transcript store directory for a session,
 * given its frozen {@link StoreScope} (ADR-0015). This is the single seam the
 * read/resume path consults so it never hard-codes a host path:
 *
 * - codex → `host` = {@link hostCodexHome}; `sandbox` = {@link getSandboxCodexHome}.
 * - claude → both scopes resolve to {@link hostClaudeConfigDir} (the sandbox run
 *   writes there too), so claude transcripts are always host-readable.
 *
 * The returned path is the vendor's config-dir root (codex `CODEX_HOME`, claude
 * `CLAUDE_CONFIG_DIR`); the vendor's own subdir layout (`sessions/…`,
 * `projects/…`) is appended by the caller.
 */
export function resolveVendorStoreDir(
  vendor: VendorId,
  workspacePath: string,
  scope: StoreScope,
): string {
  if (vendor === 'codex') {
    return scope === 'sandbox' ? getSandboxCodexHome(workspacePath) : hostCodexHome()
  }
  return getSandboxClaudeConfigDir(workspacePath)
}
