import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  classifyCommitFailure,
  closeForgePr,
  closeGhPr,
  collectGitStatus,
  commitAndPush,
  createForgePr,
  createGlabMr,
  detectForge,
  getForgePrStatus,
  gitDiffStat,
  gitRecentLog,
  parsePorcelainStatus,
} from './git.js'

// These tests drive the REAL `git` CLI against throwaway repos in a temp dir, with
// bare repos as push targets — so they exercise discovery + per-repo commit/push
// for real, not a mock. Remotes live OUTSIDE the scanned root so the scan can't
// mistake them for workspace repos.

let dir: string // temp sandbox; `<dir>/work` is the scanned workspace root
let work: string
let remotes: string // <dir>/remotes — bare push targets, outside `work`
const originalPath = process.env.PATH

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

/** Install a controllable CLI stand-in for a test without invoking a real forge. */
function installFakeCli(name: 'gh' | 'glab', stdout: string, stderr = '', exitCode = 0): void {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const script = join(bin, name)
  writeFileSync(
    script,
    `#!/bin/sh\nprintf '%s' '${stdout}'\nprintf '%s' '${stderr}' 1>&2\nexit ${exitCode}\n`,
  )
  chmodSync(script, 0o755)
  process.env.PATH = `${bin}:${originalPath ?? ''}`
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-git-'))
  work = join(dir, 'work')
  remotes = join(dir, 'remotes')
  mkdirSync(work, { recursive: true })
  mkdirSync(remotes, { recursive: true })
})

