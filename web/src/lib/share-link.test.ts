import { describe, it, expect } from 'vitest'
import { buildShareText } from './share-link'
import { parseDeepLink } from './deep-link'

describe('buildShareText', () => {
  it('拼出 [类型] 标题 + 深链(含 workspaceId),换行分隔', () => {
    const text = buildShareText({
      kind: 'session',
      workspaceId: 'ws1',
      id: 'sess-abc',
      title: 'foo',
      typeLabel: '会话',
      baseUrl: 'http://example.com',
    })
    expect(text).toBe('[会话] foo\nhttp://example.com/#/session/ws1/sess-abc')
  })

  it('剥掉 baseUrl 尾部斜杠(含多个)', () => {
    const text = buildShareText({
      kind: 'intent',
      workspaceId: 'ws1',
      id: 'int-xyz',
      title: 'bar',
      typeLabel: 'Intent',
      baseUrl: 'http://example.com///',
    })
    expect(text).toBe('[Intent] bar\nhttp://example.com/#/intent/ws1/int-xyz')
  })

  it('trim 前后空白', () => {
    const text = buildShareText({
      kind: 'discussion',
      workspaceId: 'ws1',
      id: 'disc-456',
      title: 'baz',
      typeLabel: 'Discussion',
      baseUrl: '  http://example.com  ',
    })
    expect(text).toBe('[Discussion] baz\nhttp://example.com/#/discussion/ws1/disc-456')
  })

  it('空 / 未配置 baseUrl → 返回 null(走未配置分支)', () => {
    const base = {
      kind: 'session' as const,
      workspaceId: 'ws1',
      id: 'sid',
      title: 't',
      typeLabel: '会话',
    }
    expect(buildShareText({ ...base, baseUrl: '' })).toBeNull()
    expect(buildShareText({ ...base, baseUrl: '   ' })).toBeNull()
    expect(buildShareText({ ...base, baseUrl: undefined })).toBeNull()
    expect(buildShareText({ ...base, baseUrl: null })).toBeNull()
  })

  it('生成的 URL 能被 parseDeepLink 反解回同一目标', () => {
    const text = buildShareText({
      kind: 'intent',
      workspaceId: 'wsX',
      id: 'iidZ',
      title: 'x',
      typeLabel: 'Intent',
      baseUrl: 'http://host:9000',
    })
    // 取 URL 段(第二行),剥掉 `<baseUrl>/#` 前缀后交给 parseDeepLink。
    const url = text!.split('\n')[1]
    const hash = url.slice(url.indexOf('#/') + 1)
    expect(parseDeepLink(hash)).toEqual({ kind: 'intent', workspaceId: 'wsX', id: 'iidZ' })
  })
})
