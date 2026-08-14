/**
 * Tests for the fast-spec turn settlement's diff measurement and reverse-spec
 * authoring. The diff path drives the REAL `git` CLI against throwaway repos in
 * a temp dir (mirroring `git.test.ts`), so baseline→worktree semantics —
 * including the no-double-count fix and multi-repo keying — are exercised for
 * real, not against a mock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Intent } from '@ccc/shared/protocol'
import { gitHeadCommits } from '../../git.js'
import { buildReverseSpec, computeTurnDiff, parseBaseline } from './fast-spec.js'

let dir: string // temp sandbox; `<dir>/work` is the scanned workspace root
let work: string

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).toString()
}

/** Init a working repo at `path` with one initial commit and a tracked README. */
function initRepo(path: string): void {
  mkdirSync(path, { recursive: true })
  run('git', ['init', '-q'], path)
  run('git', ['config', 'user.email', 't@t.dev'], path)
  run('git', ['config', 'user.name', 'tester'], path)
  run('git', ['config', 'commit.gpgsign', 'false'], path)
  writeFileSync(join(path, 'README.md'), 'init\n')
  run('git', ['add', '-A'], path)
  run('git', ['commit', '-q', '-m', 'init'], path)
}

/** A minimal-but-complete Intent for the reverse-spec builder. */
function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    id: 'i-1',
    workspaceName: 'proj',
    title: 'Test intent',
    shortEnTitle: 'test-intent',
    content: 'do something',
    priority: 'P1',
    module: '',
    status: 'todo',
    dependsOn: [],
    dependsOnTypes: {},
    lastWorkSessionId: null,
    automate: false,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    runStatus: 'idle',
    branchName: null,
    latestCommitHash: null,
    baseBranch: 'main',
    baseBranchFallback: false,
    prs: [],
    linkedDeliveries: [],
    specPath: null,
    specStatus: 'raw',
    specMode: null,
    effectiveSpecMode: 'fast',
    specApproved: false,
    specApproveUser: null,
    specSessionId: null,
    specReviewSessionId: null,
    specReviewVerdict: null,
    specReviewReason: null,
    specReviewAt: null,
    specReviewFingerprint: null,
    specReviewReworkRounds: 0,
    specReviewMachineApprovalBlocked: false,
    intentSessionId: null,
    sessionActive: false,
    actionDescriptor: null,
    ...overrides,
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-fast-spec-'))
  work = join(dir, 'work')
  mkdirSync(work, { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('parseBaseline', () => {
  it('parses a repo→commit object and drops non-object / invalid JSON', () => {
    expect(parseBaseline('{"a":"b"}')).toEqual({ a: 'b' })
    expect(parseBaseline('not json')).toEqual({})
    expect(parseBaseline('[]')).toEqual({})
    expect(parseBaseline('')).toEqual({})
  })
})

describe('computeTurnDiff — single repo', () => {
  it('counts committed AND uncommitted tracked changes against the baseline exactly once', async () => {
    initRepo(work)
    const base = await gitHeadCommits(work)
    // A committed change after the baseline…
    writeFileSync(join(work, 'a.ts'), 'export const a = 1\n')
    run('git', ['add', '-A'], work)
    run('git', ['commit', '-q', '-m', 'turn commit'], work)
    // …plus an uncommitted tracked edit. `git diff --numstat <base>` covers both;
    // the old code ALSO ran the un-ref'd diff and double-counted the uncommitted
    // edit (README +1 twice → lines 3). The fix counts it once.
    writeFileSync(join(work, 'README.md'), 'init\nedited\n')

    const stats = await computeTurnDiff(work, base)

    expect(stats.fileCount).toBe(2)
    expect(stats.lines).toBe(2) // a.ts +1, README +1 — never 3
    expect(stats.hasBinary).toBe(false)
    expect(stats.files).toEqual(['README.md', 'a.ts'])
  })

  it('counts untracked files in fileCount and lines', async () => {
    initRepo(work)
    const base = await gitHeadCommits(work)
    writeFileSync(join(work, 'new.ts'), 'line1\nline2\n')

    const stats = await computeTurnDiff(work, base)

    expect(stats.fileCount).toBe(1)
    expect(stats.lines).toBe(2)
    expect(stats.files).toEqual(['new.ts'])
    expect(stats.diffText).toContain('untracked')
  })

  it('marks a binary change as hasBinary (over-threshold classification)', async () => {
    initRepo(work)
    const base = await gitHeadCommits(work)
    writeFileSync(join(work, 'blob.bin'), Buffer.from([0, 1, 2, 3]))

    const stats = await computeTurnDiff(work, base)

    expect(stats.hasBinary).toBe(true)
  })

  it('a null baseline still counts uncommitted tracked + untracked changes', async () => {
    initRepo(work)
    writeFileSync(join(work, 'README.md'), 'init\nx\n')
    writeFileSync(join(work, 'untracked.ts'), 'u\n')

    const stats = await computeTurnDiff(work, { [work]: null })

    expect(stats.fileCount).toBe(2)
    expect(stats.lines).toBe(2)
  })

  it('an empty baseline measures nothing', async () => {
    initRepo(work)
    writeFileSync(join(work, 'a.ts'), 'export const a = 1\n')

    const stats = await computeTurnDiff(work, {})

    expect(stats.fileCount).toBe(0)
    expect(stats.lines).toBe(0)
    expect(stats.files).toEqual([])
  })
})

describe('computeTurnDiff — multi repo', () => {
  it('does not merge identical relative paths across repos (repo+path keying)', async () => {
    // Two sibling repos BOTH carry `src/index.ts` — a bare relative path would
    // collapse them into one file and under-count `fileCount`.
    const api = join(work, 'api')
    const ui = join(work, 'ui')
    initRepo(api)
    initRepo(ui)
    for (const repo of [api, ui]) {
      mkdirSync(join(repo, 'src'), { recursive: true })
      writeFileSync(join(repo, 'src', 'index.ts'), 'export const x = 1\n')
    }

    const base = await gitHeadCommits(work)
    const stats = await computeTurnDiff(work, base)

    expect(stats.fileCount).toBe(2)
    expect(stats.files).toContain('api/src/index.ts')
    expect(stats.files).toContain('ui/src/index.ts')
    expect(stats.diffText).toContain('# api')
    expect(stats.diffText).toContain('# ui')
  })

  it('single root repo keeps bare relative paths (no artificial repo prefix)', async () => {
    initRepo(work)
    const base = await gitHeadCommits(work)
    writeFileSync(join(work, 'a.ts'), 'export const a = 1\n')

    const stats = await computeTurnDiff(work, base)

    expect(stats.fileCount).toBe(1)
    expect(stats.files).toEqual(['a.ts'])
  })
})

describe('buildReverseSpec', () => {
  it('embeds intent content, changed files, the diff text and the pending-approval framing', () => {
    const intent = makeIntent({ content: 'change the thing' })
    const stats = {
      fileCount: 1,
      lines: 2,
      hasBinary: false,
      files: ['packages/api/src/index.ts'],
      diffText: '# packages/api\n1\t1\tpackages/api/src/index.ts',
    }
    const doc = buildReverseSpec(intent, stats, '2026-08-06T00:00:00.000Z')

    expect(doc).toContain('intent_id: i-1')
    expect(doc).toContain('change the thing')
    expect(doc).toContain('packages/api/src/index.ts')
    expect(doc).toContain('1 file(s) changed, 2 line(s)')
    expect(doc).toContain('pending human approval')
  })
})
