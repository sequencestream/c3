/**
 * Git repository operation layer for external skill sources (ADR-0016, batch 1/3).
 *
 * A `SkillRepoConfig` names a git repo + ref; c3 clones it into a **shared** cache
 * under `~/.c3/repo/<hash>` keyed by `(repo, ref)` ONLY — never by vendor — so the
 * three vendors (claude / codex / opencode) reuse one clone and switching a repo's
 * target vendor downloads nothing extra (the 2/3 mount layer just soft-links into
 * each vendor's skill dir). This module is the data plane: clone / pull / ls-remote
 * / subpath-resolve / pinned-commit verify. It does NOT mount, link, or touch any
 * vendor directory — that is the mount layer (2/3).
 *
 * Private-repo auth is out of scope for the MVP: we shell out to the host `git`, so
 * SSH config and the git credential helper apply transparently with no c3-managed
 * secrets. Every call is scoped via `git -C <dir>` (or a bare remote command);
 * nothing here touches `process.cwd()`.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SkillRepoConfig } from '@ccc/shared/protocol'

/** Result of one `git` invocation; never rejects (mirrors `git.ts`'s runner). */
export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Run `git <args>` (optionally inside `cwd`); resolve with code/stdout/stderr,
 * never reject. A bare remote command (`ls-remote`, `clone`) passes no `cwd`.
 */
export function runGit(args: string[], cwd?: string): Promise<GitRunResult> {
  return new Promise((done) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 16 * 1024 * 1024 },
      (err: (Error & { code?: unknown }) | null, stdout, stderr) => {
        const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0
        done({ code, stdout: stdout.toString(), stderr: stderr.toString() })
      },
    )
  })
}

/** The shared clone-cache root: `~/.c3/repo/`. All vendors share clones under here. */
export function skillRepoCacheRoot(): string {
  return join(homedir(), '.c3', 'repo')
}

/**
 * Deterministic cache directory for a `(repo, ref)` pair. The key is the repo URL
 * and ref ONLY — **vendor is deliberately excluded** so claude/codex/opencode map
 * to the same clone (ADR-0016: "三 vendor 共用同一份, 切 vendor 零重复下载"). Two
 * configs that pin different refs of the same repo get separate working trees (a
 * tree can only be checked out at one ref), which is correct and still vendor-shared.
 */
export function skillRepoCacheDir(repo: string, ref: string): string {
  const hash = createHash('sha256').update(`${repo}\n${ref}`).digest('hex').slice(0, 16)
  return join(skillRepoCacheRoot(), hash)
}

/** True when `dir` is a git working tree (has a `.git` marker). */
function isRepoDir(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

/** Collapse multiline git output to one trimmed, capped line for an error message. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/**
 * Resolve `ref` against `repo` on the remote without fetching — `git ls-remote`.
 * Returns the resolved 40-hex SHA, or `null` when the ref doesn't exist on the
 * remote. Throws on a git/transport failure (network, auth, no such repo) so the
 * caller can distinguish "ref absent" from "couldn't reach the remote at all".
 */
export async function lsRemote(repo: string, ref: string): Promise<string | null> {
  const r = await runGit(['ls-remote', repo, ref])
  if (r.code !== 0) {
    throw new Error(`git ls-remote 失败 (${repo} ${ref}): ${oneLine(r.stderr || r.stdout)}`)
  }
  const line = r.stdout.trim().split('\n')[0]?.trim()
  if (!line) return null
  const sha = line.split(/\s+/)[0]
  return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null
}

/**
 * Clone `repo` at `ref` into `dir`. Resolves with the git result. Caller ensures
 * `dir` does not already hold a clone (see {@link cloneOrUpdate}).
 */
export async function cloneRepo(repo: string, ref: string, dir: string): Promise<GitRunResult> {
  return runGit(['clone', '--branch', ref, repo, dir])
}

/**
 * Update an existing clone in `dir` to the latest `ref`: fetch it, then
 * `reset --hard FETCH_HEAD` so the working tree becomes exactly the fetched ref.
 * A hard reset (not a plain `checkout`, which would leave a stale local branch
 * un-advanced) keeps the tree authoritative to the remote — external skills are
 * read-only inputs, local drift is never preserved. c3 always mounts the `ref`'s
 * current head (branch / tag / commit).
 */
export async function pullRepo(dir: string, ref: string): Promise<GitRunResult> {
  const fetch = await runGit(['-C', dir, 'fetch', 'origin', ref], dir)
  if (fetch.code !== 0) return fetch
  return runGit(['-C', dir, 'reset', '--hard', 'FETCH_HEAD'], dir)
}

/**
 * Resolve a repo-relative `subpath` to an absolute path inside `repoDir`, with a
 * containment guard: a `subpath` that escapes the repo (via `..`, an absolute
 * path, or a symlink-style climb) throws — c3 must never mount a directory outside
 * the clone. An empty/undefined subpath resolves to `repoDir` itself. Throws when
 * the resolved path does not exist.
 */
export function resolveSubpath(repoDir: string, subpath?: string): string {
  const base = resolve(repoDir)
  if (!subpath || !subpath.trim()) {
    if (!existsSync(base)) throw new Error(`skill 仓库目录不存在: ${base}`)
    return base
  }
  const sp = subpath.trim()
  if (isAbsolute(sp)) throw new Error(`subpath 不能是绝对路径: ${sp}`)
  const target = resolve(base, sp)
  const rel = relative(base, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`subpath 越界 (逃出仓库目录): ${sp}`)
  }
  if (!existsSync(target)) throw new Error(`subpath 在仓库内不存在: ${sp}`)
  // Defensive: target must be strictly under base (belt-and-suspenders vs `relative`).
  if (!target.startsWith(base + sep)) throw new Error(`subpath 越界 (逃出仓库目录): ${sp}`)
  return target
}

/** Outcome of {@link ensureSkillRepo}: the on-disk skill source dir, or an error. */
export interface EnsureSkillRepoResult {
  ok: boolean
  /** Clone cache dir for this `(repo, ref)` (always set, even on failure, for cleanup). */
  cacheDir: string
  /** The resolved skill source directory (cache dir + subpath) when `ok`. */
  skillDir?: string
  error?: string
}

/**
 * Bring a `SkillRepoConfig` to a ready-on-disk state in the shared cache: clone (or
 * update) it at its `ref`, and resolve its `subpath`. Returns the final skill source
 * directory the mount layer (2/3) will link from. Vendor is irrelevant here — the
 * cache is shared across vendors by design.
 *
 * `config` is assumed already validated by `getSkillRepos()` (ref present); c3 always
 * mounts the `ref`'s current head, with no pin verification.
 */
export async function ensureSkillRepo(config: SkillRepoConfig): Promise<EnsureSkillRepoResult> {
  const cacheDir = skillRepoCacheDir(config.repo, config.ref)
  const git = isRepoDir(cacheDir)
    ? await pullRepo(cacheDir, config.ref)
    : await cloneRepo(config.repo, config.ref, cacheDir)
  if (git.code !== 0) {
    return { ok: false, cacheDir, error: `git 同步失败: ${oneLine(git.stderr || git.stdout)}` }
  }
  try {
    const skillDir = resolveSubpath(cacheDir, config.subpath)
    return { ok: true, cacheDir, skillDir }
  } catch (err) {
    return { ok: false, cacheDir, error: err instanceof Error ? err.message : String(err) }
  }
}
