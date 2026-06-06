import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ConsensusBlock from './ConsensusBlock.vue'
import type { ChatMsg } from '../../lib/chat-types'
import type { ConsensusOutcome } from '@ccc/shared/protocol'

// A consensus chat message (allow/deny "tool" kind) with an optional vendor scope.
function consensusMsg(extra: Partial<ConsensusOutcome>): Extract<ChatMsg, { kind: 'consensus' }> {
  return {
    id: 1,
    kind: 'consensus',
    toolName: 'Write',
    input: {},
    outcome: {
      kind: 'tool',
      votes: [],
      summary: 'ok',
      unanimous: true,
      decision: 'allow',
      ...extra,
    },
  }
}

const mountBlock = (m: Extract<ChatMsg, { kind: 'consensus' }>) =>
  mount(ConsensusBlock, { props: { m } })

describe('ConsensusBlock.vue — vendor-scope honesty (2026-06-06-006)', () => {
  it('renders the vendor-scope note when cross-vendor advisors were excluded', () => {
    const w = mountBlock(consensusMsg({ vendorScope: 'claude', crossVendorExcluded: 2 }))
    expect(w.find('.consensus-vendor-scope').exists()).toBe(true)
  })

  it('omits the note when no cross-vendor advisor was excluded', () => {
    const w = mountBlock(consensusMsg({ vendorScope: 'claude', crossVendorExcluded: 0 }))
    expect(w.find('.consensus-vendor-scope').exists()).toBe(false)
  })

  it('omits the note on a legacy outcome without vendor-scope fields', () => {
    const w = mountBlock(consensusMsg({}))
    expect(w.find('.consensus-vendor-scope').exists()).toBe(false)
  })
})
