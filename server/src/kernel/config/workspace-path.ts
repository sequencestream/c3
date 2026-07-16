/**
 * Deterministic paths derived from an owning workspace identity.
 */
import { join } from 'node:path'
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
 */
export function getSandboxCodexHome(workspacePath: string): string {
  return join(c3HomeDir(), 'sandbox-home', projectDirName(workspacePath), '.codex')
}
