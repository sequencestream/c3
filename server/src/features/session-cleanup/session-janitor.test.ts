/**
 * Unit tests for the session janitor.
 *
 * Covers `runSessionPruneOnce`: cleanup is opt-in system-wide; when on, session
 * transcripts strictly older than the retention window are pruned from every
 * reachable store — c3's relay home root and the host codex/claude homes —
 * matched by the shared `sessions`/`projects` directory convention rather than a
 * vendor list, leaving sibling config, credential and state files untouched. Also
 * covers fail-soft behaviour and the start/stop timer lifecycle (single timer,
 * 24h re-schedule).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, utimesSync } from 'node:fs'

// Stub the config layer: c3HomeDir and the host vendor homes point into a temp
// tree; the cleanup decision is driven per test via the mutable holder.
const stub = vi.hoisted(() => ({
  home: '',
  codexHome: '',
  claudeHome: '',
  cleanup: { enabled: false, retentionDays: 30 },
  /** Path whose deletion the stubbed fs rejects (drives the fail-soft test). */
  blockedPath: '',
}))
// Real fs, except that removing `stub.blockedPath` fails — the only way to
// simulate an undeletable file portably (spying on the module is not allowed).
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    rmSync: (p: Parameters<typeof real.rmSync>[0], opts?: Parameters<typeof real.rmSync>[1]) => {
      if (stub.blockedPath && p === stub.blockedPath) {
        throw new Error('EPERM: operation not permitted')
      }
      return real.rmSync(p, opts)
    },
  }
})
vi.mock('../../kernel/config/index.js', () => ({
  c3HomeDir: vi.fn(() => stub.home),
  getSessionCleanup: vi.fn(() => stub.cleanup),
}))
vi.mock('../../kernel/config/workspace-path.js', () => ({
  hostCodexHome: vi.fn(() => stub.codexHome),
  hostClaudeConfigDir: vi.fn(() => stub.claudeHome),
}))

import { runSessionPruneOnce, startSessionJanitor, stopSessionJanitor } from './session-janitor.js'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

let root: string

/** Turn cleanup on with the given window. */
function enableCleanup(retentionDays = 7): void {
  stub.cleanup = { enabled: true, retentionDays }
}

/** Write `file` (creating parents) and stamp its mtime `ageDays` in the past. */
function writeAged(file: string, ageDays: number, now = NOW): string {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, '{}', 'utf-8')
  const t = (now - ageDays * DAY_MS) / 1000
  utimesSync(file, t, t)
  return file
}

/** A codex rollout inside the global relay codex home. */
function relayRollout(name: string, ageDays: number): string {
  const dir = join(root, 'relay', 'codex', 'sessions', '2026', '07', '16')
  return writeAged(join(dir, name), ageDays)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'c3-janitor-'))
  stub.home = root
  stub.codexHome = join(root, 'host-codex')
  stub.claudeHome = join(root, 'host-claude')
  stub.cleanup = { enabled: false, retentionDays: 30 }
  stub.blockedPath = ''
})

