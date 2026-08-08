/**
 * A minimal REAL git repository for tests whose subject runs git.
 *
 * `worktree` is the default branch mode, so every session launch prepares an
 * intent worktree — which needs an actual repository with at least one commit
 * (`git worktree add` refuses on an unborn HEAD). A bare temp directory used to
 * be enough only because the non-work session kinds never touched git.
 *
 * Identity and `init.defaultBranch` come from `git-env-setup.ts`, which injects
 * them into every git child of the test process; they are set again here so a
 * repo built by this helper is self-sufficient.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Init `dir` as a git repo on `main` with one commit. Idempotent enough for a fresh temp dir. */
export function initTestGitRepo(dir: string): void {
  const run = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  run('init', '-b', 'main')
  run('config', 'user.email', 'test@test')
  run('config', 'user.name', 'Test')
  run('config', 'commit.gpgsign', 'false')
  // `git worktree add` needs a commit to root at.
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8')
  run('add', '-A')
  run('commit', '-m', 'initial')
}
