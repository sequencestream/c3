/**
 * TEST-ONLY fixture builder for `Intent.prs`.
 *
 * Most tests care about one thing — "this intent has a PR in state X" — and not
 * about the row's id, origin or timestamps. Building the full {@link IntentPr}
 * inline at every fixture site would bury that one fact in twelve fields of
 * noise, so it is built here once. Nothing in the runtime imports this module.
 */
import type { IntentPr, IntentPrStatus } from '@ccc/shared/protocol'

let seq = 0

/** One PR row in `status`, with plausible defaults for everything else. */
export function fakeIntentPr(status: IntentPrStatus, overrides: Partial<IntentPr> = {}): IntentPr {
  seq += 1
  const number = overrides.number ?? String(seq)
  return {
    id: `pr-${number}`,
    intentId: 'intent-1',
    deliveryId: null,
    forge: 'github',
    repo: 'o/r',
    number,
    url: `https://github.com/o/r/pull/${number}`,
    status,
    headBranch: null,
    baseBranch: 'main',
    createdAt: 1_700_000_000_000 + seq,
    updatedAt: 1_700_000_000_000 + seq,
    ...overrides,
  }
}

/** A `prs` list holding one row per supplied status, in order. */
export function fakeIntentPrs(...statuses: IntentPrStatus[]): IntentPr[] {
  return statuses.map((s) => fakeIntentPr(s))
}
