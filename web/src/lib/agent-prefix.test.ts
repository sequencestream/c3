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

  it('null settings → []', () => {
    expect(agentAttemptOrder(null)).toEqual([])
  })
})

describe('agentNameAt', () => {
  const s = settings({ degradationChain: ['a', 'b', 'c'] })

  it('按下标解析展示名', () => {
    expect(agentNameAt(s, 0)).toBe('Alpha')
    expect(agentNameAt(s, 1)).toBe('Bravo')
  })

  it('越界向链尾夹取', () => {
    expect(agentNameAt(s, 99)).toBe('Charlie')
    expect(agentNameAt(s, -5)).toBe('Alpha')
  })

  it('空 order → 空串(不渲染前缀)', () => {
    expect(agentNameAt(null, 0)).toBe('')
    expect(agentNameAt(settings({ agents: [], defaultAgentId: 'a' }), 0)).toBe('')
  })
})

describe('resolveAgentIndex', () => {
  const s = settings({ degradationChain: ['a', 'b', 'c'] })

  it('已知 agent 返回其在 order 中的位置', () => {
    expect(resolveAgentIndex(s, 'a')).toBe(0)
    expect(resolveAgentIndex(s, 'b')).toBe(1)
    expect(resolveAgentIndex(s, 'c')).toBe(2)
  })

  it('未找到 agentId 时返回 0(默认 agent)', () => {
    expect(resolveAgentIndex(s, 'ghost')).toBe(0)
  })

  it('undefined/空 agentId 返回 0', () => {
    expect(resolveAgentIndex(s, undefined)).toBe(0)
    expect(resolveAgentIndex(s, '')).toBe(0)
  })

  it('空 settings → 0', () => {
    expect(resolveAgentIndex(null, 'a')).toBe(0)
    expect(resolveAgentIndex(settings({ agents: [], defaultAgentId: 'a' }), 'a')).toBe(0)
  })
})

describe('advanceOnFailure', () => {
  const s = settings({ degradationChain: ['a', 'b', 'c'] })

  it('失败 agent 的下一项接管', () => {
    expect(advanceOnFailure(s, 0, 'a')).toBe(1)
    expect(advanceOnFailure(s, 1, 'b')).toBe(2)
  })

  it('链尾失败停在最后一个', () => {
    expect(advanceOnFailure(s, 2, 'c')).toBe(2)
  })

  it('链上找不到 failedId 时退回 currentIndex+1(夹取)', () => {
    expect(advanceOnFailure(s, 0, 'ghost')).toBe(1)
    expect(advanceOnFailure(s, 2, 'ghost')).toBe(2)
  })

  it('空 order → 0', () => {
    expect(advanceOnFailure(null, 3, 'a')).toBe(0)
  })
})
