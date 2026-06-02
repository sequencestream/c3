// 放在 components/ 下以走 happy-dom 环境(highlight 依赖 DOMPurify → 需要 DOM;
// 且会动态 import('shiki') 真实跑高亮,作为转换管线的端到端回归)。
import { describe, it, expect } from 'vitest'
import { highlight, langFromClass } from '../lib/highlight'

describe('langFromClass — 从 markdown-it 的 language-* class 取语言', () => {
  it('提取标准前缀', () => {
    expect(langFromClass('language-ts')).toBe('ts')
    expect(langFromClass('hljs language-python extra')).toBe('python')
    expect(langFromClass('language-c++')).toBe('c++')
  })
  it('无 language- 前缀返回 null', () => {
    expect(langFromClass('foo bar')).toBeNull()
    expect(langFromClass('')).toBeNull()
  })
})

describe('highlight — Shiki 按需高亮 → class 化、无 inline style', () => {
  it('已知语言:输出 class 化 token、绝无 inline style', async () => {
    const html = await highlight('const x = 42 // hi', 'ts')
    expect(html).not.toBeNull()
    expect(html!).toContain('class="shiki')
    expect(html!).toContain('t-keyword') // const
    expect(html!).toContain('t-number') // 42
    expect(html!).toContain('t-comment') // // hi
    // 安全/约束:不得残留任何 inline style(哨兵色已转 class 或被剥除)
    expect(html!.toLowerCase()).not.toContain('style=')
    // 不得残留哨兵 hex
    expect(html!.toLowerCase()).not.toContain('#c010')
  }, 20000)

  it('未知语言:返回 null(调用方保持原始 <pre><code> 兜底)', async () => {
    const html = await highlight('whatever', 'definitely-not-a-language')
    expect(html).toBeNull()
  }, 20000)
})
