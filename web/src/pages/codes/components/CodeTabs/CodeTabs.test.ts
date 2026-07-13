// @vitest-environment happy-dom

/*
 * CodeTabs 的 Markdown 视图模式记忆:按 path 独立、跨 tab 切换保留、关闭即遗忘。
 *
 * 视图模式是纯前端内存态(容器持有的 Map),不落库、不进协议。CodeFileView 用
 * :key="path" 逐 tab 重挂载,故状态必须由 CodeTabs 持有并透传。此处以 CodeFileView
 * 收到的 view-mode prop 为观测锚,验证隔离/保留/清理三条契约。
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CodeTabs from './CodeTabs.vue'
import CodeFileView from '../CodeFileView/CodeFileView.vue'
import type { CodeTab } from '@/lib/codes-view'

function mdTab(path: string): CodeTab {
  const content = `# ${path}\n`
  return {
    path,
    loading: false,
    file: { path, size: content.length, binary: false, truncated: false, content },
  }
}

const A = mdTab('a.md')
const B = mdTab('b.md')

function activeViewMode(wrapper: ReturnType<typeof mount>): string {
  return wrapper.getComponent(CodeFileView).props('viewMode') as string
}

// 让激活 tab 内的原文按钮触发 CodeFileView 的 update:viewMode,模拟用户点「原文」。
async function selectSource(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.findAll('.code-view-btn')[0].trigger('click')
}

describe('CodeTabs Markdown 视图模式记忆', () => {
  it('新打开的 tab 默认预览(preview)', () => {
    const wrapper = mount(CodeTabs, {
      props: { tabs: [A], activePath: A.path, activeTab: A },
    })
    expect(activeViewMode(wrapper)).toBe('preview')
  })

  it('一个 tab 切到原文不影响另一个 tab,且切走再回来保留各自选择', async () => {
    const wrapper = mount(CodeTabs, {
      props: { tabs: [A, B], activePath: A.path, activeTab: A },
    })
    // A 切到原文。
    await selectSource(wrapper)
    expect(activeViewMode(wrapper)).toBe('source')

    // 激活切到 B:B 仍是默认预览,不受 A 影响。
    await wrapper.setProps({ activePath: B.path, activeTab: B })
    expect(activeViewMode(wrapper)).toBe('preview')

    // 切回 A:保留其原文选择。
    await wrapper.setProps({ activePath: A.path, activeTab: A })
    expect(activeViewMode(wrapper)).toBe('source')
  })

  it('关闭 tab 清理其模式记录,重开同一路径回到默认预览', async () => {
    const wrapper = mount(CodeTabs, {
      props: { tabs: [A], activePath: A.path, activeTab: A },
    })
    await selectSource(wrapper)
    expect(activeViewMode(wrapper)).toBe('source')

    // 点关闭按钮:上抛 close 事件,同时内部清理该 path。
    await wrapper.find('.tab-close').trigger('click')
    expect(wrapper.emitted('close')).toEqual([[A.path]])

    // 模拟父层移除该 tab 后又重新打开同一路径(视为新 tab)。
    await wrapper.setProps({ tabs: [], activePath: null, activeTab: null })
    await wrapper.setProps({ tabs: [A], activePath: A.path, activeTab: A })
    expect(activeViewMode(wrapper)).toBe('preview')
  })

  it('tab 被外部途径移除时清理残留模式记录(重开回默认)', async () => {
    const wrapper = mount(CodeTabs, {
      props: { tabs: [A], activePath: A.path, activeTab: A },
    })
    await selectSource(wrapper)
    expect(activeViewMode(wrapper)).toBe('source')

    // 不经关闭按钮,直接从 tabs 移除 A —— watch 兜底应清掉记录。
    await wrapper.setProps({ tabs: [], activePath: null, activeTab: null })
    await wrapper.setProps({ tabs: [A], activePath: A.path, activeTab: A })
    expect(activeViewMode(wrapper)).toBe('preview')
  })
})
