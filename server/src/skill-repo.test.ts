import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillRepoConfig } from '@ccc/shared/protocol'
import {
  cloneRepo,
  ensureSkillRepo,
  lsRemote,
  pullRepo,
  resolveSubpath,
  skillRepoCacheDir,
  skillRepoCacheRoot,
  verifyPinnedCommit,
} from './skill-repo.js'

// These tests drive the REAL `git` CLI against a throwaway "remote" repo in a temp
// dir (a normal working repo used as a clone source — `git clone <path>` works
// fine). They cover clone / pull / ls-remote / subpath / cat-file individually with
// explicit temp dirs (NO writes to the user's real ~/.c3), plus the vendor-shared
// cache-key guarantee (ADR-0016).

let dir: string // temp sandbox root
let src: string // <dir>/src — the source repo we clone from
let headSha: string // HEAD commit of src@main

function run(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).toString()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-skillrepo-'))
  src = join(dir, 'src')
  mkdirSync(src, { recursive: true })
  run(['init', '-q', '-b', 'main'], src)
  run(['config', 'user.email', 't@t.dev'], src)
  run(['config', 'user.name', 'tester'], src)
  run(['config', 'commit.gpgsign', 'false'], src)
  mkdirSync(join(src, 'skills', 'foo'), { recursive: true })
  writeFileSync(join(src, 'skills', 'foo', 'SKILL.md'), '---\nname: foo\n---\nbody\n')
  writeFileSync(join(src, 'root.txt'), 'v1\n')
  run(['add', '-A'], src)
  run(['commit', '-q', '-m', 'init'], src)
  headSha = run(['rev-parse', 'HEAD'], src).trim()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('lsRemote', () => {
  it('resolves an existing ref to its SHA', async () => {
    expect(await lsRemote(src, 'main')).toBe(headSha.toLowerCase())
  })

  it('returns null for a ref that does not exist', async () => {
    expect(await lsRemote(src, 'no-such-branch')).toBeNull()
  })

  it('throws when the remote is unreachable', async () => {
    await expect(lsRemote(join(dir, 'does-not-exist'), 'main')).rejects.toThrow(/ls-remote/)
  })
})

describe('cloneRepo + pullRepo', () => {
  it('clones the ref into the target dir', async () => {
    const dest = join(dir, 'clone')
    const r = await cloneRepo(src, 'main', dest)
    expect(r.code).toBe(0)
    expect(existsSync(join(dest, '.git'))).toBe(true)
    expect(existsSync(join(dest, 'skills', 'foo', 'SKILL.md'))).toBe(true)
  })

  it('pull brings a new upstream commit into an existing clone', async () => {
    const dest = join(dir, 'clone')
    await cloneRepo(src, 'main', dest)
    // advance the source
    writeFileSync(join(src, 'root.txt'), 'v2\n')
    run(['add', '-A'], src)
    run(['commit', '-q', '-m', 'second'], src)
    const r = await pullRepo(dest, 'main')
    expect(r.code).toBe(0)
    expect(run(['show', 'HEAD:root.txt'], dest)).toContain('v2')
  })
})

describe('verifyPinnedCommit', () => {
  it('accepts a commit reachable in the clone history', async () => {
    const dest = join(dir, 'clone')
    await cloneRepo(src, 'main', dest)
    expect(await verifyPinnedCommit(dest, headSha)).toBe(true)
  })

  it('rejects a SHA absent from history (force-push forgery guard)', async () => {
    const dest = join(dir, 'clone')
    await cloneRepo(src, 'main', dest)
    expect(await verifyPinnedCommit(dest, 'b'.repeat(40))).toBe(false)
  })
})

describe('resolveSubpath', () => {
  it('returns the repo dir when subpath is empty', () => {
    expect(resolveSubpath(src)).toBe(src)
  })

  it('resolves a valid in-repo subpath', () => {
    expect(resolveSubpath(src, 'skills/foo')).toBe(join(src, 'skills', 'foo'))
  })

  it('throws on a non-existent subpath', () => {
    expect(() => resolveSubpath(src, 'skills/missing')).toThrow(/不存在/)
  })

  it('throws on a traversal escape', () => {
    expect(() => resolveSubpath(src, '../escape')).toThrow(/越界/)
  })

  it('throws on an absolute subpath', () => {
    expect(() => resolveSubpath(src, '/etc')).toThrow(/绝对路径/)
  })
})

describe('skillRepoCacheDir — vendor-shared cache (ADR-0016)', () => {
  it('lives under ~/.c3/repo/', () => {
    expect(skillRepoCacheRoot()).toBe(join(homedir(), '.c3', 'repo'))
    expect(skillRepoCacheDir('https://x/y', 'main').startsWith(skillRepoCacheRoot())).toBe(true)
  })

  it('is deterministic for the same (repo, ref)', () => {
    expect(skillRepoCacheDir('https://x/y', 'main')).toBe(skillRepoCacheDir('https://x/y', 'main'))
  })

  it('differs by ref', () => {
    expect(skillRepoCacheDir('https://x/y', 'main')).not.toBe(
      skillRepoCacheDir('https://x/y', 'dev'),
    )
  })

  it('is identical across vendors (same repo/ref → one shared clone, zero re-download)', () => {
    const base = { id: 'r', repo: 'https://x/y', ref: 'main', trust: 'unreviewed' as const }
    const claude: SkillRepoConfig = { ...base, vendor: 'claude' }
    const codex: SkillRepoConfig = { ...base, vendor: 'codex' }
    const opencode: SkillRepoConfig = { ...base, vendor: 'opencode' }
    const d = skillRepoCacheDir(claude.repo, claude.ref)
    expect(skillRepoCacheDir(codex.repo, codex.ref)).toBe(d)
    expect(skillRepoCacheDir(opencode.repo, opencode.ref)).toBe(d)
  })
})

describe('ensureSkillRepo (integration, isolated cache)', () => {
  // Point the shared cache at a temp HOME so we never touch the real ~/.c3.
  const realHome = process.env.HOME
  beforeEach(() => {
    process.env.HOME = join(dir, 'home')
    mkdirSync(process.env.HOME, { recursive: true })
  })
  afterEach(() => {
    process.env.HOME = realHome
  })

  it('clones, resolves subpath, and returns the skill dir', async () => {
    const cfg: SkillRepoConfig = {
      id: 'r',
      repo: src,
      ref: 'main',
      subpath: 'skills/foo',
      vendor: 'claude',
      trust: 'unreviewed',
    }
    const res = await ensureSkillRepo(cfg)
    expect(res.ok).toBe(true)
    expect(res.skillDir).toBe(join(res.cacheDir, 'skills', 'foo'))
    expect(existsSync(join(res.skillDir!, 'SKILL.md'))).toBe(true)
  })

  it('verifies a pinned commit and fails on a forged SHA', async () => {
    const good: SkillRepoConfig = {
      id: 'r',
      repo: src,
      ref: 'main',
      vendor: 'claude',
      trust: 'pinned',
      pinCommit: headSha,
    }
    expect((await ensureSkillRepo(good)).ok).toBe(true)

    const forged: SkillRepoConfig = { ...good, ref: 'main', pinCommit: 'c'.repeat(40) }
    const res = await ensureSkillRepo(forged)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/force-push|pinned/)
  })
})
