import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// 应用外壳的布局契约。左侧竖条能不能「常驻最左侧」不由组件自身决定:#app 是纵向 flex
// 容器,竖条必须先被收进一层行向壳,否则它会按纵向流排到顶栏上方、只剩内容高度。
// 这类父子布局关系无法通过单独 mount 子组件测出(子组件不关心父级 flex 归属),
// 故这里对模板与样式表做结构性断言,把口径钉在源码上。

const APP_VUE = fileURLToPath(new URL('./App.vue', import.meta.url))
const STYLE_CSS = fileURLToPath(new URL('./style.css', import.meta.url))

const appSource = readFileSync(APP_VUE, 'utf-8')
const styleSource = readFileSync(STYLE_CSS, 'utf-8')

/** 取 `<template>` 内的模板文本,排除 script 段里的同名 class 串。 */
function appTemplate(): string {
  return appSource.slice(appSource.indexOf('<template>'))
}

/** 某个 class 声明块内的 CSS 文本。 */
function cssRule(selector: string): string {
  const start = styleSource.indexOf(`\n${selector} {`)
  expect(start, `${selector} 规则缺失`).toBeGreaterThan(-1)
  return styleSource.slice(start, styleSource.indexOf('}', start))
}

describe('应用外壳 — 左侧竖条确实排在最左侧', () => {
  it('竖条被收进一层行向壳 .app-shell', () => {
    const tpl = appTemplate()
    const shell = tpl.indexOf('<div class="app-shell">')
    expect(shell).toBeGreaterThan(-1)
    // 壳的直属子节点依次是竖条与主列:竖条在主列之前,才排在最左侧。
    expect(tpl.indexOf('<LeftRail')).toBeGreaterThan(shell)
    expect(tpl.indexOf('<div class="app-main">')).toBeGreaterThan(tpl.indexOf('<LeftRail'))
  })

  it('#app 仍是纵向容器,行向由壳承担 —— 两处不能同时是 column', () => {
    expect(cssRule('#app')).toContain('flex-direction: column')
    expect(cssRule('.app-shell')).toContain('flex-direction: row')
  })

  it('.app-shell 与 .app-main 吃满剩余空间且不被内容撑破', () => {
    for (const selector of ['.app-shell', '.app-main']) {
      const rule = cssRule(selector)
      expect(rule, selector).toContain('flex: 1')
      expect(rule, selector).toContain('min-width: 0')
      expect(rule, selector).toContain('min-height: 0')
    }
  })

  it('竖条在行向壳里占满交叉轴(高度贯通),而不是只占内容高', () => {
    expect(cssRule('.app-shell')).toContain('align-items: stretch')
    // 竖条自身不设 flex-grow,高度由 align-items: stretch 撑满 —— 组件侧的 flex: 1
    // 反而会让它在纵向栈里被当成「按内容高」以外的错误假设。
    const rail = readFileSync(
      fileURLToPath(new URL('./components/LeftRail/LeftRail.vue', import.meta.url)),
      'utf-8',
    )
    expect(rail).not.toMatch(/\.left-rail \{[^}]*flex: 1/)
  })

  it('主列维持原有纵向栈:顶栏在上、内容区在下各自吃剩余高度', () => {
    expect(cssRule('.app-main')).toContain('flex-direction: column')
    expect(cssRule('.body')).toContain('flex: 1')
  })
})
