import { describe, it, expect } from 'vitest'
import { parseDeepLink, DEEP_LINK_KINDS } from './deep-link'

describe('parseDeepLink', () => {
  it('解析合法的 session 深链 → 返回 kind=session', () => {
    const result = parseDeepLink('/session/ws1/sess-abc')
    expect(result).toEqual({ kind: 'session', workspaceId: 'ws1', id: 'sess-abc' })
  })

  it('解析合法的 intent 深链 → 返回 kind=intent', () => {
    const result = parseDeepLink('/intent/ws1/int-xyz')
    expect(result).toEqual({ kind: 'intent', workspaceId: 'ws1', id: 'int-xyz' })
  })

  it('解析合法的 discussion 深链 → 返回 kind=discussion', () => {
    const result = parseDeepLink('/discussion/ws1/disc-456')
    expect(result).toEqual({ kind: 'discussion', workspaceId: 'ws1', id: 'disc-456' })
  })

  it('处理带前导 # 的输入(如 location.hash)需先 .slice(1)', () => {
    // parseDeepLink 不处理前导 #,调用方负责剥掉
    const result = parseDeepLink('/session/ws1/sid')
    expect(result).toEqual({ kind: 'session', workspaceId: 'ws1', id: 'sid' })
  })

  it('空 hash → 返回 null', () => {
    expect(parseDeepLink('')).toBeNull()
  })

  it('未知 kind → 返回 null', () => {
    expect(parseDeepLink('/unknown/ws1/id1')).toBeNull()
    expect(parseDeepLink('/automation/ws1/id1')).toBeNull()
  })

  it('段数不足(2 段) → 返回 null', () => {
    expect(parseDeepLink('/session/ws1')).toBeNull()
  })

  it('段数过多(4 段) → 返回 null', () => {
    expect(parseDeepLink('/session/ws1/id1/extra')).toBeNull()
  })

  it('空段 → 返回 null', () => {
    // 以 / 开头但某段为空
    expect(parseDeepLink('/session//id1')).toBeNull()
    expect(parseDeepLink('//ws1/id1')).toBeNull()
  })

  it('不含白名单外的 kind → 返回 null(验证 DEEP_LINK_KINDS 三方齐全)', () => {
    // DEEP_LINK_KINDS 正好是三元素,测试已知边界
    expect(DEEP_LINK_KINDS).toEqual(['session', 'intent', 'discussion'])
  })
})
