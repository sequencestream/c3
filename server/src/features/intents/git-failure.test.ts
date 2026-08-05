/**
 * Classification of real Git / forge failure output.
 *
 * Every sample is text a tool actually prints, so the markers are pinned against
 * reality rather than against the classifier's own wording. The last block is the
 * important half: text that RESEMBLES a category but does not prove it must stay
 * `unknown` — a wrong repair instruction is worse than none.
 */
import { describe, it, expect } from 'vitest'
import { buildGitFailureGuidance, classifyGitFailure } from './git-failure.js'

describe('classifyGitFailure — worktree creation', () => {
  it('classifies a branch already used by another worktree', () => {
    expect(
      classifyGitFailure({
        stage: 'worktree',
        text: "git worktree add 失败: fatal: 'intent-abc' is already used by worktree at '/Users/dev/.c3/worktrees/proj/intent-abc'",
      }),
    ).toBe('worktree_branch_or_path_taken')
  })

  it('classifies a leftover same-named branch', () => {
    expect(
      classifyGitFailure({
        stage: 'worktree',
        text: "git worktree add 失败(已存在分支回退后仍然出错): fatal: a branch named 'intent-abc-fix-login' already exists",
      }),
    ).toBe('worktree_branch_or_path_taken')
  })

  it('classifies a leftover worktree directory', () => {
    expect(
      classifyGitFailure({
        stage: 'worktree',
        text: "git worktree add 失败: fatal: '/Users/dev/.c3/worktrees/proj/intent-abc' already exists",
      }),
    ).toBe('worktree_branch_or_path_taken')
  })

  it('classifies a repository stuck in an unresolved merge', () => {
    expect(
      classifyGitFailure({
        stage: 'worktree',
        text: 'git worktree add 失败: error: you have unmerged paths.\nhint: fix conflicts and run "git commit".',
      }),
    ).toBe('repo_conflict_unresolved')
  })

  it('classifies a filesystem permission refusal', () => {
    expect(
      classifyGitFailure({
        stage: 'worktree',
        text: "git worktree add 失败: fatal: could not create directory '/Users/dev/.c3/worktrees/proj': Permission denied",
      }),
    ).toBe('filesystem_denied')
  })

  it('classifies a full disk', () => {
    expect(
      classifyGitFailure({
        stage: 'worktree',
        text: 'git worktree add 失败: fatal: write error: No space left on device',
      }),
    ).toBe('filesystem_denied')
  })

  it("classifies c3's own parent-directory creation failure as a filesystem problem", () => {
    expect(
      classifyGitFailure({
        stage: 'worktree',
        text: '无法创建工作区临时目录: /Users/dev/.c3/worktrees/proj',
      }),
    ).toBe('filesystem_denied')
  })
})

describe('classifyGitFailure — PR commit / push chain', () => {
  it('classifies a pre-commit hook rejection', () => {
    expect(
      classifyGitFailure({
        stage: 'commit-push',
        text: 'git commit 失败: ✖ eslint --fix found 3 errors. husky - pre-commit hook exited with code 1 (error)',
      }),
    ).toBe('commit_hook_rejected')
  })

  it('classifies a remote pre-receive hook rejection ahead of the generic reject', () => {
    expect(
      classifyGitFailure({
        stage: 'commit-push',
        text: 'git push 失败: ! [remote rejected] intent-abc -> intent-abc (pre-receive hook declined)',
      }),
    ).toBe('commit_hook_rejected')
  })

  it('classifies an unresolved local conflict blocking the commit', () => {
    expect(
      classifyGitFailure({
        stage: 'commit-push',
        text: 'git commit 失败: error: Committing is not possible because you have unmerged files.',
      }),
    ).toBe('repo_conflict_unresolved')
  })

  it('classifies a DNS failure', () => {
    expect(
      classifyGitFailure({
        stage: 'commit-push',
        text: "git push 失败: fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com",
      }),
    ).toBe('network_unreachable')
  })

  it('classifies a connection timeout', () => {
    expect(
      classifyGitFailure({
        stage: 'commit-push',
        text: 'git push 失败: ssh: connect to host github.com port 22: Operation timed out',
      }),
    ).toBe('network_unreachable')
  })

  it('classifies a missing push right', () => {
    expect(
      classifyGitFailure({
        stage: 'commit-push',
        text: 'git push 失败: remote: Permission to owner/repo.git denied to dev-user. fatal: unable to access: The requested URL returned error: 403',
      }),
    ).toBe('remote_permission_denied')
  })

  it('classifies an SSH key rejection as a remote permission problem', () => {
    expect(
      classifyGitFailure({
        stage: 'commit-push',
        text: 'git push 失败: git@github.com: Permission denied (publickey). fatal: Could not read from remote repository.',
      }),
    ).toBe('remote_permission_denied')
  })

  it('classifies a remote branch that has moved ahead', () => {
    expect(
      classifyGitFailure({
        stage: 'commit-push',
        text: 'git push 失败: ! [rejected] intent-abc -> intent-abc (non-fast-forward) hint: Updates were rejected because the tip of your current branch is behind',
      }),
    ).toBe('push_rejected')
  })
})

