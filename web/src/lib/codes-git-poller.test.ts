import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createCodesGitStatusPoller } from './codes-git-poller'

describe('createCodesGitStatusPoller', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup(activeInit = true) {
    let active = activeInit
    const request = vi.fn()
    const poller = createCodesGitStatusPoller({
      intervalMs: 15_000,
      isActive: () => active,
      request,
    })
    return { poller, request, setActive: (v: boolean) => (active = v) }
  }

  it('激活时立即请求一次,然后每 15s 一次', () => {
    const { poller, request } = setup(true)
    poller.sync()
    expect(request).toHaveBeenCalledTimes(1) // 立即
    vi.advanceTimersByTime(15_000)
    expect(request).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(15_000)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('未激活时 sync 不请求也不建计时器', () => {
    const { poller, request } = setup(false)
    poller.sync()
    vi.advanceTimersByTime(60_000)
    expect(request).not.toHaveBeenCalled()
  })

  it('重复 sync(已激活)不重复创建计时器', () => {
    const { poller, request } = setup(true)
    poller.sync()
    poller.sync()
    poller.sync()
    expect(request).toHaveBeenCalledTimes(1) // 仍只有一次立即请求
    vi.advanceTimersByTime(15_000)
    expect(request).toHaveBeenCalledTimes(2) // 单一计时器
  })

  it('切走/隐藏/失焦 → sync 暂停计时', () => {
    const { poller, request, setActive } = setup(true)
    poller.sync()
    expect(request).toHaveBeenCalledTimes(1)
    setActive(false)
    poller.sync()
    vi.advanceTimersByTime(60_000)
    expect(request).toHaveBeenCalledTimes(1) // 暂停后不再请求
  })

  it('恢复可见 → 再次立即请求并重建计时器', () => {
    const { poller, request, setActive } = setup(true)
    poller.sync()
    setActive(false)
    poller.sync()
    setActive(true)
    poller.sync()
    expect(request).toHaveBeenCalledTimes(2) // 恢复时又立即请求一次
    vi.advanceTimersByTime(15_000)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('计时器 tick 时若已不再激活则自动停止', () => {
    const { poller, request, setActive } = setup(true)
    poller.sync()
    setActive(false) // 未调用 sync,等下一 tick 自检
    vi.advanceTimersByTime(15_000)
    expect(request).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('stop() 清除计时器', () => {
    const { poller, request } = setup(true)
    poller.sync()
    poller.stop()
    vi.advanceTimersByTime(60_000)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
