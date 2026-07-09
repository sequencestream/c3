import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ConsensusBlock from './ConsensusBlock.vue'
import type { ChatMsg } from '../../lib/chat-types'
import type { ConsensusOutcome } from '@ccc/shared/protocol'

// A consensus chat message (allow/deny "tool" kind), overridable per test.
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

describe('ConsensusBlock.vue — cross-vendor normalized risk', () => {
  it('renders the normalized risk payload (intent + active axes + targets)', () => {
    const w = mountBlock(
      consensusMsg({
        normalized: {
          operationIntent: 'write-file: Create or overwrite a file',
          resourceScope: { kind: 'file', targets: ['/ws/a.ts'] },
          risks: { read: false, write: true, execute: false, network: false },
          normalizationVersion: 1,
        },
      }),
    )
    const risk = w.find('.consensus-risk')
    expect(risk.exists()).toBe(true)
    expect(risk.text()).toContain('write-file')
    expect(risk.find('.risk-targets').text()).toContain('/ws/a.ts')
    // Only the active (write) axis renders — not read/execute/network.
    const axes = w.findAll('.risk-axis')
    expect(axes).toHaveLength(1)
  })

  it('renders the normalization-failure note instead of a risk payload', () => {
    const w = mountBlock(consensusMsg({ decision: null, normalizationFailure: 'unknown-tool' }))
    expect(w.find('.consensus-risk').exists()).toBe(false)
    expect(w.find('.consensus-norm-failed').exists()).toBe(true)
    expect(w.find('.consensus-norm-failed').text()).toContain('unknown-tool')
  })

  it('shows each voter vendor next to its name', () => {
    const w = mountBlock(
      consensusMsg({
        votes: [
          { agentId: 'a', agentName: 'A', vendor: 'claude', decision: 'allow', reason: 'safe' },
          { agentId: 'x', agentName: 'X', vendor: 'codex', decision: 'allow', reason: 'ok' },
        ],
      }),
    )
    const vendors = w.findAll('.vote-vendor').map((n) => n.text())
    expect(vendors).toEqual(['Claude', 'Codex'])
  })

  it('renders a legacy outcome (no normalized/vendor fields) without crashing', () => {
    const w = mountBlock(consensusMsg({}))
    expect(w.find('.consensus-risk').exists()).toBe(false)
    expect(w.find('.consensus-norm-failed').exists()).toBe(false)
    // No misleading vendor-scope note should exist anymore.
    expect(w.find('.consensus-vendor-scope').exists()).toBe(false)
  })
})
