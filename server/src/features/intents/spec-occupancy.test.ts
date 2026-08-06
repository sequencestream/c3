/**
 * Spec-phase occupancy — the owner-safe, persistent slot an intent's spec
 * authoring / review session holds from launch until it truly ends.
 *
 * Covers the three lifecycle facts the queue and the launchers depend on:
 *   - a claim only wins an empty (or stale) slot, and writes BOTH the pending
 *     projection row and the `spec_session_id` / `spec_review_session_id` field;
 *   - release / replace are conditional — they only act when the field still
 *     equals the caller's pending id, so an old run can never release a new
 *     owner's occupancy;
 *   - `isSpecOccupancyAlive` projects a pending id as occupied while its run is
 *     live or its projection row is within the grace window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import type { SessionRuntime } from '../../runs.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { ensureRuntime, getRuntime, removeRuntimesForWorkspace } from '../../runs.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import {
  getIntent,
  insertIntents,
  resetStoreForTests,
  setSpecReviewSessionId,
  setSpecSessionId,
} from './store.js'
import {
  getByC3Id,
  resetStoreForTests as resetSessionMetadata,
  setNow,
  upsertPendingRow,
} from '../sessions/session-metadata-store.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import {
  claimSpecOccupancy,
  claimSpecReviewOccupancy,
  isSpecOccupancyAlive,
  releaseSpecOccupancy,
  releaseSpecReviewOccupancy,
  replaceSpecOccupancy,
  replaceSpecReviewOccupancy,
  SPEC_OCCUPANCY_GRACE_MS,
} from './spec-occupancy.js'

let dir: string
let workspaceId: string
let proj: string

const pending = (tag: string): string => `${PENDING_SESSION_PREFIX}${tag}`

function rowFor(intentTitle: string): Parameters<typeof claimSpecOccupancy>[2] {
  return { workspacePath: proj, vendor: 'claude', agentId: 'spec-agent', title: intentTitle }
}

function markRunning(sessionId: string): void {
  const rt = getRuntime(sessionId)!
  rt.run = { abort: new AbortController(), handle: null } as SessionRuntime['run']
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-spec-occupancy-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetStoreForTests()
  resetSessionMetadata()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  addWorkspace(dir, 1)
  workspaceId = pathToId(dir)!
  proj = resolveWorkspaceRoot(workspaceId)!
})

afterEach(() => {
  removeRuntimesForWorkspace(proj)
  resetDbForTests()
  resetSessionMetadata()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('claimSpecOccupancy — authoring slot', () => {
  it('claims an empty slot: writes the pending projection row AND spec_session_id', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Occupied', shortEnTitle: 'occ', content: '', priority: 'P1' },
    ])
    const id = pending('one')

    const claim = claimSpecOccupancy(intent.id, id, rowFor(intent.title))

    expect(claim).toEqual({ ok: true, owner: null })
    expect(getIntent(intent.id)?.specSessionId).toBe(id)
    // The projection row is written atomically with the claim, so the pending id
    // in the ledger always has a timestamp to time its staleness from.
    expect(getByC3Id(id)).toMatchObject({
      kind: 'pending',
      ownerKind: 'intent',
      ownerId: intent.id,
    })
  })

  it('refuses a second claim while a live pending run holds the slot', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Occupied', shortEnTitle: 'occ', content: '', priority: 'P1' },
    ])
    const held = pending('held')
    setSpecSessionId(intent.id, held)
    ensureRuntime(held, proj, 'default', [], 'spec')
    markRunning(held)

    const claim = claimSpecOccupancy(intent.id, pending('new'), rowFor(intent.title))

    expect(claim).toEqual({ ok: false, owner: held })
    expect(getIntent(intent.id)?.specSessionId).toBe(held)
  })

  it('refuses a claim while a still-fresh pending holds the slot (bind not arrived)', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Occupied', shortEnTitle: 'occ', content: '', priority: 'P1' },
    ])
    const held = pending('fresh')
    setSpecSessionId(intent.id, held)
    // A launch wrote the projection row but the run has not started executing
    // yet — the occupancy is still valid.
    upsertPendingRow({
      pendingId: held,
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'spec-agent',
      title: intent.title,
      ownerKind: 'intent',
      ownerId: intent.id,
    })

    const claim = claimSpecOccupancy(intent.id, pending('new'), rowFor(intent.title))

    expect(claim).toEqual({ ok: false, owner: held })
  })

  it('refuses a claim while a real (bound) authoring session owns the slot', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Occupied', shortEnTitle: 'occ', content: '', priority: 'P1' },
    ])
    setSpecSessionId(intent.id, 'real-bound')

    const claim = claimSpecOccupancy(intent.id, pending('new'), rowFor(intent.title))

    expect(claim).toEqual({ ok: false, owner: 'real-bound' })
  })

  it('claims over a stale pending whose launch died past the grace window', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Occupied', shortEnTitle: 'occ', content: '', priority: 'P1' },
    ])
    const stale = pending('stale')
    setSpecSessionId(intent.id, stale)
    const launchAt = Date.now() - SPEC_OCCUPANCY_GRACE_MS - 1_000
    setNow(() => launchAt)
    upsertPendingRow({
      pendingId: stale,
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'spec-agent',
      title: intent.title,
      ownerKind: 'intent',
      ownerId: intent.id,
    })
    setNow(() => Date.now())

    const claim = claimSpecOccupancy(intent.id, pending('new'), rowFor(intent.title))

    expect(claim).toEqual({ ok: true, owner: null })
    expect(getIntent(intent.id)?.specSessionId).toBe(pending('new'))
  })
})

describe('claimSpecReviewOccupancy — review slot', () => {
  it('claims an empty review slot', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Reviewed', shortEnTitle: 'rev', content: '', priority: 'P1' },
    ])
    const id = pending('rev-one')

    const claim = claimSpecReviewOccupancy(intent.id, id, rowFor(intent.title))

    expect(claim).toEqual({ ok: true, owner: null })
    expect(getIntent(intent.id)?.specReviewSessionId).toBe(id)
    expect(getByC3Id(id)).toMatchObject({ kind: 'pending', ownerId: intent.id })
  })

  it('replaces a finished real review (one-shot per document version)', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Reviewed', shortEnTitle: 'rev', content: '', priority: 'P1' },
    ])
    setSpecReviewSessionId(intent.id, 'real-old-review')

    const claim = claimSpecReviewOccupancy(intent.id, pending('rev-two'), rowFor(intent.title))

    expect(claim).toEqual({ ok: true, owner: null })
    expect(getIntent(intent.id)?.specReviewSessionId).toBe(pending('rev-two'))
  })

  it('refuses a claim while a live review holds the slot', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Reviewed', shortEnTitle: 'rev', content: '', priority: 'P1' },
    ])
    setSpecReviewSessionId(intent.id, 'real-live-review')
    ensureRuntime('real-live-review', proj, 'default', [], 'spec_review')
    markRunning('real-live-review')

    const claim = claimSpecReviewOccupancy(intent.id, pending('rev-two'), rowFor(intent.title))

    expect(claim).toEqual({ ok: false, owner: 'real-live-review' })
  })
})

describe('release / replace — owner-safe conditional writes', () => {
  it('releaseSpecOccupancy clears only when the field still equals the pending id', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Occupied', shortEnTitle: 'occ', content: '', priority: 'P1' },
    ])
    setSpecSessionId(intent.id, pending('mine'))

    releaseSpecOccupancy(intent.id, pending('someone-else'))
    expect(getIntent(intent.id)?.specSessionId).toBe(pending('mine'))

    releaseSpecOccupancy(intent.id, pending('mine'))
    expect(getIntent(intent.id)?.specSessionId).toBeNull()
  })

  it('releaseSpecReviewOccupancy clears only when the field still equals the pending id', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Reviewed', shortEnTitle: 'rev', content: '', priority: 'P1' },
    ])
    setSpecReviewSessionId(intent.id, pending('mine'))

    releaseSpecReviewOccupancy(intent.id, pending('someone-else'))
    expect(getIntent(intent.id)?.specReviewSessionId).toBe(pending('mine'))

    releaseSpecReviewOccupancy(intent.id, pending('mine'))
    expect(getIntent(intent.id)?.specReviewSessionId).toBeNull()
  })

  it('replaceSpecOccupancy replaces only when the field still equals the expected pending', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Occupied', shortEnTitle: 'occ', content: '', priority: 'P1' },
    ])
    setSpecSessionId(intent.id, pending('mine'))

    replaceSpecOccupancy(intent.id, pending('other'), 'real-other')
    expect(getIntent(intent.id)?.specSessionId).toBe(pending('mine'))

    replaceSpecOccupancy(intent.id, pending('mine'), 'real-mine')
    expect(getIntent(intent.id)?.specSessionId).toBe('real-mine')
  })

  it('replaceSpecReviewOccupancy replaces only when the field still equals the expected pending', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Reviewed', shortEnTitle: 'rev', content: '', priority: 'P1' },
    ])
    setSpecReviewSessionId(intent.id, pending('mine'))

    replaceSpecReviewOccupancy(intent.id, pending('other'), 'real-other')
    expect(getIntent(intent.id)?.specReviewSessionId).toBe(pending('mine'))

    replaceSpecReviewOccupancy(intent.id, pending('mine'), 'real-mine')
    expect(getIntent(intent.id)?.specReviewSessionId).toBe('real-mine')
  })
})

describe('isSpecOccupancyAlive — the fact the queue probe consumes', () => {
  it('a live run is alive whatever the id', () => {
    const live = pending('live')
    ensureRuntime(live, proj, 'default', [], 'spec')
    markRunning(live)
    expect(isSpecOccupancyAlive(live, (id) => getRuntime(id)?.run != null, Date.now())).toBe(true)
  })

  it('a real (bound) id with no live run is NOT alive — it is resumable, not running', () => {
    expect(isSpecOccupancyAlive('real-bound', () => false, Date.now())).toBe(false)
  })

  it('a pending within the grace window is alive even with no live run (restart recovery)', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Reviewed', shortEnTitle: 'rev', content: '', priority: 'P1' },
    ])
    const id = pending('fresh')
    setSpecSessionId(intent.id, id)
    const now = Date.now()
    setNow(() => now - 10_000)
    upsertPendingRow({
      pendingId: id,
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'spec-agent',
      title: intent.title,
      ownerKind: 'intent',
      ownerId: intent.id,
    })
    setNow(() => now)

    expect(isSpecOccupancyAlive(id, () => false, now)).toBe(true)
  })

  it('a pending whose projection row aged past the grace window is NOT alive', () => {
    const [intent] = insertIntents(proj, [
      { title: 'Reviewed', shortEnTitle: 'rev', content: '', priority: 'P1' },
    ])
    const id = pending('stale')
    setSpecSessionId(intent.id, id)
    const now = Date.now()
    setNow(() => now - SPEC_OCCUPANCY_GRACE_MS - 1_000)
    upsertPendingRow({
      pendingId: id,
      workspacePath: proj,
      vendor: 'claude',
      agentId: 'spec-agent',
      title: intent.title,
      ownerKind: 'intent',
      ownerId: intent.id,
    })
    setNow(() => now)

    expect(isSpecOccupancyAlive(id, () => false, now)).toBe(false)
  })
})
