import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyCommitFailure,
  commitAndPush,
  gitDiffStat,
  gitRecentLog,
  runLintFix,
} from './git.js'

// These tests drive the REAL `git` CLI against throwaway repos in a temp dir, with
// bare repos as push targets — so they exercise discovery + per-repo commit/push
// for real, not a mock. Remotes live OUTSIDE the scanned root so the scan can't
// mistake them for workspace repos.

let dir: string // temp sandbox; `<dir>/work` is the scanned workspace root
let work: string
let remotes: string // <dir>/remotes — bare push targets, outside `work`

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).toString()
}

/** Init a working repo at `path` with one initial commit. When `withRemote`, also
 *  create a bare remote and set upstream so `push` (and `@{u}`) work. */
function initRepo(path: string, name: string, withRemote = true): void {
  mkdirSync(path, { recursive: true })
  run('git', ['init', '-q'], path)
  run('git', ['config', 'user.email', 't@t.dev'], path)
  run('git', ['config', 'user.name', 'tester'], path)
  run('git', ['config', 'commit.gpgsign', 'false'], path)
  writeFileSync(join(path, 'README.md'), 'init\n')
  run('git', ['add', '-A'], path)
  run('git', ['commit', '-q', '-m', 'init'], path)
  if (withRemote) {
    const bare = join(remotes, `${name}.git`)
    run('git', ['init', '--bare', '-q', bare], remotes)
    run('git', ['remote', 'add', 'origin', bare], path)
    run('git', ['push', '-q', '-u', 'origin', 'HEAD'], path)
  }
}

/** Subject of the most recent commit in `repo`. */
function lastCommitMsg(repo: string): string {
  return run('git', ['-C', repo, 'log', '-1', '--pretty=%s'], repo).trim()
}