afterEach(() => {
  process.env.PATH = originalPath
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

  it('a fresh branch with no upstream self-heals: push sets upstream and succeeds', async () => {
    // Repo HAS a remote, but the current branch is a fresh `intent/*` branch with
    // no configured upstream — exactly what automation creates. A bare `git push`
    // would fail "has no upstream branch"; commitAndPush must recover with -u.
    initRepo(work, 'root')
    run('git', ['-C', work, 'checkout', '-q', '-b', 'intent/0643a7aa-workcenter'], work)
    writeFileSync(join(work, 'feature.ts'), 'export const f = 1\n')

    const res = await commitAndPush(work, 'feat: 需求标题')

    expect(res.ok).toBe(true)
    expect(res.committed).toBe(true)
    expect(lastCommitMsg(work)).toBe('feat: 需求标题')
    expect(aheadCount(work)).toBe(0) // upstream now set, commit reached the remote
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

describe('forge detection and change-request creation', () => {
  function setOrigin(url: string): void {
    initRepo(work, 'root', false)
    run('git', ['remote', 'add', 'origin', url], work)
  }

  it.each([
    ['GitHub', 'git@github.com:owner/repo.git', 'github'],
    ['GitLab.com', 'https://gitlab.com/owner/repo.git', 'gitlab'],
    ['self-hosted GitLab', 'ssh://git@gitlab.internal/owner/repo.git', 'gitlab'],
  ] as const)('detects %s origin as %s', async (_name, url, expected) => {
    setOrigin(url)
    expect(await detectForge(work)).toBe(expected)
  })

  it('creates a GitLab MR and parses its number', async () => {
    installFakeCli('glab', 'https://gitlab.example/owner/repo/-/merge_requests/42\n')

    await expect(createGlabMr(work, 'Title', 'Body', 'feature', 'develop')).resolves.toEqual({
      ok: true,
      prId: '42',
      prUrl: 'https://gitlab.example/owner/repo/-/merge_requests/42',
    })
  })

  it('marks a missing glab CLI unavailable', async () => {
    process.env.PATH = join(dir, 'empty-bin')

    await expect(createGlabMr(work, 'Title', 'Body')).resolves.toMatchObject({
      ok: false,
      unavailable: true,
      error: 'glab CLI 未安装',
    })
  })

  it('marks unauthenticated glab unavailable', async () => {
    installFakeCli(
      'glab',
      '',
      'You are not logged into any GitLab instances. Run glab auth login.',
      1,
    )

    await expect(createGlabMr(work, 'Title', 'Body')).resolves.toMatchObject({
      ok: false,
      unavailable: true,
    })
  })

  it('returns a regular error for other glab failures', async () => {
    installFakeCli('glab', '', 'merge request already exists', 1)

    await expect(createGlabMr(work, 'Title', 'Body')).resolves.toEqual({
      ok: false,
      error: 'merge request already exists',
    })
  })

  it('uses an override before origin detection when dispatching', async () => {
    setOrigin('https://github.com/owner/repo.git')
    installFakeCli('glab', 'https://gitlab.example/owner/repo/-/merge_requests/7\n')

    await expect(
      createForgePr(work, 'Title', 'Body', undefined, undefined, 'gitlab'),
    ).resolves.toMatchObject({
      ok: true,
      prId: '7',
    })
  })

  it('dispatches from origin detection to GitHub and GitLab', async () => {
    setOrigin('https://github.com/owner/repo.git')
    installFakeCli('gh', 'https://github.com/owner/repo/pull/8\n')
    await expect(createForgePr(work, 'Title', 'Body')).resolves.toMatchObject({
      ok: true,
      prId: '8',
    })

    run('git', ['remote', 'set-url', 'origin', 'https://gitlab.internal/owner/repo.git'], work)
    installFakeCli('glab', 'https://gitlab.internal/owner/repo/-/merge_requests/9\n')
    await expect(createForgePr(work, 'Title', 'Body')).resolves.toMatchObject({
      ok: true,
      prId: '9',
    })
  })

  it('reads GitHub merged PR status', async () => {
    installFakeCli(
      'gh',
      '{"state":"MERGED","mergedAt":"2026-06-30T00:00:00Z","url":"https://github.com/o/r/pull/8"}',
    )

    await expect(getForgePrStatus(work, '8', 'github')).resolves.toMatchObject({
      ok: true,
      status: 'merged',
      prUrl: 'https://github.com/o/r/pull/8',
    })
  })

  it('reads GitLab closed MR status without treating it as merged', async () => {
    installFakeCli('glab', '{"state":"closed","web_url":"https://gitlab/o/r/-/merge_requests/9"}')

    await expect(getForgePrStatus(work, '9', 'gitlab')).resolves.toMatchObject({
      ok: true,
      status: 'closed',
      prUrl: 'https://gitlab/o/r/-/merge_requests/9',
    })
  })
})

describe('closeGhPr / closeForgePr — cancel-intent PR close gate', () => {
  /** Fake CLI that records the exact argv it was called with to `<dir>/argv`. */
  function installArgvRecordingCli(name: 'gh' | 'glab'): string {
    const bin = join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    const argvFile = join(dir, `${name}-argv`)
    const script = join(bin, name)
    writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\nexit 0\n`)
    chmodSync(script, 0o755)
    process.env.PATH = `${bin}:${originalPath ?? ''}`
    return argvFile
  }

  it('closes a GitHub PR with exactly `pr close <id>` and no extra flags', async () => {
    const argvFile = installArgvRecordingCli('gh')

    await expect(closeGhPr(work, '123')).resolves.toEqual({ ok: true })
    expect(readFileSync(argvFile, 'utf8').trim().split('\n')).toEqual(['pr', 'close', '123'])
  })

  it('treats an already-closed PR as a failure (blocks the cancellation)', async () => {
    installFakeCli('gh', '', 'GraphQL: Could not resolve to a PullRequest', 1)

    await expect(closeGhPr(work, '123')).resolves.toEqual({
      ok: false,
      error: 'GraphQL: Could not resolve to a PullRequest',
    })
  })

  it('marks a missing gh CLI unavailable', async () => {
    process.env.PATH = join(dir, 'empty-bin')

    await expect(closeGhPr(work, '123')).resolves.toMatchObject({
      ok: false,
      unavailable: true,
      error: 'gh CLI 未安装',
    })
  })

  it('marks an unauthenticated gh unavailable', async () => {
    installFakeCli('gh', '', 'To get started with GitHub CLI, please run: gh auth login', 1)

    await expect(closeGhPr(work, '123')).resolves.toMatchObject({
      ok: false,
      unavailable: true,
    })
  })

  it('routes to glab via an explicit provider override', async () => {
    const argvFile = installArgvRecordingCli('glab')

    await expect(closeForgePr(work, '42', 'gitlab')).resolves.toEqual({ ok: true })
    expect(readFileSync(argvFile, 'utf8').trim().split('\n')).toEqual(['mr', 'close', '42'])
  })
})

describe('commitAndPush — no git repo in the workspace', () => {
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

describe('parsePorcelainStatus — NUL porcelain parsing', () => {
  // Build a `-z` porcelain blob: each record `XY <path>` joined by NUL, with a
  // trailing NUL like real git output.
  const z = (...records: string[]): string => records.join('\0') + '\0'

  it('?? → untracked;` M` → modified;`M ` → staged', () => {
    const out = parsePorcelainStatus(z('?? new.ts', ' M edited.ts', 'M  staged.ts'))
    expect(out['new.ts']).toEqual({ modified: false, untracked: true, staged: false })
    expect(out['edited.ts']).toEqual({ modified: true, untracked: false, staged: false })
    expect(out['staged.ts']).toEqual({ modified: false, untracked: false, staged: true })
  })

  it('MM / AM → staged 且 modified(可组合标志)', () => {
    const out = parsePorcelainStatus(z('MM both.ts', 'AM added.ts'))
    expect(out['both.ts']).toEqual({ modified: true, untracked: false, staged: true })
    expect(out['added.ts']).toEqual({ modified: true, untracked: false, staged: true })
  })

  it('保留空格与非 ASCII 路径(NUL 分隔不误拆)', () => {
    const out = parsePorcelainStatus(z('?? a file.ts', ' M 目录/文件 名.ts'))
    expect(out['a file.ts']).toEqual({ modified: false, untracked: true, staged: false })
    expect(out['目录/文件 名.ts']).toEqual({ modified: true, untracked: false, staged: false })
  })

  it('删除(`D `/` D`)、重命名(`R `+旧路径)、冲突(UU/DD/AA)均被过滤', () => {
    const out = parsePorcelainStatus(
      z(
        'D  gone.ts', // 暂存删除
        ' D vanished.ts', // 工作区删除
        'R  new-name.ts', // 重命名(下一 token 为旧路径)
        'old-name.ts',
        'UU conflict.ts', // 未合并冲突
        'DD bothdel.ts',
        'AA bothadd.ts',
        ' M survivor.ts', // 正常项,确认解析未被前面的旧路径 token 打乱
      ),
    )
    expect(out).toEqual({
      'survivor.ts': { modified: true, untracked: false, staged: false },
    })
  })

  it('空输入 → 空对象', () => {
    expect(parsePorcelainStatus('')).toEqual({})
    expect(parsePorcelainStatus('\0')).toEqual({})
  })
})

describe('collectGitStatus — workspace snapshot (real git)', () => {
  it('root repo: staged / modified / untracked 三态,路径为工作区相对', async () => {
    initRepo(work, 'root', false)
    // 已跟踪并 committed 的文件做未暂存修改
    writeFileSync(join(work, 'README.md'), 'init\nmore\n')
    // 新建并 stage
    writeFileSync(join(work, 'staged.ts'), 'export const s = 1\n')
    run('git', ['add', 'staged.ts'], work)
    // 未跟踪
    writeFileSync(join(work, 'untracked.ts'), 'export const u = 1\n')

    const out = await collectGitStatus(work)
    expect(out['README.md']).toEqual({ modified: true, untracked: false, staged: false })
    // 新增并 stage 的文件:索引列 A → staged
    expect(out['staged.ts']).toEqual({ modified: false, untracked: false, staged: true })
    expect(out['untracked.ts']).toEqual({ modified: false, untracked: true, staged: false })
  })

  it('multi-repo root: 子仓库路径加仓库相对前缀', async () => {
    const api = join(work, 'packages', 'api')
    const ui = join(work, 'packages', 'ui')
    initRepo(api, 'api', false)
    initRepo(ui, 'ui', false)
    writeFileSync(join(api, 'a.ts'), 'export const a = 1\n') // untracked in api
    writeFileSync(join(ui, 'README.md'), 'init\nchanged\n') // modified in ui

    const out = await collectGitStatus(work)
    expect(out['packages/api/a.ts']).toEqual({ modified: false, untracked: true, staged: false })
    expect(out['packages/ui/README.md']).toEqual({
      modified: true,
      untracked: false,
      staged: false,
    })
  })

  it('非 git 根:空快照(安全降级)', async () => {
    mkdirSync(join(work, 'src'), { recursive: true })
    writeFileSync(join(work, 'src', 'note.txt'), 'hello\n')
    expect(await collectGitStatus(work)).toEqual({})
  })

  it('multi-repo root:单个子仓库损坏被忽略,其余仓库结果保留', async () => {
    const good = join(work, 'good')
    const broken = join(work, 'broken')
    initRepo(good, 'good', false)
    writeFileSync(join(good, 'g.ts'), 'export const g = 1\n') // untracked
    // 伪造一个“看起来是仓库但 git status 会失败”的目录:.git 是文件但内容无效
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, '.git'), 'gitdir: /nonexistent/path\n')

    const out = await collectGitStatus(work)
    expect(out['good/g.ts']).toEqual({ modified: false, untracked: true, staged: false })
    // 损坏子仓库不贡献任何条目,也不抛错
    expect(Object.keys(out).some((k) => k.startsWith('broken/'))).toBe(false)
  })
})
