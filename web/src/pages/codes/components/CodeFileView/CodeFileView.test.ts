// @vitest-environment happy-dom

/*
 * 移动端代码窗口宽度收口回归。
 *
 * happy-dom 无真实布局引擎,无法断言计算宽度;故以「结构性 + 源样式」收口属性为锚:
 * 长行(white-space:pre,不折行)的横向溢出必须由 .code-scroll(overflow:auto)就地
 * 收口,而非向上冒泡成整页横滚。真实移动视口的像素级验证以 Playwright 手动复现为准
 * (见本意图的实施记录),此处只锁定保证收口的结构不被回归改掉。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import CodeFileView from './CodeFileView.vue'
import type { CodeTab } from '@/lib/codes-view'

// 超长单行 + 未知后缀:后缀绕过 Shiki 高亮走纯文本兜底,把测试聚焦在收口结构,
// 不牵扯异步高亮管线。
const longLine = `const x = ${'a'.repeat(4000)}()`
function makeTab(): CodeTab {
  return {
    path: 'sample.unknownext',
    loading: false,
    file: {
      path: 'sample.unknownext',
      size: longLine.length,
      binary: false,
      truncated: false,
      content: `${longLine}\nshort()\n`,
    },
  }
}

// Vitest 根即仓库根(见根 vitest.config.ts),按仓库相对路径读源样式更稳:
// happy-dom 会把 import.meta.url 改写成非 file 协议,fileURLToPath 不可用。
const componentSrc = readFileSync(
  resolve(process.cwd(), 'web/src/pages/codes/components/CodeFileView/CodeFileView.vue'),
  'utf8',
)
const globalCss = readFileSync(resolve(process.cwd(), 'web/src/style.css'), 'utf8')

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''
}

describe('CodeFileView 移动端宽度收口', () => {
  it('承载长行的 .code-body 嵌套在 .code-scroll 滚动容器内部', () => {
    const wrapper = mount(CodeFileView, { props: { tab: makeTab() } })
    const scroll = wrapper.find('.code-scroll')
    expect(scroll.exists()).toBe(true)
    // 横向溢出的所有权落在 .code-scroll,而非冒泡成整页横滚。
    expect(scroll.find('.code-body').exists()).toBe(true)
  })

  it('.code-scroll 声明横向 overflow 收口 + min-height:0 让其生效', () => {
    const block = ruleBody(componentSrc, '.code-scroll')
    expect(block).toMatch(/overflow:\s*auto/)
    expect(block).toMatch(/min-height:\s*0/)
  })

  it('.code-body 用 max-content 承长行,并被滚动容器收口(不折行)', () => {
    const block = ruleBody(componentSrc, '.code-body')
    expect(block).toMatch(/width:\s*max-content/)
    // 内容保持 pre 不折行,长行靠容器内横滚查看。
    expect(ruleBody(componentSrc, '.code-content')).toMatch(/white-space:\s*pre/)
  })

  it('全局 .body 行向 flex 容器带 min-width:0 收口(防止子项内在宽度上溢)', () => {
    expect(ruleBody(globalCss, '.body')).toMatch(/min-width:\s*0/)
  })
})

// ————————————————————————————————————————————————————————————————
// Markdown 预览/原文两态开关
// ————————————————————————————————————————————————————————————————

function makeMdTab(path = 'README.md'): CodeTab {
  const content = '# Title\n\nsome **bold** text\n'
  return {
    path,
    loading: false,
    file: { path, size: content.length, binary: false, truncated: false, content },
  }
}

describe('CodeFileView Markdown 视图开关', () => {
  it('非 .md 文件不渲染开关,且保持原文视图结构', () => {
    const wrapper = mount(CodeFileView, { props: { tab: makeTab() } })
    expect(wrapper.find('.code-view-toggle').exists()).toBe(false)
    expect(wrapper.find('.code-scroll').exists()).toBe(true)
    expect(wrapper.find('.code-gutter').exists()).toBe(true)
    expect(wrapper.find('.code-preview').exists()).toBe(false)
  })

  it('.md 文件显示两态开关,默认原文(source 激活、走 .code-scroll)', () => {
    const wrapper = mount(CodeFileView, { props: { tab: makeMdTab() } })
    const toggle = wrapper.find('.code-view-toggle')
    expect(toggle.exists()).toBe(true)
    const btns = toggle.findAll('.code-view-btn')
    expect(btns).toHaveLength(2)
    // 默认 viewMode='source':第一个按钮为激活态。
    expect(btns[0].classes()).toContain('active')
    expect(btns[1].classes()).not.toContain('active')
    // 默认仍是原文视图。
    expect(wrapper.find('.code-scroll').exists()).toBe(true)
    expect(wrapper.find('.code-gutter').exists()).toBe(true)
    expect(wrapper.find('.code-preview').exists()).toBe(false)
  })

  it('点击预览按钮上抛 update:viewMode=preview(受控,自身不切换)', async () => {
    const wrapper = mount(CodeFileView, { props: { tab: makeMdTab() } })
    const previewBtn = wrapper.findAll('.code-view-btn')[1]
    await previewBtn.trigger('click')
    expect(wrapper.emitted('update:viewMode')).toEqual([['preview']])
    // 受控组件:prop 未变前视图保持原文。
    expect(wrapper.find('.code-scroll').exists()).toBe(true)
    expect(wrapper.find('.code-preview').exists()).toBe(false)
  })

  it('viewMode=preview 渲染 MarkdownText(.md-body),无行号 gutter', () => {
    const wrapper = mount(CodeFileView, {
      props: { tab: makeMdTab(), viewMode: 'preview' },
    })
    expect(wrapper.find('.code-preview').exists()).toBe(true)
    expect(wrapper.find('.md-body').exists()).toBe(true)
    expect(wrapper.find('.code-gutter').exists()).toBe(false)
    expect(wrapper.find('.code-scroll').exists()).toBe(false)
  })

  it('从 preview 切回 source 恢复 .code-scroll/.code-gutter 与原始内容', async () => {
    const tab = makeMdTab()
    const wrapper = mount(CodeFileView, { props: { tab, viewMode: 'preview' } })
    expect(wrapper.find('.code-preview').exists()).toBe(true)
    await wrapper.setProps({ viewMode: 'source' })
    expect(wrapper.find('.code-preview').exists()).toBe(false)
    expect(wrapper.find('.code-scroll').exists()).toBe(true)
    expect(wrapper.find('.code-gutter').exists()).toBe(true)
    expect(wrapper.find('.code-main').text()).toContain('# Title')
  })

  it('空 .md 文件即使选 preview 也走空态文案,不进预览内容分支', () => {
    const empty: CodeTab = {
      path: 'empty.md',
      loading: false,
      file: { path: 'empty.md', size: 0, binary: false, truncated: false, content: '' },
    }
    const wrapper = mount(CodeFileView, { props: { tab: empty, viewMode: 'preview' } })
    // 开关仍显示(是 .md),但内容区是空态,不是预览。
    expect(wrapper.find('.code-view-toggle').exists()).toBe(true)
    expect(wrapper.find('.code-preview').exists()).toBe(false)
    expect(wrapper.find('.code-file-status').exists()).toBe(true)
  })
})
