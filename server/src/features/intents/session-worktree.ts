/**
 * The ONE directory an intent's sessions run in.
 *
 * Development was never the first session to read the code: the comm session
 * refines the intent against it, the spec session grounds the document in it,
 * and the reviewer checks the document's claims against it. Running those three
 * in the main checkout meant they read whatever branch the user happened to have
 * checked out, plus whatever was uncommitted in it — for an intent bound to a
 * delivery, that is not even the branch the change will land on.
 *
 * So all four session kinds bind the same deterministic path,
 * `getWorktreePath(workspace, intentId)`, rooted at the intent's persisted
 * `baseBranch`. One intent, one directory: a spec session that arrives first
 * creates it, the work session that follows reuses it, and resume finds it
 * unchanged.
 *
 * Sharing a directory is NOT sharing write rights. The comm session and the
 * reviewer stay read-only, and the spec author still writes only into the
 * centralized spec root — the permission gateway decides that, not the cwd.
 * Reading code and writing the document are two separate roots on purpose.
 */
import type { GitActionFailureGuidance, Intent } from '@ccc/shared/protocol'
import type { UiErrorCode } from '@ccc/shared'
import { getGitBranchMode } from '../../kernel/config/index.js'
import { getDelivery } from '../deliveries/store.js'
import { impliedDeliveryContextId } from './delivery-context.js'
import { buildGitFailureGuidance } from './git-failure.js'
import {
  checkExistingWorktreeBaseline,
  resolveWorktreeBaseline,
  type WorktreeBaseline,
} from './worktree-baseline.js'
import { createWorktree, getWorktreePath, worktreeExists } from './worktree.js'

/** Why a session may not start in this intent's directory. */
export interface IntentWorktreeFailure {
  code: UiErrorCode
  params?: Record<string, string>
  /**
   * Targeted repair guidance, set only where a Git command actually failed.
   * A baseline mismatch is not a Git failure and carries none — its exits are
   * the `repair_intent_worktree` actions the code already names.
   */
  guidance?: GitActionFailureGuidance
}

/** The directory one launch resolved, plus what it was rooted at. */
export interface IntentSessionWorktree {
  /** Where the runtime and the agent process must run. */
  cwd: string
  /** The intent worktree; `null` in `current-branch` mode (there is none). */
  worktreePath: string | null
  /** The branch the worktree carries; `null` in `current-branch` mode. */
  branchName: string | null
  /** What the directory is rooted at; `null` in `current-branch` mode. */
  baseline: WorktreeBaseline | null
}

export type IntentWorktreeResult =
  { ok: true; prepared: IntentSessionWorktree } | { ok: false; failure: IntentWorktreeFailure }

/**
 * Resolve (and fetch) the baseline from the intent's persisted base branch, then
 * check an EXISTING worktree against it. Returns the baseline when the launch may
 * proceed, or the refusal to hand back.
 *
 * The delivery is read for the LABELS the refusal carries, never to pick the
 * branch — the branch is `intent.baseBranch`. Callers that cannot ask the user
 * which delivery they mean pass none and get the implied one (or nothing).
 *
 * The refusal states whether a safe rebuild is currently possible, so the page
 * offers the right exits: a dirty worktree only gets "commit or stash first",
 * never a destructive button. This block is NOT force-releasable — the dependency
 * gate is advice, an out-of-date worktree is a data-safety fact.
 */
export function prepareIntentWorktreeBaseline(
  workspacePath: string,
  intent: Intent,
  deliveryId: string | null,
): { ok: true; baseline: WorktreeBaseline } | { ok: false; failure: IntentWorktreeFailure } {
  const baseline = resolveWorktreeBaseline(
    workspacePath,
    intent,
    deliveryId ? getDelivery(deliveryId) : null,
  )
  const block = checkExistingWorktreeBaseline(workspacePath, intent.id, baseline)
  if (!block) return { ok: true, baseline }
  return {
    ok: false,
    failure: {
      code: block.canRebuild ? 'intent.worktreeBaseMismatch' : 'intent.worktreeBaseMismatchDirty',
      params: {
        branch: block.branch,
        deliveryTitle: block.delivery?.title ?? '',
      },
    },
  }
}

/** How a caller steers {@link prepareIntentSessionWorktree}. */
export interface IntentSessionWorktreeOptions {
  /**
   * The delivery whose title labels a refusal. Omitted by the comm / spec /
   * review launches, which have no user to ask when an intent is linked to
   * several — they fall back to the implied one, which is `null` then. The
   * baseline branch never depends on this.
   */
  deliveryId?: string | null
  /**
   * Which retry action a Git failure offers. Defaults to `start-development`,
   * the only intent action that can re-attempt worktree creation.
   */
  retryAction?: 'start-development' | 'create-pr'
}

/**
 * Prepare the directory an intent session runs in: resolve and fetch the
 * baseline, refuse when an existing worktree is rooted elsewhere, then create or
 * reuse the worktree. Idempotent — the second session of an intent runs no git
 * command and gets the same path.
 *
 * In `current-branch` mode there is no intent worktree by design: every session
 * runs in the shared checkout, exactly as before.
 *
 * Writing `branch_name` onto the intent is deliberately NOT done here. That
 * column is a development fact (the PR's head branch, the "still on main"
 * warning), and a spec session that merely happened to create the directory
 * first must not make an intent look like development started. The work launch
 * writes it; the branch name is deterministic, so it is the same either way.
 */
export function prepareIntentSessionWorktree(
  workspacePath: string,
  intent: Intent,
  opts?: IntentSessionWorktreeOptions,
): IntentWorktreeResult {
  if (getGitBranchMode(workspacePath) !== 'worktree') {
    return {
      ok: true,
      prepared: { cwd: workspacePath, worktreePath: null, branchName: null, baseline: null },
    }
  }
  const deliveryId =
    opts?.deliveryId !== undefined ? opts.deliveryId : impliedDeliveryContextId(intent)
  const resolved = prepareIntentWorktreeBaseline(workspacePath, intent, deliveryId)
  if (!resolved.ok) return { ok: false, failure: resolved.failure }

  try {
    const wt = createWorktree(workspacePath, intent.id, intent.title, resolved.baseline.baseBranch)
    return {
      ok: true,
      prepared: {
        cwd: wt.worktreePath,
        worktreePath: wt.worktreePath,
        branchName: wt.branchName,
        baseline: resolved.baseline,
      },
    }
  } catch (err) {
    // Classified from the message the failed Git command already produced — no
    // extra Git call, and the raw text still travels as `message`.
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      failure: {
        code: 'intent.worktreeCreateFailed',
        params: { message },
        guidance: buildGitFailureGuidance(
          { stage: 'worktree', text: message },
          intent.id,
          opts?.retryAction ?? 'start-development',
        ),
      },
    }
  }
}

/**
 * The cwd to give a runtime being RESTORED for viewing — the intent's worktree
 * when it is already there, else the workspace.
 *
 * Deliberately creates nothing, fetches nothing and blocks nothing: reopening a
 * finished session to read its transcript is not a launch. The admission a new
 * turn needs runs in {@link prepareIntentSessionWorktree}, at the launch entries.
 */
export function existingIntentSessionCwd(workspacePath: string, intentId: string): string {
  if (getGitBranchMode(workspacePath) !== 'worktree') return workspacePath
  const worktreePath = getWorktreePath(workspacePath, intentId)
  return worktreeExists(worktreePath) ? worktreePath : workspacePath
}
