/**
 * Classify a FAILED Git / forge action into one stable {@link GitActionFailureReason}.
 *
 * The input is only what the failing action already produced: which stage failed,
 * the combined stderr/stdout (or thrown message), and — for the forge CLI — the
 * "CLI unavailable" flag its own runner already sets. Nothing here runs a Git or
 * forge command, reads the repository, or touches the filesystem: a classifier
 * that probed would turn a display concern into a second side effect.
 *
 * Matching is marker-based and ordered per stage: the FIRST rule whose markers
 * appear wins, so a specific category always beats a general one. Markers are
 * concrete strings/patterns a tool actually prints — never a vague word — and a
 * text that matches nothing stays `unknown` rather than being pushed into the
 * nearest-looking category.
 */
import type {
  GitActionFailureGuidance,
  GitActionFailureReason,
  IntentRetryAction,
} from '@ccc/shared/protocol'

/**
 * Which action produced the failure. The stage is part of the evidence: the very
 * same phrase means different things in different places (a "permission denied"
 * from `git worktree add` is a local filesystem refusal; from `git push` it is
 * the remote refusing).
 */
export type GitFailureStage = 'worktree' | 'commit-push' | 'forge-create'

/** The facts a classification is allowed to read. */
export interface GitFailureFacts {
  stage: GitFailureStage
  /** Combined stderr/stdout of the failing command, or the thrown message. */
  text: string
  /**
   * The forge CLI reported itself unusable — not installed (spawn ENOENT) or not
   * logged in. Set by the CLI runner itself, so it is evidence, not a guess.
   */
  cliUnavailable?: boolean
}

/** One ordered rule: if any marker appears in the lowercased text, this reason wins. */
interface Rule {
  reason: GitActionFailureReason
  markers: readonly (string | RegExp)[]
}

// The repository has unresolved merge conflicts. Every marker is a phrase git
// itself prints while a merge/rebase is in progress.
const CONFLICT_MARKERS = [
  'you have unmerged paths',
  'unmerged files',
  'fix conflicts and run',
  'needs merge',
  'you must edit all merge conflicts',
  'because you have unmerged files',
  'automatic merge failed',
] as const

// The local filesystem refused the write: no permission, read-only, or full.
const FILESYSTEM_MARKERS = [
  'permission denied',
  'operation not permitted',
  'no space left on device',
  'disk quota exceeded',
  'read-only file system',
  'eacces',
  'eperm',
  'enospc',
  'erofs',
  // Thrown by worktree.ts when the parent directory chain cannot be created —
  // our own stable marker for the same class of failure.
  '无法创建工作区临时目录',
] as const

// DNS / connection / timeout while reaching the remote or the forge API.
const NETWORK_MARKERS = [
  'could not resolve host',
  'could not resolve proxy',
  'temporary failure in name resolution',
  'connection timed out',
  'connection refused',
  'connection reset by peer',
  'network is unreachable',
  'no route to host',
  'operation timed out',
  'failed to connect to',
  'ssl connect error',
  'dial tcp',
] as const

// The remote refused for lack of rights. `repository not found` is deliberately
// ABSENT: GitHub returns it both for a private repo one cannot read and for a
// genuinely wrong remote, so it is not sufficient evidence of a permission
// problem and stays `unknown`.
const REMOTE_PERMISSION_MARKERS = [
  /permission to .+ denied/,
  'permission denied (publickey)',
  'write access to repository not granted',
  'you do not have permission',
  'authentication failed',
  'invalid username or password',
  '403 forbidden',
  'http 403',
  'error: 403',
] as const

// A push the remote refused because its branch has moved ahead.
const PUSH_REJECTED_MARKERS = [
  '! [rejected]',
  'updates were rejected',
  'non-fast-forward',
  'fetch first',
  'behind its remote counterpart',
  'stale info',
  'cannot lock ref',
] as const

// A commit / push hook (or the lint-format chain it drives) rejected the change.
const HOOK_MARKERS = [
  'pre-commit hook',
  'prepare-commit-msg hook',
  'commit-msg hook',
  'pre-push hook',
  'pre-receive hook declined',
  'hook declined',
  'husky',
  'lint-staged',
] as const

