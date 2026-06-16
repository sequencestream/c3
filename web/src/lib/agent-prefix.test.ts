import { describe, it, expect } from 'vitest'
import type { AgentConfig, SystemSettings } from '@ccc/shared/protocol'
import { advanceOnFailure, agentAttemptOrder, agentNameAt, resolveAgentIndex } from './agent-prefix'

function agent(id: string, name: string, over: Partial<AgentConfig> = {}): AgentConfig {
  // Base is a claude arm; `...over` is a Partial over the discriminated union, so
  // the spread cannot be statically correlated — cast to the wire type (test fixture).
  return {
    id,
    vendor: 'claude',
    displayName: name,
    config: { baseUrl: '', apiKey: '', model: '' },
    ...over,
  } as AgentConfig
}

function settings(over: Partial<SystemSettings> = {}): SystemSettings {
  return {
    agents: [agent('a', 'Alpha'), agent('b', 'Bravo'), agent('c', 'Charlie')],
    defaultAgentId: 'a',
    toolAgentId: '',
    intentAgentId: '',
    ...over,
  }
}

describe('agentAttemptOrder', () => {
  it('默认 agent 在前,随后是 degradationChain(去默认自身)', () => {
    expect(agentAttemptOrder(settings({ degradationChain: ['a', 'b', 'c'] }))).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('无 degradationChain 时只有默认 agent', () => {
    expect(agentAttemptOrder(settings())).toEqual(['a'])
  })

  it('去重并丢弃 agents 中不存在的 id', () => {
    expect(agentAttemptOrder(settings({ degradationChain: ['b', 'b', 'ghost', 'a'] }))).toEqual([
      'a',
      'b',
    ])
  })

  it('anchorAgentId 作链头,替代写死默认 agent', () => {
    // 默认是 'a',但锚定到 'b' → 链头应是 'b',链中的 'b' 不重复。
    expect(agentAttemptOrder(settings({ degradationChain: ['a', 'b', 'c'] }), 'b')).toEqual([
      'b',
      'a',
      'c',
    ])
  })

  it('codex session:跨 vendor 的链 agent 被过滤(只留同 vendor)', () => {
    // 链头 codex,降级链里的 claude agent 无法承接上下文 → 被过滤掉。
    const s = settings({
      agents: [
        agent('a', 'Alpha'),
        agent('b', 'Bravo'),
        agent('x', 'Codex', { vendor: 'codex' }),
        agent('y', 'Codex2', { vendor: 'codex' }),
      ],
      defaultAgentId: 'a',
      degradationChain: ['a', 'b', 'y'],
    })
    expect(agentAttemptOrder(s, 'x')).toEqual(['x', 'y'])
  })

  it('anchorAgentId 不在 agents 中时退回默认 agent', () => {
    expect(agentAttemptOrder(settings({ degradationChain: ['a', 'b'] }), 'ghost')).toEqual([
      'a',
      'b',
    ])
  })

  it('null settings → []', () => {
    expect(agentAttemptOrder(null)).toEqual([])
  })
})

describe('agentNameAt', () => {
  const s = settings({ degradationChain: ['a', 'b', 'c'] })

  it('按下标解析展示名(锚定默认 agent)', () => {
    expect(agentNameAt(s, 'a', 0)).toBe('Alpha')
    expect(agentNameAt(s, 'a', 1)).toBe('Bravo')
  })

  it('越界向链尾夹取', () => {
    expect(agentNameAt(s, 'a', 99)).toBe('Charlie')
    expect(agentNameAt(s, 'a', -5)).toBe('Alpha')
  })

  it('codex session:0 下标显示绑定的 codex agent 名(不是默认)', () => {
    const cs = settings({
      agents: [agent('a', 'Alpha'), agent('x', 'Codex', { vendor: 'codex' })],
      defaultAgentId: 'a',
      degradationChain: ['a'],
    })
    expect(agentNameAt(cs, 'x', 0)).toBe('Codex')
  })

  it('空 order → 空串(不渲染前缀)', () => {
    expect(agentNameAt(null, 'a', 0)).toBe('')
    expect(agentNameAt(settings({ agents: [], defaultAgentId: 'a' }), 'a', 0)).toBe('')
  })
})

describe('resolveAgentIndex', () => {
  const s = settings({ degradationChain: ['a', 'b', 'c'] })

  it('锚定链头后,绑定 agent 落在 0,链中后续按位置', () => {
    expect(resolveAgentIndex(s, 'a', 'a')).toBe(0)
    expect(resolveAgentIndex(s, 'a', 'b')).toBe(1)
    expect(resolveAgentIndex(s, 'a', 'c')).toBe(2)
  })

  it('codex session 绑定 agent 锚定后落在 0', () => {
    const cs = settings({
      agents: [agent('a', 'Alpha'), agent('x', 'Codex', { vendor: 'codex' })],
      defaultAgentId: 'a',
      degradationChain: ['a'],
    })
    expect(resolveAgentIndex(cs, 'x', 'x')).toBe(0)
  })

  it('未找到 agentId 时返回 0(链头)', () => {
    expect(resolveAgentIndex(s, 'a', 'ghost')).toBe(0)
  })

  it('undefined/空 agentId 返回 0', () => {
    expect(resolveAgentIndex(s, 'a', undefined)).toBe(0)
    expect(resolveAgentIndex(s, 'a', '')).toBe(0)
  })

  it('空 settings → 0', () => {
    expect(resolveAgentIndex(null, 'a', 'a')).toBe(0)
    expect(resolveAgentIndex(settings({ agents: [], defaultAgentId: 'a' }), 'a', 'a')).toBe(0)
  })
})

describe('advanceOnFailure', () => {
  const s = settings({ degradationChain: ['a', 'b', 'c'] })

  it('失败 agent 的下一项接管', () => {
    expect(advanceOnFailure(s, 'a', 0, 'a')).toBe(1)
    expect(advanceOnFailure(s, 'a', 1, 'b')).toBe(2)
  })

  it('链尾失败停在最后一个', () => {
    expect(advanceOnFailure(s, 'a', 2, 'c')).toBe(2)
  })

  it('链上找不到 failedId 时退回 currentIndex+1(夹取)', () => {
    expect(advanceOnFailure(s, 'a', 0, 'ghost')).toBe(1)
    expect(advanceOnFailure(s, 'a', 2, 'ghost')).toBe(2)
  })

  it('空 order → 0', () => {
    expect(advanceOnFailure(null, 'a', 3, 'a')).toBe(0)
  })
})
