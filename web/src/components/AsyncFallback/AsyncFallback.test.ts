import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import AsyncViewLoading from './AsyncViewLoading.vue'
import AsyncViewError from './AsyncViewError.vue'
import AsyncOverlayLoading from './AsyncOverlayLoading.vue'
import AsyncOverlayError from './AsyncOverlayError.vue'

// 四个占位件共用一份契约,合成一个文件测:它们没有 props、不发消息,值得钉住的是
// 无障碍语义(loading=status/busy、error=alert)与「页内不提供重试入口」这条决定
// ——失败的 chunk 已被浏览器记进模块图,页内重试按钮只会立刻再失败一次,唯一的恢复
// 路径是整页刷新。断言一律走 data-testid / role / 结构,不碰可见文案。

describe('AsyncFallback 占位件', () => {
  it('两个 loading 占位都以 role=status + aria-busy 播报,并带可读的 aria-label', () => {
    for (const [comp, testid] of [
      [AsyncViewLoading, 'async-view-loading'],
      [AsyncOverlayLoading, 'async-overlay-loading'],
    ] as const) {
      const root = mount(comp).find(`[data-testid="${testid}"]`)
      expect(root.exists()).toBe(true)
      expect(root.attributes('role')).toBe('status')
      expect(root.attributes('aria-busy')).toBe('true')
      expect(root.attributes('aria-label')).toBeTruthy()
    }
  })

  it('页面级失败兜底以 role=alert 播报,且不提供任何页内重试入口', () => {
    const w = mount(AsyncViewError)
    const root = w.find('[data-testid="async-view-error"]')
    expect(root.exists()).toBe(true)
    expect(root.attributes('role')).toBe('alert')
    expect(w.findAll('button')).toHaveLength(0)
  })

  it('弹窗级失败兜底只有「关闭」一个动作,没有重试入口', () => {
    const w = mount(AsyncOverlayError)
    expect(w.find('[data-testid="async-overlay-error"] [role="alert"]').exists()).toBe(true)
    expect(w.findAll('button')).toHaveLength(1)
  })

  it('弹窗级失败兜底点「关闭」只收起自己,不上抛关闭类事件', async () => {
    // 打开状态由 App 的门控 ref 持有,本组件够不着;收起换来的是不挡路,
    // 不代表那条流程已收尾——它要等整页刷新才归位。
    const w = mount(AsyncOverlayError)
    await w.find('button').trigger('click')
    expect(w.find('[data-testid="async-overlay-error"]').exists()).toBe(false)
    for (const evt of ['close', 'dismiss', 'cancel', 'update:open']) {
      expect(w.emitted(evt)).toBeUndefined()
    }
  })
})