// The forge CLI is missing or unauthenticated.
const FORGE_CLI_MARKERS = [
  'cli 未安装',
  'gh auth login',
  'glab auth login',
  'not logged in',
  'not logged into',
  'not authenticated',
  'authentication required',
  'no token provided',
] as const

// The forge itself refused to create the change request.
const FORGE_REJECTED_MARKERS = [
  'already exists',
  'validation failed',
  'http 422',
  'unprocessable entity',
  'no commits between',
  'must be a collaborator',
] as const

/**
 * `git worktree add` failed. Occupation first (its markers are unambiguous),
 * then an in-progress conflict, then the filesystem — at this stage a
 * "permission denied" is always local, so it maps to the filesystem category.
 */
const WORKTREE_RULES: readonly Rule[] = [
  {
    reason: 'worktree_branch_or_path_taken',
    markers: [
      'already exists',
      'is already used by worktree',
      'already used by worktree',
      'is already checked out',
      'already registered',
    ],
  },
  { reason: 'repo_conflict_unresolved', markers: CONFLICT_MARKERS },
  { reason: 'filesystem_denied', markers: FILESYSTEM_MARKERS },
]

/**
 * The commit → push chain of a PR creation failed. A hook rejection is checked
 * before the transport categories because a rejected push whose reason is a
 * declined hook is a hook problem, not a permission or fast-forward one.
 */
const COMMIT_PUSH_RULES: readonly Rule[] = [
  { reason: 'repo_conflict_unresolved', markers: CONFLICT_MARKERS },
  { reason: 'commit_hook_rejected', markers: HOOK_MARKERS },
  { reason: 'network_unreachable', markers: NETWORK_MARKERS },
  { reason: 'remote_permission_denied', markers: REMOTE_PERMISSION_MARKERS },
  { reason: 'push_rejected', markers: PUSH_REJECTED_MARKERS },
]

/**
 * The forge CLI's create call failed. CLI availability first (a missing or
 * logged-out CLI explains everything else it printed), then transport, then the
 * two ways the forge can refuse: no rights versus its own validation.
 */
const FORGE_CREATE_RULES: readonly Rule[] = [
  { reason: 'forge_cli_unavailable', markers: FORGE_CLI_MARKERS },
  { reason: 'network_unreachable', markers: NETWORK_MARKERS },
  { reason: 'remote_permission_denied', markers: REMOTE_PERMISSION_MARKERS },
  { reason: 'forge_create_rejected', markers: FORGE_REJECTED_MARKERS },
]

const RULES_BY_STAGE: Record<GitFailureStage, readonly Rule[]> = {
  worktree: WORKTREE_RULES,
  'commit-push': COMMIT_PUSH_RULES,
  'forge-create': FORGE_CREATE_RULES,
}

function matches(hay: string, marker: string | RegExp): boolean {
  return typeof marker === 'string' ? hay.includes(marker) : marker.test(hay)
}

/**
 * The stable reason for one failed Git / forge action, or `unknown` when the
 * evidence does not clearly name a category. Pure: same facts in, same reason
 * out, with no I/O of any kind.
 */
export function classifyGitFailure(facts: GitFailureFacts): GitActionFailureReason {
  // The runner's own "CLI unusable" verdict outranks text matching — it is a
  // spawn/auth fact, not an inference from wording.
  if (facts.cliUnavailable) return 'forge_cli_unavailable'
  const hay = facts.text.toLowerCase()
  if (!hay.trim()) return 'unknown'
  for (const rule of RULES_BY_STAGE[facts.stage]) {
    if (rule.markers.some((marker) => matches(hay, marker))) return rule.reason
  }
  return 'unknown'
}

/**
 * The full guidance for one failed action: the classified reason, the raw error
 * text kept verbatim (known and unknown reasons alike), and the retry that
 * re-enters the SAME intent entry point the user already used. Display only —
 * building it never changes what the failed action did or did not do.
 */
export function buildGitFailureGuidance(
  facts: GitFailureFacts,
  intentId: string,
  action: IntentRetryAction,
): GitActionFailureGuidance {
  return {
    reason: classifyGitFailure(facts),
    detail: facts.text,
    retry: { type: 'intent-action', intentId, action },
  }
}
