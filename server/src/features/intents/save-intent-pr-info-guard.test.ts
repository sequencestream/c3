/**
 * The DEPRECATION guard of `runSaveIntentPrInfo`.
 *
 * The tool is removed from every allowlist (automation tool set, built-in
 * templates, externally-grantable catalog), so no new authorization can be
 * created — but the core stays as the transitional implementation for whatever
 * path can still reach it. Its only locator is an intent id, and an intent may
 * now hold one PR per delivery, so the id addresses a SET.
 *
 * These tests pin the refusal: with several active PRs the tool errors and NAMES
 * them, and it writes nothing. A later change that softened this into "pick the
 * newest" would silently corrupt a real PR's status, which is strictly worse
 * than not writing at all — that is the regression this file exists to catch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Identity id↔path mapping: synthetic test workspaces are unregistered, so the
// in-project guard would otherwise never resolve.
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))
import { resetDbForTests } from '../../kernel/infra/db.js'
import { runSaveIntentPrInfo, saveIntentPrInfoDesc } from './tool-defs.js'
import {
  getIntent,
  insertIntents,
  listIntentPrs,
  resetStoreForTests,
  upsertIntentPr,
} from './store.js'

let dir: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-save-pr-info-'))
  // The intent store keys on the resolved path, and the mocked mapping is
  // identity — so the project path must BE the temp dir for the guard to match.
  proj = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  resetStoreForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

const noop = (): void => {}

/** One intent with `count` active (reviewing) PRs, each toward its own delivery. */
function intentWithActivePrs(count: number): string {
  const [intent] = insertIntents(proj, [
    { title: '多 PR 意图', shortEnTitle: 'multi-pr', content: 'x', priority: 'P1' },
  ])
  for (let i = 0; i < count; i++) {
    upsertIntentPr({
      intentId: intent.id,
      deliveryId: `delivery-${i}`,
      forge: 'github',
      repo: 'o/r',
      number: String(100 + i),
      status: 'reviewing',
    })
  }
  return intent.id
}

describe('runSaveIntentPrInfo — the multi-PR refusal', () => {
  it('refuses when the intent holds several active PRs, and names every one', () => {
    const id = intentWithActivePrs(3)
    const res = runSaveIntentPrInfo(proj, { intentId: id, prStatus: 'merged', done: true }, noop)

    expect(res.isError).toBe(true)
    const message = res.content[0].text
    expect(message).toContain('3 条活跃 PR')
    // Naming them is the point: the caller must be able to act on the refusal.
    expect(message).toContain('#100')
    expect(message).toContain('#101')
    expect(message).toContain('#102')
  })

  it('writes NOTHING on that refusal — no PR status moved, no intent marked done', () => {
    const id = intentWithActivePrs(2)
    runSaveIntentPrInfo(proj, { intentId: id, prStatus: 'merged', done: true }, noop)

    expect(listIntentPrs(id).map((pr) => pr.status)).toEqual(['reviewing', 'reviewing'])
    expect(getIntent(id)!.status).not.toBe('done')
  })

  it('does not fire the broadcast callback on that refusal', () => {
    const id = intentWithActivePrs(2)
    const onSaved = vi.fn()
    runSaveIntentPrInfo(proj, { intentId: id, prStatus: 'closed' }, onSaved)
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('still reconciles the unambiguous single-PR case during the transition', () => {
    const id = intentWithActivePrs(1)
    const onSaved = vi.fn()
    const res = runSaveIntentPrInfo(proj, { intentId: id, prStatus: 'merged', done: true }, onSaved)

    expect(res.isError).toBeUndefined()
    expect(listIntentPrs(id)[0].status).toBe('merged')
    expect(getIntent(id)!.status).toBe('done')
    expect(onSaved).toHaveBeenCalledWith(proj)
  })

  it('still refuses an intent with no PR at all (it can never mint a row)', () => {
    const [intent] = insertIntents(proj, [
      { title: '无 PR', shortEnTitle: 'no-pr', content: 'x', priority: 'P2' },
    ])
    const res = runSaveIntentPrInfo(proj, { intentId: intent.id, prStatus: 'merged' }, noop)
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('尚无 PR')
  })

  it('advertises itself as deprecated with the replacement path', () => {
    // Whatever still reaches the tool must read, in the description itself, that
    // it is going away and what to use instead.
    expect(saveIntentPrInfoDesc).toContain('已废弃')
    expect(saveIntentPrInfoDesc).toContain('pr:update')
    expect(saveIntentPrInfoDesc).toContain('find_intents')
  })
})
