import { describe, expect, it } from 'vitest'
import type { Intent, IntentPr } from '@ccc/shared/protocol'
import { canOfferLinkExistingPr } from './create-pr-failure'

function pr(over: Partial<IntentPr>): IntentPr {
  return {
    id: 'pr1',
    intentId: 'i1',
    number: '1',
    status: 'reviewing',
    deliveryId: null,
    forge: null,
    repo: null,
    url: null,
    headBranch: null,
    baseBranch: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

function intent(over: Partial<Intent> = {}): Intent {
  return {
    id: 'i1',
    title: 't',
    content: '',
    status: 'todo',
    priority: 'P1',
    module: '',
    dependsOn: [],
    prs: [],
    linkedDeliveries: [],
    baseBranch: 'main',
    ...over,
  } as Intent
}

describe('canOfferLinkExistingPr', () => {
  it('returns false without context', () => {
    expect(canOfferLinkExistingPr(null, [intent()])).toBe(false)
  })

  it('returns true when target has no active PR', () => {
    expect(canOfferLinkExistingPr({ intentId: 'i1' }, [intent({ prs: [] })])).toBe(true)
  })

  it('returns false when target already has an active PR for the same delivery', () => {
    expect(
      canOfferLinkExistingPr({ intentId: 'i1', deliveryId: 'd1' }, [
        intent({
          prs: [pr({ number: '1', status: 'reviewing', deliveryId: 'd1' })],
        }),
      ]),
    ).toBe(false)
  })

  it('ignores merged PR rows on the same delivery', () => {
    expect(
      canOfferLinkExistingPr({ intentId: 'i1', deliveryId: 'd1' }, [
        intent({
          prs: [pr({ number: '1', status: 'merged', deliveryId: 'd1' })],
        }),
      ]),
    ).toBe(true)
  })
})
