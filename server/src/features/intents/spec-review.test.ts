/**
 * Spec review — the data contract behind the read-only reviewer.
 *
 * These cases pin the rules that decide whether a conclusion is allowed to
 * influence a gate at all: it must be bound to the spec content actually judged,
 * it must be counted exactly once, and a human veto must survive the next tick.
 * Everything here runs against the real store, because the guarantees being
 * asserted (atomicity, idempotency) live in its transactions.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MACHINE_SPEC_APPROVER, MAX_SPEC_REVIEW_REWORK_ROUNDS } from '@ccc/shared/protocol'

const specsRoot = mkdtempSync(join(tmpdir(), 'c3-spec-review-'))

vi.mock('./specs-root.js', () => ({
  getSpecsBase: () => specsRoot,
  resolveSpecFileAbs: (_ws: string, p: string) => p,
}))

const { resetDbForTests } = await import('../../kernel/infra/db.js')
const {
  getIntent,
  insertIntents,
  machineApproveSpec,
  recordSpecReview,
  resetStoreForTests,
  revokeSpecApproval,
  setSpecApproved,
  setSpecPath,
} = await import('./store.js')
const { readSpecFingerprint, runSubmitSpecReview, specFingerprint } =
  await import('./spec-review.js')

const WS = '/tmp/spec-review-ws'

/** Seed one intent with an authored spec file on disk; returns its id. */
function seedIntent(specBody: string): string {
  const [intent] = insertIntents(WS, [
    { title: 'reviewed intent', shortEnTitle: 'reviewed', content: 'body', priority: 'P1' },
  ])
  const file = join(specsRoot, `${intent.id}.md`)
  writeFileSync(file, specBody, 'utf8')
  setSpecPath(intent.id, file)
  return intent.id
}

describe('specFingerprint / readSpecFingerprint', () => {
  beforeEach(() => {
    process.env.C3_DB_PATH = join(specsRoot, `db-${Math.random().toString(36).slice(2)}.sqlite`)
    resetDbForTests()
    resetStoreForTests()
  })
  afterEach(() => {
    delete process.env.C3_DB_PATH
  })

  it('is stable for identical content and differs for changed content', () => {
    expect(specFingerprint('a')).toBe(specFingerprint('a'))
    expect(specFingerprint('a')).not.toBe(specFingerprint('a '))
  })

  it('reads null for a missing path and for an unreadable file — never an empty hash', () => {
    expect(readSpecFingerprint(WS, null)).toBeNull()
    expect(readSpecFingerprint(WS, join(specsRoot, 'does-not-exist.md'))).toBeNull()
  })
})