describe('classifyGitFailure — forge PR creation', () => {
  it('trusts the CLI runner’s own "unavailable" verdict', () => {
    expect(
      classifyGitFailure({
        stage: 'forge-create',
        text: 'gh CLI 未安装',
        cliUnavailable: true,
      }),
    ).toBe('forge_cli_unavailable')
  })

  it('classifies a logged-out CLI from its own message', () => {
    expect(
      classifyGitFailure({
        stage: 'forge-create',
        text: 'To get started with GitHub CLI, please run: gh auth login',
      }),
    ).toBe('forge_cli_unavailable')
  })

  it('classifies a forge API network failure', () => {
    expect(
      classifyGitFailure({
        stage: 'forge-create',
        text: 'Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host',
      }),
    ).toBe('network_unreachable')
  })

  it('classifies a missing PR-create right', () => {
    expect(
      classifyGitFailure({
        stage: 'forge-create',
        text: 'HTTP 403: Resource not accessible by integration (https://api.github.com/repos/o/r/pulls)',
      }),
    ).toBe('remote_permission_denied')
  })

  it('classifies a PR that already exists for this branch', () => {
    expect(
      classifyGitFailure({
        stage: 'forge-create',
        text: 'a pull request for branch "intent-abc" into branch "main" already exists: https://github.com/o/r/pull/42',
      }),
    ).toBe('forge_create_rejected')
  })

  it('classifies a forge validation refusal', () => {
    expect(
      classifyGitFailure({
        stage: 'forge-create',
        text: 'HTTP 422: Validation Failed (https://api.github.com/repos/o/r/pulls)',
      }),
    ).toBe('forge_create_rejected')
  })
})

describe('classifyGitFailure — insufficient evidence stays unknown', () => {
  it('does not guess from an empty error', () => {
    expect(classifyGitFailure({ stage: 'worktree', text: '' })).toBe('unknown')
    expect(classifyGitFailure({ stage: 'commit-push', text: '   \n ' })).toBe('unknown')
  })

  it('does not read "repository not found" as a permission problem', () => {
    // GitHub returns this both for a private repo one cannot read AND for a
    // wrong remote URL — not enough to send the user asking for access.
    expect(
      classifyGitFailure({
        stage: 'commit-push',
        text: "git push 失败: remote: Repository not found. fatal: repository 'https://github.com/o/r.git/' not found",
      }),
    ).toBe('unknown')
  })

  it('does not read a plain "failed" as any category', () => {
    expect(
      classifyGitFailure({
        stage: 'commit-push',
        text: 'git push 失败: error: failed to push some refs',
      }),
    ).toBe('unknown')
  })

  it('does not read a generic forge error as a rejection', () => {
    expect(classifyGitFailure({ stage: 'forge-create', text: 'gh pr create 失败' })).toBe('unknown')
  })

  it('does not read a worktree conflict-free failure as a conflict', () => {
    expect(
      classifyGitFailure({
        stage: 'worktree',
        text: 'git worktree add 失败: fatal: invalid reference: origin/main',
      }),
    ).toBe('unknown')
  })

  it('keeps stages apart — a push permission phrase is not a worktree verdict', () => {
    // The same word means different things per stage: at the worktree stage a
    // permission refusal is local, so it must NOT come out as a remote one.
    expect(
      classifyGitFailure({
        stage: 'worktree',
        text: 'fatal: could not create leading directories: Permission denied',
      }),
    ).toBe('filesystem_denied')
  })
})

describe('buildGitFailureGuidance', () => {
  it('keeps the raw text verbatim and binds the retry to the original action', () => {
    const guidance = buildGitFailureGuidance(
      { stage: 'worktree', text: "fatal: 'x' already exists\nsecond line" },
      'intent-1',
      'start-development',
    )
    expect(guidance).toEqual({
      reason: 'worktree_branch_or_path_taken',
      detail: "fatal: 'x' already exists\nsecond line",
      retry: { type: 'intent-action', intentId: 'intent-1', action: 'start-development' },
    })
  })

  it('keeps the raw text on an unknown reason too', () => {
    const guidance = buildGitFailureGuidance(
      { stage: 'forge-create', text: 'something entirely new' },
      'intent-2',
      'create-pr',
    )
    expect(guidance.reason).toBe('unknown')
    expect(guidance.detail).toBe('something entirely new')
    expect(guidance.retry).toEqual({
      type: 'intent-action',
      intentId: 'intent-2',
      action: 'create-pr',
    })
  })
})
