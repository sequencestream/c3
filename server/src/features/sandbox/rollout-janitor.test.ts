/**
 * Unit tests for the sandbox rollout janitor.
 *
 * Covers `runRolloutPruneOnce`: prunes rollout files older than a workspace's
 * retention window from the persistent per-workspace CODEX_HOME, keeps fresh
 * ones, applies the default window to unconfigured (orphan) dirs, and is
 * fail-soft when the sandbox-home root is absent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs'

// Stub the config layer: c3HomeDir points at a temp dir; the retention lookups
// are driven per test via the mutable holder.
const stub = vi.hoisted(() => ({
  home: '',
  configured: [] as string[],
  retentionByPath: new Map<string, number>(),
}))
vi.mock('../../kernel/config/index.js', () => ({
  c3HomeDir: vi.fn(() => stub.home),
  listConfiguredWorkspacePaths: vi.fn(() => stub.configured),
  getSandboxRetentionDays: vi.fn((ws: string) => stub.retentionByPath.get(ws) ?? 30),
  DEFAULT_SANDBOX_RETENTION_DAYS: 30,
}))
// projectDirName is a pure helper; import the real one indirectly is fine, but it
// imports c3HomeDir from index — mock it too to avoid the cycle.
vi.mock('../../kernel/config/workspace-path.js', () => ({
  projectDirName: (p: string) => p.replace(/^\/+/, '').replace(/[/:]/g, '-'),
}))

import { runRolloutPruneOnce } from './rollout-janitor.js'

const DAY_MS = 24 * 60 * 60 * 1000

let root: string

/** Create a rollout file and stamp its mtime `ageDays` in the past. */
function makeRollout(dirSegment: string, name: string, ageDays: number, now: number): string {
  const dir = join(root, 'sandbox-home', dirSegment, '.codex', 'sessions', '2026', '07', '16')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, '{}', 'utf-8')
  const t = (now - ageDays * DAY_MS) / 1000
  utimesSync(file, t, t)
  return file
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'c3-janitor-'))
  stub.home = root
  stub.configured = []
  stub.retentionByPath = new Map()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('runRolloutPruneOnce', () => {
  it('prunes rollouts older than the workspace retention window, keeps fresh ones', () => {
    const now = 1_800_000_000_000
    const ws = '/home/user/project'
    const seg = 'home-user-project'
    stub.configured = [ws]
    stub.retentionByPath.set(ws, 7)
    const stale = makeRollout(seg, 'rollout-old.jsonl', 10, now) // older than 7d
    const fresh = makeRollout(seg, 'rollout-new.jsonl', 2, now) // within 7d

    const removed = runRolloutPruneOnce({ now })

    expect(removed).toBe(1)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('applies the default window (30d) to an orphan dir with no matching config', () => {
    const now = 1_800_000_000_000
    // No configured workspace maps to this dir → default 30d applies.
    const old = makeRollout('orphan-project', 'rollout-old.jsonl', 40, now)
    const recent = makeRollout('orphan-project', 'rollout-recent.jsonl', 20, now)

    const removed = runRolloutPruneOnce({ now })

    expect(removed).toBe(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })

  it('is fail-soft (returns 0) when the sandbox-home root does not exist', () => {
    rmSync(root, { recursive: true, force: true })
    expect(runRolloutPruneOnce({ now: 1_800_000_000_000 })).toBe(0)
  })
})