/** Commits in `repo` not yet on its upstream (0 ⇒ fully pushed). */
function aheadCount(repo: string): number {
  return Number(run('git', ['-C', repo, 'rev-list', '--count', '@{u}..HEAD'], repo).trim())
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-git-'))
  work = join(dir, 'work')
  remotes = join(dir, 'remotes')
  mkdirSync(work, { recursive: true })
  mkdirSync(remotes, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('commitAndPush — repository discovery & per-repo commit', () => {
  it('single root repo: commits & pushes the project root unchanged', async () => {
    initRepo(work, 'root')
    writeFileSync(join(work, 'a.ts'), 'export const a = 1\n')

    const res = await commitAndPush(work, 'feat: 需求标题')

    expect(res.ok).toBe(true)
    expect(res.committed).toBe(true)
    expect(lastCommitMsg(work)).toBe('feat: 需求标题')
    expect(aheadCount(work)).toBe(0) // pushed to upstream
  })

  it('single root repo: a clean-but-ahead tree still pushes (no new commit)', async () => {
    initRepo(work, 'root')
    // A self-committed-but-unpushed local commit, working tree clean.
    writeFileSync(join(work, 'b.ts'), 'export const b = 2\n')
    run('git', ['add', '-A'], work)
    run('git', ['commit', '-q', '-m', 'feat: self-committed'], work)
    expect(aheadCount(work)).toBe(1)

    const res = await commitAndPush(work, 'feat: 需求标题')

    expect(res.ok).toBe(true)
    expect(res.committed).toBe(false) // nothing new to commit
    expect(lastCommitMsg(work)).toBe('feat: self-committed') // unchanged
    expect(aheadCount(work)).toBe(0) // but the local commit reached the remote
  })

  it('single subdir repo: root has no .git, the one subrepo commits & pushes; root untouched', async () => {
    const app = join(work, 'app')
    initRepo(app, 'app')
    writeFileSync(join(app, 'x.ts'), 'export const x = 1\n')

    const res = await commitAndPush(work, 'feat: 需求标题')

    expect(res.ok).toBe(true)
    expect(res.committed).toBe(true)
    expect(lastCommitMsg(app)).toBe('feat: 需求标题')
    expect(aheadCount(app)).toBe(0)
  })

  it('multiple subdir repos: each affected repo commits separately by file location', async () => {
    const api = join(work, 'packages', 'api')
    const ui = join(work, 'packages', 'ui')
    initRepo(api, 'api')
    initRepo(ui, 'ui')
    writeFileSync(join(api, 'server.ts'), 'export const s = 1\n')
    writeFileSync(join(ui, 'app.ts'), 'export const u = 1\n')

    const res = await commitAndPush(work, 'feat: 需求标题')

    expect(res.ok).toBe(true)
    expect(res.committed).toBe(true)
    // Each repo got its own commit; files grouped to their owning repo.
    expect(lastCommitMsg(api)).toBe('feat: 需求标题')
    expect(lastCommitMsg(ui)).toBe('feat: 需求标题')
    expect(aheadCount(api)).toBe(0)
    expect(aheadCount(ui)).toBe(0)
  })

  it('multiple subdir repos: an untouched (clean, up-to-date) repo is left alone', async () => {
    const dirty = join(work, 'dirty')
    const clean = join(work, 'clean')
    initRepo(dirty, 'dirty')
    initRepo(clean, 'clean')
    writeFileSync(join(dirty, 'd.ts'), 'export const d = 1\n')

    const res = await commitAndPush(work, 'feat: 需求标题')

    expect(res.ok).toBe(true)
    expect(lastCommitMsg(dirty)).toBe('feat: 需求标题')
    expect(lastCommitMsg(clean)).toBe('init') // never touched
    expect(aheadCount(clean)).toBe(0)
  })

  it('push failure is a hard stop (failure: other), and the error names the failing repo', async () => {
    // A dirty subrepo with NO remote/upstream → push fails.
    const broken = join(work, 'broken')
    initRepo(broken, 'broken', false)
    writeFileSync(join(broken, 'c.ts'), 'export const c = 1\n')

    const res = await commitAndPush(work, 'feat: 需求标题')

    expect(res.ok).toBe(false)
    expect(res.error).toContain('broken')
    expect(res.error).toContain('git push 失败')
    expect(res.failure).toBe('other') // not a lint/pre-commit-hook failure → no self-heal
    // It committed locally before the push failed.
    expect(lastCommitMsg(broken)).toBe('feat: 需求标题')
  })

  it('a pre-commit hook lint failure is classified failure: commit-hook (self-heal eligible)', async () => {
    initRepo(work, 'root')
    // A pre-commit hook that fails like a lint hook would (eslint output, non-zero).
    writeFileSync(
      join(work, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\necho "✖ eslint: 2 problems (2 errors, 0 warnings)" 1>&2\nexit 1\n',
      { mode: 0o755 },
    )
    writeFileSync(join(work, 'bad.ts'), 'export const bad = 1\n')

    const res = await commitAndPush(work, 'feat: 需求标题')

    expect(res.ok).toBe(false)
    expect(res.error).toContain('git commit 失败')
    expect(res.failure).toBe('commit-hook') // lint signature → orchestrator self-heals
  })
})

describe('classifyCommitFailure — lint/pre-commit-hook vs other', () => {
  it('treats eslint / prettier / lint-staged / husky / pre-commit output as commit-hook', () => {
    expect(classifyCommitFailure('✖ 3 problems\nESLint found errors')).toBe('commit-hook')
    expect(classifyCommitFailure('[warn] Code style issues found, run Prettier')).toBe(
      'commit-hook',
    )
    expect(classifyCommitFailure('✖ lint-staged failed')).toBe('commit-hook')
    expect(classifyCommitFailure('husky - pre-commit hook exited with code 1')).toBe('commit-hook')
  })

  it('treats non-lint commit failures as other', () => {
    expect(classifyCommitFailure('error: failed to push some refs')).toBe('other')
    expect(classifyCommitFailure('nothing to commit, working tree clean')).toBe('other')
    expect(classifyCommitFailure('')).toBe('other')
  })
})

describe('runLintFix', () => {
  it('runs the configured command in cwd and reports ok on exit 0', async () => {
    const r = await runLintFix(work, 'echo fixed-by-lint')
    expect(r.ok).toBe(true)
    expect(r.output).toContain('fixed-by-lint')
  })

  it('reports not-ok on a non-zero command (so the orchestrator falls through)', async () => {
    const r = await runLintFix(work, 'exit 3')
    expect(r.ok).toBe(false)
  })

  it('is a no-op for a blank command (caller skips straight to the agent stage)', async () => {
    const r = await runLintFix(work, '   ')
    expect(r.ok).toBe(false)
    expect(r.output).toContain('未配置')
  })

  it('no git repo anywhere: reports an error and does not commit', async () => {
    // Plain files/dirs, no .git anywhere under the root.
    mkdirSync(join(work, 'src'), { recursive: true })
    writeFileSync(join(work, 'src', 'note.txt'), 'hello\n')

    const res = await commitAndPush(work, 'feat: 需求标题')

    expect(res.ok).toBe(false)
    expect(res.committed).toBe(false)
    expect(res.error).toContain('未找到 git 仓库')
  })
})

describe('gitDiffStat / gitRecentLog — multi-repo aware evidence', () => {
  it('root repo: reports its own diff and recent log (single-repo path)', async () => {
    initRepo(work, 'root')
    // `git diff HEAD --stat` only shows TRACKED changes — modify the tracked README.
    writeFileSync(join(work, 'README.md'), 'init\nedited\n')

    expect(await gitDiffStat(work)).toContain('README.md')
    expect(await gitRecentLog(work)).toContain('init')
  })

  it('subdir repos: sums each affected sub-repo, labelled by repo path — not empty just because root has no .git', async () => {
    const api = join(work, 'packages', 'api')
    const ui = join(work, 'packages', 'ui')
    initRepo(api, 'api')
    initRepo(ui, 'ui')
    // Uncommitted (tracked) change in api; a self-commit (clean tree) in ui.
    writeFileSync(join(api, 'README.md'), 'init\nedited\n')
    writeFileSync(join(ui, 'app.ts'), 'export const u = 1\n')
    run('git', ['add', '-A'], ui)
    run('git', ['commit', '-q', '-m', 'feat: ui self-commit'], ui)

    const diff = await gitDiffStat(work)
    // Root isn't a git repo, yet the sub-repo change surfaces, labelled by repo.
    expect(diff).not.toBe('')
    expect(diff).toContain('README.md')
    expect(diff).toContain('packages/api') //归属仓库标注

    const log = await gitRecentLog(work)
    expect(log).toContain('feat: ui self-commit')
    expect(log).toContain('packages/ui') // 归属仓库标注
  })

  it('no git repo anywhere: evidence is empty (the judge leans on the message)', async () => {
    mkdirSync(join(work, 'src'), { recursive: true })
    writeFileSync(join(work, 'src', 'note.txt'), 'hello\n')

    expect(await gitDiffStat(work)).toBe('')
    expect(await gitRecentLog(work)).toBe('')
  })
})
