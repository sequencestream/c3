import { describe, expect, it } from 'vitest'
import type { SkillRepoConfig } from '@ccc/shared/protocol'
import { parseSkillRepoUrl, validateSkillRepos } from './index.js'

// `validateSkillRepos` is the fail-HARD validator (ADR-0016): unlike the fail-soft
// settings `normalize`, every violation throws. These tests pin the four mandated
// error paths (missing ref / dup id / pinned-without-SHA / devSkill collision) plus
// the GitHub-URL ref/subpath backfill, with no disk access (pure function).

/** Minimal valid repo config with overridable fields. */
function repo(over: Partial<SkillRepoConfig> = {}): SkillRepoConfig {
  return {
    id: 'r1',
    repo: 'https://github.com/owner/repo',
    ref: 'main',
    trust: 'unreviewed',
    ...over,
  }
}

describe('parseSkillRepoUrl', () => {
  it('returns a plain repo URL unchanged with no ref/subpath', () => {
    expect(parseSkillRepoUrl('https://github.com/owner/repo')).toEqual({
      repo: 'https://github.com/owner/repo',
    })
  })

  it('extracts ref from a GitHub /tree/<ref> URL', () => {
    expect(parseSkillRepoUrl('https://github.com/owner/repo/tree/dev')).toEqual({
      repo: 'https://github.com/owner/repo',
      ref: 'dev',
    })
  })

  it('extracts ref + subpath from a GitHub /tree/<ref>/<subpath> URL', () => {
    expect(parseSkillRepoUrl('https://github.com/owner/repo/tree/dev/skills/foo')).toEqual({
      repo: 'https://github.com/owner/repo',
      ref: 'dev',
      subpath: 'skills/foo',
    })
  })

  it('parses a GitLab /-/tree/ URL via the adapter (not swallowed by GitHub pattern)', () => {
    expect(parseSkillRepoUrl('https://gitlab.com/grp/proj/-/tree/release/pkg')).toEqual({
      repo: 'https://gitlab.com/grp/proj',
      ref: 'release',
      subpath: 'pkg',
    })
  })
})

describe('validateSkillRepos', () => {
  it('returns [] for absent config', () => {
    expect(validateSkillRepos(undefined)).toEqual([])
  })

  it('applies vendor/trust defaults', () => {
    const [r] = validateSkillRepos([
      { id: 'r1', repo: 'https://github.com/o/r', ref: 'main' } as SkillRepoConfig,
    ])
    expect(r.vendor).toBe('claude')
    expect(r.trust).toBe('unreviewed')
  })

  it('backfills ref + subpath from the repo URL when fields are unset', () => {
    const [r] = validateSkillRepos([
      {
        id: 'r1',
        repo: 'https://github.com/o/r/tree/dev/skills/x',
        trust: 'unreviewed',
      } as SkillRepoConfig,
    ])
    expect(r.repo).toBe('https://github.com/o/r')
    expect(r.ref).toBe('dev')
    expect(r.subpath).toBe('skills/x')
  })

  it('throws when ref is missing and the URL carries none', () => {
    expect(() => validateSkillRepos([repo({ ref: '' })])).toThrow(/ref 必填/)
  })

  it('throws on duplicate ids', () => {
    expect(() => validateSkillRepos([repo({ id: 'dup' }), repo({ id: 'dup' })])).toThrow(/id 重复/)
  })

  it('throws when a pinned repo lacks a 40-hex pinCommit', () => {
    expect(() => validateSkillRepos([repo({ trust: 'pinned' })])).toThrow(/40 位 SHA/)
    expect(() => validateSkillRepos([repo({ trust: 'pinned', pinCommit: 'abc' })])).toThrow(
      /40 位 SHA/,
    )
  })

  it('accepts a pinned repo with a valid SHA (lowercased)', () => {
    const sha = 'A'.repeat(40)
    const [r] = validateSkillRepos([repo({ trust: 'pinned', pinCommit: sha })])
    expect(r.pinCommit).toBe('a'.repeat(40))
  })

  it('throws when devSkill (sans leading /) collides with a repo id', () => {
    expect(() => validateSkillRepos([repo({ id: 'mySkill' })], '/mySkill')).toThrow(/冲突/)
  })

  it('does not throw when devSkill names no repo id', () => {
    expect(() => validateSkillRepos([repo({ id: 'mySkill' })], '/other')).not.toThrow()
  })

  it('throws when id is empty', () => {
    expect(() => validateSkillRepos([repo({ id: '  ' })])).toThrow(/id 必填/)
  })

  it('throws when repo is empty', () => {
    expect(() => validateSkillRepos([repo({ repo: '' })])).toThrow(/repo 必填/)
  })
})