describe('recordSpecReview — one conclusion, counted once, bound to content', () => {
  beforeEach(() => {
    process.env.C3_DB_PATH = join(specsRoot, `db-${Math.random().toString(36).slice(2)}.sqlite`)
    resetDbForTests()
    resetStoreForTests()
  })
  afterEach(() => {
    delete process.env.C3_DB_PATH
  })

  it('records a pass and leaves the rework counter alone', () => {
    const id = seedIntent('v1')
    const fp = specFingerprint('v1')
    expect(
      recordSpecReview({
        intentId: id,
        sessionId: 'rev-1',
        verdict: 'pass',
        reason: 'looks good',
        fingerprint: fp,
        liveFingerprint: fp,
      }),
    ).toBe('applied')
    const after = getIntent(id)!
    expect(after.specReviewVerdict).toBe('pass')
    expect(after.specReviewReason).toBe('looks good')
    expect(after.specReviewSessionId).toBe('rev-1')
    expect(after.specReviewFingerprint).toBe(fp)
    expect(after.specReviewReworkRounds).toBe(0)
  })

  it('advances the rework counter by exactly one per NEW changes_requested', () => {
    const id = seedIntent('v1')
    const fp1 = specFingerprint('v1')
    recordSpecReview({
      intentId: id,
      sessionId: 'r1',
      verdict: 'changes_requested',
      reason: 'missing X',
      fingerprint: fp1,
      liveFingerprint: fp1,
    })
    expect(getIntent(id)!.specReviewReworkRounds).toBe(1)

    // A revised spec reviewed again: a second, distinct conclusion.
    writeFileSync(getIntent(id)!.specPath!, 'v2', 'utf8')
    const fp2 = specFingerprint('v2')
    recordSpecReview({
      intentId: id,
      sessionId: 'r2',
      verdict: 'changes_requested',
      reason: 'still missing X',
      fingerprint: fp2,
      liveFingerprint: fp2,
    })
    expect(getIntent(id)!.specReviewReworkRounds).toBe(2)
  })

  it('treats a repeat of the SAME conclusion as a duplicate: no second count', () => {
    const id = seedIntent('v1')
    const fp = specFingerprint('v1')
    const args = {
      intentId: id,
      sessionId: 'r1',
      verdict: 'changes_requested' as const,
      reason: 'missing X',
      fingerprint: fp,
      liveFingerprint: fp,
    }
    expect(recordSpecReview(args)).toBe('applied')
    expect(recordSpecReview(args)).toBe('duplicate')
    expect(recordSpecReview(args)).toBe('duplicate')
    expect(getIntent(id)!.specReviewReworkRounds).toBe(1)
  })

  it('rejects a stale conclusion rather than interpreting it', () => {
    const id = seedIntent('v1')
    expect(
      recordSpecReview({
        intentId: id,
        sessionId: 'r1',
        verdict: 'pass',
        reason: 'judged the old text',
        fingerprint: specFingerprint('v1'),
        liveFingerprint: specFingerprint('v2-edited-mid-review'),
      }),
    ).toBe('stale')
    const after = getIntent(id)!
    expect(after.specReviewVerdict).toBeNull()
    expect(after.specReviewReworkRounds).toBe(0)
  })

  it('rejects a conclusion for an unknown intent', () => {
    expect(
      recordSpecReview({
        intentId: 'no-such-intent',
        sessionId: null,
        verdict: 'pass',
        reason: 'x',
        fingerprint: 'fp',
        liveFingerprint: 'fp',
      }),
    ).toBe('unknown')
  })

  it('a NEW conclusion lifts a prior human veto', () => {
    const id = seedIntent('v1')
    const fp1 = specFingerprint('v1')
    recordSpecReview({
      intentId: id,
      sessionId: 'r1',
      verdict: 'pass',
      reason: 'ok',
      fingerprint: fp1,
      liveFingerprint: fp1,
    })
    setSpecApproved(id, true, MACHINE_SPEC_APPROVER)
    revokeSpecApproval(id)
    expect(getIntent(id)!.specReviewMachineApprovalBlocked).toBe(true)

    writeFileSync(getIntent(id)!.specPath!, 'v2', 'utf8')
    const fp2 = specFingerprint('v2')
    recordSpecReview({
      intentId: id,
      sessionId: 'r2',
      verdict: 'pass',
      reason: 'ok again',
      fingerprint: fp2,
      liveFingerprint: fp2,
    })
    expect(getIntent(id)!.specReviewMachineApprovalBlocked).toBe(false)
  })
})

describe('machineApproveSpec — a conditional write, not a trusted one', () => {
  beforeEach(() => {
    process.env.C3_DB_PATH = join(specsRoot, `db-${Math.random().toString(36).slice(2)}.sqlite`)
    resetDbForTests()
    resetStoreForTests()
  })
  afterEach(() => {
    delete process.env.C3_DB_PATH
  })

  function passingIntent(): { id: string; fp: string } {
    const id = seedIntent('v1')
    const fp = specFingerprint('v1')
    recordSpecReview({
      intentId: id,
      sessionId: 'r1',
      verdict: 'pass',
      reason: 'ok',
      fingerprint: fp,
      liveFingerprint: fp,
    })
    return { id, fp }
  }

  it('approves under a matching pass, writing the machine identity', () => {
    const { id, fp } = passingIntent()
    expect(machineApproveSpec(id, fp, MACHINE_SPEC_APPROVER)).toBe(true)
    const after = getIntent(id)!
    expect(after.specApproved).toBe(true)
    expect(after.specApproveUser).toBe(MACHINE_SPEC_APPROVER)
  })

  it('refuses on a fingerprint that no longer matches the conclusion', () => {
    const { id } = passingIntent()
    expect(machineApproveSpec(id, 'some-other-fingerprint', MACHINE_SPEC_APPROVER)).toBe(false)
    expect(getIntent(id)!.specApproved).toBe(false)
  })

  it('refuses on a changes_requested conclusion', () => {
    const id = seedIntent('v1')
    const fp = specFingerprint('v1')
    recordSpecReview({
      intentId: id,
      sessionId: 'r1',
      verdict: 'changes_requested',
      reason: 'nope',
      fingerprint: fp,
      liveFingerprint: fp,
    })
    expect(machineApproveSpec(id, fp, MACHINE_SPEC_APPROVER)).toBe(false)
    expect(getIntent(id)!.specApproved).toBe(false)
  })

  it('refuses once a human has vetoed this conclusion', () => {
    const { id, fp } = passingIntent()
    machineApproveSpec(id, fp, MACHINE_SPEC_APPROVER)
    revokeSpecApproval(id)
    // The very next tick would retry with the identical facts — and must fail.
    expect(machineApproveSpec(id, fp, MACHINE_SPEC_APPROVER)).toBe(false)
    expect(getIntent(id)!.specApproved).toBe(false)
  })

  it('is idempotent: an already-approved spec is not re-approved', () => {
    const { id, fp } = passingIntent()
    expect(machineApproveSpec(id, fp, MACHINE_SPEC_APPROVER)).toBe(true)
    expect(machineApproveSpec(id, fp, MACHINE_SPEC_APPROVER)).toBe(false)
  })
})

