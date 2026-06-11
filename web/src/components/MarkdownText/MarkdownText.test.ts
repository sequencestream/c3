import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownText from './MarkdownText.vue'
import type { TextMsg } from '../../lib/chat-types'

function mountMd(text: string, kind: TextMsg['kind'] = 'assistant') {
  return mount(MarkdownText, { props: { text, kind } })
}

describe('MarkdownText.vue — assistant 文本 Markdown 渲染', () => {
  it('assistant：渲染为 .md-body 的 HTML', () => {
    const w = mountMd('# 标题\n\n正文 **粗体**')
    const body = w.find('.md-body')
    expect(body.exists()).toBe(true)
    expect(body.find('h1').exists()).toBe(true)
    expect(body.find('strong').text()).toBe('粗体')
  })

  it('代码块此阶段为未高亮 <pre><code>', () => {
    const w = mountMd('```\nconst a = 1\n```')
    const code = w.find('.md-body pre code')
    expect(code.exists()).toBe(true)
    expect(code.text()).toContain('const a = 1')
  })

  it('表格渲染为 <table>', () => {
    const w = mountMd('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(w.find('.md-body table').exists()).toBe(true)
    expect(w.findAll('.md-body td').length).toBe(2)
  })

  it('表格包裹独立横向滚动容器', () => {
    const w = mountMd('| a | b |\n| - | - |\n| 1 | 2 |')
    const wrapper = w.find('.md-body .md-scroll')
    expect(wrapper.exists()).toBe(true)
    expect(wrapper.find('table').exists()).toBe(true)
  })

  it('任务列表渲染为复选框', () => {
    const w = mountMd('- [ ] todo\n- [x] done')
    // markdown-it 默认不渲染 GFM 任务列表为 checkbox，但列表项必须存在
    expect(w.findAll('.md-body li').length).toBe(2)
  })

  it('外链强制 target=_blank rel=noopener noreferrer', () => {
    const w = mountMd('[去看看](https://example.com)')
    const a = w.find('.md-body a')
    expect(a.attributes('href')).toBe('https://example.com')
    expect(a.attributes('target')).toBe('_blank')
    expect(a.attributes('rel')).toBe('noopener noreferrer')
  })

  it('javascript: 链接被剔除（无可点击的危险链接）', () => {
    const w = mountMd('[恶意](javascript:alert(1))')
    const body = w.find('.md-body')
    // markdown-it 的 validateLink 先拦截危险协议（降级为纯文本），DOMPurify 再兜底；
    // 无论哪层生效，结果都不应存在 href 指向 javascript: 的可点击锚点。
    expect(body.find('a[href^="javascript"]').exists()).toBe(false)
    expect(body.html().toLowerCase()).not.toContain('href="javascript')
  })

  it('<script> 注入被 DOMPurify 拦截', () => {
    const w = mountMd('正常文本 <script>window.__pwned = true</script> 结尾')
    const html = w.find('.md-body').html()
    expect(html).not.toContain('<script')
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
  })

  it('html:false：原始 HTML 标签不被当作 HTML 渲染', () => {
    const w = mountMd('<b>not bold</b>')
    expect(w.find('.md-body b').exists()).toBe(false)
    expect(w.find('.md-body').text()).toContain('<b>not bold</b>')
  })

  it('user：跳过 Markdown，纯文本直出（不挂 .md-body）', () => {
    const w = mountMd('# 不该变成标题', 'user')
    expect(w.find('.md-body').exists()).toBe(false)
    expect(w.find('h1').exists()).toBe(false)
    expect(w.text()).toContain('# 不该变成标题')
  })

  it('system：同样跳过 Markdown', () => {
    const w = mountMd('**not bold**', 'system')
    expect(w.find('.md-body').exists()).toBe(false)
    expect(w.text()).toContain('**not bold**')
  })
})

describe('MarkdownText.vue — markdown 强制入口(需求详情等非聊天场景)', () => {
  // 不传 kind,只靠 markdown=true 即应走同一条安全渲染管线。
  function mountForced(text: string) {
    return mount(MarkdownText, { props: { text, markdown: true } })
  }

  it('markdown=true：无 kind 也渲染为 .md-body 的 HTML', () => {
    const w = mountForced('# 需求标题\n\n- 项一\n- 项二\n\n正文 **粗体**')
    const body = w.find('.md-body')
    expect(body.exists()).toBe(true)
    expect(body.find('h1').exists()).toBe(true)
    expect(body.findAll('li').length).toBe(2)
    expect(body.find('strong').text()).toBe('粗体')
  })

  it('markdown=true：代码块渲染为 <pre><code>', () => {
    const w = mountForced('```\nconst a = 1\n```')
    const code = w.find('.md-body pre code')
    expect(code.exists()).toBe(true)
    expect(code.text()).toContain('const a = 1')
  })

  it('markdown=true：外链强制 target=_blank rel=noopener noreferrer', () => {
    const w = mountForced('[去看看](https://example.com)')
    const a = w.find('.md-body a')
    expect(a.attributes('href')).toBe('https://example.com')
    expect(a.attributes('target')).toBe('_blank')
    expect(a.attributes('rel')).toBe('noopener noreferrer')
  })

  it('markdown=true：javascript: 链接被剔除', () => {
    const w = mountForced('[恶意](javascript:alert(1))')
    const body = w.find('.md-body')
    expect(body.find('a[href^="javascript"]').exists()).toBe(false)
    expect(body.html().toLowerCase()).not.toContain('href="javascript')
  })

  it('markdown=true：<script> 注入被 DOMPurify 拦截', () => {
    const w = mountForced('正常文本 <script>window.__pwnedReq = true</script> 结尾')
    const html = w.find('.md-body').html()
    expect(html).not.toContain('<script')
    expect((window as unknown as { __pwnedReq?: boolean }).__pwnedReq).toBeUndefined()
  })

  it('markdown 缺省时仍按 kind 决定(默认纯文本)', () => {
    // 既不传 kind 也不传 markdown:回退纯文本直出,不回归聊天既有契约。
    const w = mount(MarkdownText, { props: { text: '# 不渲染' } })
    expect(w.find('.md-body').exists()).toBe(false)
    expect(w.text()).toContain('# 不渲染')
  })
})
