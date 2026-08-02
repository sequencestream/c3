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
 * The relay CODEX_HOME — one global directory for every relay (custom-mode)
 * codex run, sandboxed or not.
 *
 * Codex thread `resume` needs the rollout file its `startThread` wrote (under
 * `CODEX_HOME/sessions/`) to survive across runs — but the sandbox's per-run
 * temp dir is deleted on cleanup, so a rollout written into it is gone before the
 * next turn resumes. This anchors CODEX_HOME at a fixed path that outlives any
 * single run, so each thread's rollout (named by thread id) persists for the
 * follow-up resume.
 *
 * It is global rather than per-workspace: one directory keeps relay state
 * administrable — inspected, backed up or deleted in one place — and the store is
 * addressed by thread id + cwd, so sharing it across workspaces changes nothing
 * about which rollout a resume finds.
 *
 * It is NOT the host `~/.codex`: kept isolated under c3 home to preserve
 * deny-by-default (never exposes host credentials to the sandbox).
 *
 * This home is for CUSTOM (relay) codex only. A subscription (`system`-mode)
 * codex authenticates in DIRECT mode from `$CODEX_HOME/auth.json`, which this dir
 * lacks — so the codex sandbox auth profile points its CODEX_HOME at the HOST
 * `~/.codex` instead, and those sessions freeze their store scope to `host`,
 * never reaching here.
 */
export function relayCodexHome(): string {
  return join(c3HomeDir(), 'relay', 'codex')
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
 * logged in". The claude sandbox auth profile therefore leaves the env unset for
 * the keychain path and lets claude resolve this same dir from HOME.
 */
export function getSandboxClaudeConfigDir(_workspacePath: string): string {
  return hostClaudeConfigDir()
}

/**
 * The Cursor data root (`~/.cursor`) — the whole of it, not a transcript subdir.
 *
 * Cursor exposes no environment override for its data root: the CLI always reads
 * `$HOME/.cursor`, so relocating the store means relocating `HOME`. Everything
 * the CLI needs to continue a chat lives under this one directory (chats,
 * project registry, CLI config, approved MCP servers), which is why the sandbox
 * persists the entire root rather than cherry-picking a transcript path.
 *
 * Login credentials are NOT here — they live in the OS keychain — so persisting
 * this root is necessary but not sufficient for a sandboxed run to authenticate.
 */
export function hostCursorHome(): string {
  return join(os.homedir(), '.cursor')
}

/**
 * Vendor-neutral resolution of the transcript store directory for a session,
 * given its frozen {@link StoreScope} (ADR-0015). This is the single seam the
 * read/resume path consults so it never hard-codes a host path:
 *
 * - codex → `host` = {@link hostCodexHome}; `sandbox` = {@link relayCodexHome}.
 * - claude → both scopes resolve to {@link hostClaudeConfigDir} (the sandbox run
 *   writes there too), so claude transcripts are always host-readable.
 * - cursor → {@link hostCursorHome} for both scopes: a sandboxed run persists the
 *   same data root so the next turn's `--resume` finds the chat where it was left.
 *
 * The returned path is the vendor's config-dir root (codex `CODEX_HOME`, claude
 * `CLAUDE_CONFIG_DIR`, cursor `~/.cursor`); the vendor's own subdir layout
 * (`sessions/…`, `projects/…`, `chats/…`) is appended by the caller.
 *
 * The switch is exhaustive on purpose: a new vendor must state where its store
 * lives rather than inheriting Claude's by falling off the end.
 */
export function resolveVendorStoreDir(
  vendor: VendorId,
  workspacePath: string,
  scope: StoreScope,
): string {
  switch (vendor) {
    case 'codex':
      return scope === 'sandbox' ? relayCodexHome() : hostCodexHome()
    case 'claude':
      return getSandboxClaudeConfigDir(workspacePath)
    case 'cursor':
      return hostCursorHome()
  }
}
