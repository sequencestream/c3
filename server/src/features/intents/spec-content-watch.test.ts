/**
 * Spec content watch — the write boundary where `raw` becomes `pending`.
 *
 * The watch captures the document's fingerprint before an authoring run and
 * evaluates it once the run settles. This file pins the one rule that matters:
 * only an ACTUAL content change moves the status, and unreadable / unchanged /
 * unwatched runs leave it exactly where it was.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  getIntent,
  insertIntents,
  resetStoreForTests,
  setSpecPath,
  setSpecApproved,
} from './store.js'
import { specFingerprint } from './spec-review.js'
import {
  armSpecContentWatch,
  clearSpecContentWatch,
  resetForTests,
  settleSpecContentWatch,
} from './spec-content-watch.js'

let dir: string
const proj = '/abs/project-a'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-spec-watch-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  resetForTests()
})

afterEach(() => {
  resetForTests()
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

/** Seed an intent's spec path and return { id, file } with a written seed file. */
function seedIntent(body: string): { id: string; file: string } {
  const [r] = insertIntents(proj, [
    { title: 'Watched', shortEnTitle: 'watched', content: '', priority: 'P1' },
  ])
  const file = join(dir, 'spec.md')
  writeFileSync(file, body, 'utf8')
  setSpecPath(r.id, file)
  return { id: r.id, file }
}

describe('settleSpecContentWatch', () => {
  it('promotes raw → pending only when the content actually changed', () => {
    const { id, file } = seedIntent('_(to be authored)_')
    armSpecContentWatch({
      intentId: id,
      workspacePath: proj,
      specPath: file,
      fingerprint: specFingerprint('_(to be authored)_'),
    })
    writeFileSync(file, 'The real spec.', 'utf8')

    expect(settleSpecContentWatch(id)).toBe('promoted')
    expect(getIntent(id)?.specStatus).toBe('pending')
    expect(getIntent(id)?.specApproved).toBe(false)
    expect(getIntent(id)?.specApproveUser).toBeNull()
  })

  it('leaves a raw spec raw when the run wrote nothing', () => {
    const { id, file } = seedIntent('_(to be authored)_')
    armSpecContentWatch({
      intentId: id,
      workspacePath: proj,
      specPath: file,
      fingerprint: specFingerprint('_(to be authored)_'),
    })
    // The agent never wrote the file (it may also have failed) — still the seed.
    expect(settleSpecContentWatch(id)).toBe('unchanged')
    expect(getIntent(id)?.specStatus).toBe('raw')
  })

  it('leaves a raw spec raw when the file is unreadable — unreadable is not changed', () => {
    const { id, file } = seedIntent('_(to be authored)_')
    armSpecContentWatch({
      intentId: id,
      workspacePath: proj,
      specPath: file,
      fingerprint: specFingerprint('_(to be authored)_'),
    })
    // The read fails (e.g. the ledger path points at a file that is gone).
    expect(settleSpecContentWatch(id, () => null)).toBe('unreadable')
    expect(getIntent(id)?.specStatus).toBe('raw')
  })

  it('rewrites an approved spec back to pending (reopened) with the approver cleared', () => {
    const { id, file } = seedIntent('v1')
    setSpecApproved(id, true, 'alice')
    expect(getIntent(id)?.specStatus).toBe('approved')

    armSpecContentWatch({
      intentId: id,
      workspacePath: proj,
      specPath: file,
      fingerprint: specFingerprint('v1'),
    })
    writeFileSync(file, 'v2', 'utf8')

    expect(settleSpecContentWatch(id)).toBe('reopened')
    expect(getIntent(id)?.specStatus).toBe('pending')
    expect(getIntent(id)?.specApproved).toBe(false)
    expect(getIntent(id)?.specApproveUser).toBeNull()
  })

  it('does not demote a pending spec whose content later resembles the seed', () => {
    const { id, file } = seedIntent('real v1')
    armSpecContentWatch({
      intentId: id,
      workspacePath: proj,
      specPath: file,
      fingerprint: specFingerprint('real v1'),
    })
    writeFileSync(file, 'real v2', 'utf8')
    expect(settleSpecContentWatch(id)).toBe('promoted')
    expect(getIntent(id)?.specStatus).toBe('pending')

    // A later run that writes the seed back verbatim must NOT return to raw.
    armSpecContentWatch({
      intentId: id,
      workspacePath: proj,
      specPath: file,
      fingerprint: specFingerprint('real v2'),
    })
    writeFileSync(file, '_(to be authored)_', 'utf8')
    expect(settleSpecContentWatch(id)).toBe('unchanged')
    expect(getIntent(id)?.specStatus).toBe('pending')
  })

  it('is a no-op for an unwatched intent', () => {
    const { id } = seedIntent('x')
    expect(settleSpecContentWatch(id)).toBe('no_watch')
  })

  it('clearSpecContentWatch drops the watch without evaluating it', () => {
    const { id, file } = seedIntent('_(to be authored)_')
    armSpecContentWatch({
      intentId: id,
      workspacePath: proj,
      specPath: file,
      fingerprint: specFingerprint('_(to be authored)_'),
    })
    writeFileSync(file, 'The real spec.', 'utf8')
    clearSpecContentWatch(id)
    expect(settleSpecContentWatch(id)).toBe('no_watch')
    expect(getIntent(id)?.specStatus).toBe('raw')
  })
})