afterEach(() => {
  stopSessionJanitor()
  stub.blockedPath = ''
  rmSync(root, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('runSessionPruneOnce', () => {
  it('prunes nothing while cleanup is off, however old the sessions are', () => {
    const ancient = relayRollout('rollout-old.jsonl', 400)

    expect(runSessionPruneOnce({ now: NOW })).toBe(0)
    expect(existsSync(ancient)).toBe(true)
  })

  it('prunes sessions older than the window and keeps fresh ones once enabled', () => {
    enableCleanup(7)
    const stale = relayRollout('rollout-old.jsonl', 10)
    const fresh = relayRollout('rollout-new.jsonl', 2)

    expect(runSessionPruneOnce({ now: NOW })).toBe(1)
    expect(existsSync(stale)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('keeps a file sitting exactly on the cutoff (only strictly older is pruned)', () => {
    enableCleanup(7)
    const onCutoff = relayRollout('rollout-edge.jsonl', 7)

    expect(runSessionPruneOnce({ now: NOW })).toBe(0)
    expect(existsSync(onCutoff)).toBe(true)
  })

  it('sweeps the relay store regardless of which workspace wrote a session', () => {
    enableCleanup(7)
    // One global store: no workspace config is consulted, every rollout is swept.
    const a = relayRollout('rollout-thread-a.jsonl', 10)
    const b = relayRollout('rollout-thread-b.jsonl', 10)

    expect(runSessionPruneOnce({ now: NOW })).toBe(2)
    for (const f of [a, b]) expect(existsSync(f)).toBe(false)
  })

  it('sweeps the host codex and claude stores, not just the relay root', () => {
    enableCleanup(7)
    const codex = writeAged(join(stub.codexHome, 'sessions', '2026', '07', 'r.jsonl'), 10)
    const claude = writeAged(join(stub.claudeHome, 'projects', '-home-user-proj', 's.jsonl'), 10)

    expect(runSessionPruneOnce({ now: NOW })).toBe(2)
    expect(existsSync(codex)).toBe(false)
    expect(existsSync(claude)).toBe(false)
  })

  it('matches the session-dir convention, so an unknown vendor home is covered', () => {
    enableCleanup(7)
    // A vendor c3 has no code for: swept purely because it uses `sessions/`.
    const future = writeAged(join(root, 'relay', 'futurevendor', 'sessions', 'thread.jsonl'), 10)

    expect(runSessionPruneOnce({ now: NOW })).toBe(1)
    expect(existsSync(future)).toBe(false)
  })

  it('leaves config, credential and state files beside a session dir untouched', () => {
    enableCleanup(7)
    const home = join(root, 'relay', 'codex')
    const config = writeAged(join(home, 'config.toml'), 400)
    const auth = writeAged(join(stub.codexHome, 'auth.json'), 400)
    const state = writeAged(join(home, 'state_5.sqlite'), 400)
    const skill = writeAged(join(home, 'skills', 'demo', 'SKILL.md'), 400)
    const rollout = relayRollout('rollout-old.jsonl', 10)

    expect(runSessionPruneOnce({ now: NOW })).toBe(1)
    expect(existsSync(rollout)).toBe(false)
    for (const f of [config, auth, state, skill]) expect(existsSync(f)).toBe(true)
  })

  it('is fail-soft (returns 0) when no store root exists at all', () => {
    enableCleanup(7)
    rmSync(root, { recursive: true, force: true })

    expect(runSessionPruneOnce({ now: NOW })).toBe(0)
  })

  it('skips a file it cannot remove and keeps pruning the rest', () => {
    enableCleanup(7)
    const blocked = relayRollout('rollout-blocked.jsonl', 10)
    const other = relayRollout('rollout-other.jsonl', 10)
    stub.blockedPath = blocked

    // The blocked file throws mid-walk; the sweep continues and still removes the other.
    expect(() => runSessionPruneOnce({ now: NOW })).not.toThrow()
    expect(existsSync(blocked)).toBe(true)
    expect(existsSync(other)).toBe(false)
  })
})

describe('startSessionJanitor / stopSessionJanitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs a delayed first sweep, then re-schedules on a 24h cadence', () => {
    enableCleanup(7)
    startSessionJanitor()

    expect(vi.getTimerCount()).toBe(1) // exactly one pending timer
    vi.advanceTimersByTime(60_000) // initial delay elapses → first sweep
    expect(vi.getTimerCount()).toBe(1) // re-armed, still a single timer

    vi.advanceTimersByTime(24 * 60 * 60 * 1000) // next daily sweep
    expect(vi.getTimerCount()).toBe(1)
  })

  it('is idempotent — a second start replaces the prior timer', () => {
    startSessionJanitor()
    startSessionJanitor()
    expect(vi.getTimerCount()).toBe(1)
  })

  it('stop clears the pending timer and is safe to call twice', () => {
    startSessionJanitor()
    stopSessionJanitor()
    expect(vi.getTimerCount()).toBe(0)
    expect(() => stopSessionJanitor()).not.toThrow()
  })
})