describe('revokeSpecApproval', () => {
  beforeEach(() => {
    process.env.C3_DB_PATH = join(specsRoot, `db-${Math.random().toString(36).slice(2)}.sqlite`)
    resetDbForTests()
    resetStoreForTests()
  })
  afterEach(() => {
    delete process.env.C3_DB_PATH
  })

  it('clears approval + identity and vetoes the standing conclusion', () => {
    const id = seedIntent('v1')
    setSpecApproved(id, true, 'alice')
    expect(revokeSpecApproval(id)).toBe(true)
    const after = getIntent(id)!
    expect(after.specApproved).toBe(false)
    expect(after.specApproveUser).toBeNull()
    expect(after.specReviewMachineApprovalBlocked).toBe(true)
  })

  it('is a no-op on an unapproved intent, so a double-click writes nothing twice', () => {
    const id = seedIntent('v1')
    expect(revokeSpecApproval(id)).toBe(false)
    expect(getIntent(id)!.specReviewMachineApprovalBlocked).toBe(false)
  })
})

describe('runSubmitSpecReview — the reviewer-facing tool', () => {
  beforeEach(() => {
    process.env.C3_DB_PATH = join(specsRoot, `db-${Math.random().toString(36).slice(2)}.sqlite`)
    resetDbForTests()
    resetStoreForTests()
  })
  afterEach(() => {
    delete process.env.C3_DB_PATH
  })

  it('records a conclusion for the intent bound at launch', () => {
    const id = seedIntent('v1')
    const r = runSubmitSpecReview(
      WS,
      { intentId: id, sessionId: 'rev-1', fingerprint: specFingerprint('v1') },
      { verdict: 'pass', reason: '  grounded and verifiable  ' },
    )
    expect(r.isError).toBeUndefined()
    const after = getIntent(id)!
    expect(after.specReviewVerdict).toBe('pass')
    // The reason is trimmed — it is handed to the author verbatim as a brief.
    expect(after.specReviewReason).toBe('grounded and verifiable')
  })

  it('errors — and records nothing — when the spec changed under the review', () => {
    const id = seedIntent('v1')
    const launchedAgainst = specFingerprint('v1')
    writeFileSync(getIntent(id)!.specPath!, 'edited while the reviewer was reading', 'utf8')

    const r = runSubmitSpecReview(
      WS,
      { intentId: id, sessionId: 'rev-1', fingerprint: launchedAgainst },
      { verdict: 'pass', reason: 'judged the old text' },
    )
    expect(r.isError).toBe(true)
    expect(getIntent(id)!.specReviewVerdict).toBeNull()
  })

  it('errors when the bound intent is gone', () => {
    const r = runSubmitSpecReview(
      WS,
      { intentId: 'vanished', sessionId: null, fingerprint: 'fp' },
      { verdict: 'pass', reason: 'x' },
    )
    expect(r.isError).toBe(true)
  })

  it('reports a duplicate without erroring and without counting it again', () => {
    const id = seedIntent('v1')
    const facts = { intentId: id, sessionId: 'rev-1', fingerprint: specFingerprint('v1') }
    const args = { verdict: 'changes_requested' as const, reason: 'missing X' }
    expect(runSubmitSpecReview(WS, facts, args).isError).toBeUndefined()
    const second = runSubmitSpecReview(WS, facts, args)
    expect(second.isError).toBeUndefined()
    expect(getIntent(id)!.specReviewReworkRounds).toBe(1)
  })
})

describe('the rework cap is a shared constant, not a local literal', () => {
  it('is a positive, finite bound', () => {
    expect(MAX_SPEC_REVIEW_REWORK_ROUNDS).toBeGreaterThan(0)
    expect(Number.isFinite(MAX_SPEC_REVIEW_REWORK_ROUNDS)).toBe(true)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Best-effort cleanup of the temp specs root.
process.on('exit', () => {
  try {
    rmSync(specsRoot, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})
