import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { ClientToServer, RuntimeLogChunk, ServerToClient } from '@ccc/shared/protocol'
import type { WsClientOptions, WsStatus } from '@/lib/ws'
import { LOG_POLL_INTERVAL_MS } from '@/lib/log-view'
import LogsPage from './LogsPage.vue'

/*
 * LogsPage.vue — 独立的运行日志页面。
 *
 * 三件事必须成立:打开就能看到最近一段历史(首拉不带 offset),之后每轮只取增量(带上一次
 * 的 nextOffset),以及标签页不可见时不再拉取、切回来立刻补一次。渲染断言基于 data-testid
 * 与文本内容(日志正文本身就是被测数据),不基于界面文案。
 */

/** 一个假的 WS 传输:记录发出的帧,并把服务端回帧的开关交给测试。 */
function fakeTransport() {
  const sent: ClientToServer[] = []
  let opts: WsClientOptions | null = null
  const factory = (o: WsClientOptions) => {
    opts = o
    return {
      send: (msg: ClientToServer) => sent.push(msg),
      close: () => {},
      reconnect: () => {},
    }
  }
  return {
    factory,
    sent,
    status(s: WsStatus) {
      opts?.onStatus(s)
    },
    receive(msg: ServerToClient) {
      opts?.onMessage(msg)
    },
  }
}

function chunk(text: string, over: Partial<RuntimeLogChunk> = {}): ServerToClient {
  return {
    type: 'runtime_log',
    chunk: {
      text,
      offset: 0,
      nextOffset: text.length,
      size: text.length,
      reset: true,
      available: true,
      ...over,
    },
  }
}

/** 打开一个已连上的页面。 */
function open(): { w: VueWrapper; ws: ReturnType<typeof fakeTransport> } {
  const ws = fakeTransport()
  const w = mount(LogsPage, { props: { createClient: ws.factory } })
  ws.status('open')
  return { w, ws }
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  vi.useFakeTimers()
  setVisibility('visible')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('LogsPage.vue — 轮询取增量', () => {
  it('连上就先要尾部历史(不带 offset),不必等下一个周期', () => {
    const { ws } = open()
    expect(ws.sent).toEqual([{ type: 'read_runtime_log' }])
  })

  it('之后每轮带上一次的 nextOffset,只取新增的部分', async () => {
    const { w, ws } = open()
    ws.receive(chunk('first\n', { nextOffset: 6 }))
    await w.vm.$nextTick()

    vi.advanceTimersByTime(LOG_POLL_INTERVAL_MS)
    expect(ws.sent.at(-1)).toEqual({ type: 'read_runtime_log', offset: 6 })

    ws.receive(chunk('second\n', { offset: 6, nextOffset: 13, reset: false }))
    await w.vm.$nextTick()
    vi.advanceTimersByTime(LOG_POLL_INTERVAL_MS)
    expect(ws.sent.at(-1)).toEqual({ type: 'read_runtime_log', offset: 13 })
  })

  it('把新到的日志行按顺序追加到已展示内容之后', async () => {
    const { w, ws } = open()
    ws.receive(chunk('one\ntwo\n', { nextOffset: 8 }))
    await w.vm.$nextTick()
    ws.receive(chunk('three\n', { offset: 8, nextOffset: 14, reset: false }))
    await w.vm.$nextTick()
    expect(w.get('[data-testid="logs-body"]').text()).toBe('one\ntwo\nthree')
  })

  it('标签页不可见时停止拉取,切回来立刻补一次', async () => {
    const { ws } = open()
    const before = ws.sent.length

    setVisibility('hidden')
    vi.advanceTimersByTime(LOG_POLL_INTERVAL_MS * 3)
    expect(ws.sent.length).toBe(before)

    setVisibility('visible')
    expect(ws.sent.length).toBe(before + 1)
  })

  it('断开时停表,不对着关掉的 socket 空转', async () => {
    const { ws } = open()
    const before = ws.sent.length
    ws.status('closed')
    vi.advanceTimersByTime(LOG_POLL_INTERVAL_MS * 3)
    expect(ws.sent.length).toBe(before)
  })
})

describe('LogsPage.vue — 空态与鉴权', () => {
  it('尚无日志时给出空态,而不是一片空白', () => {
    const { w } = open()
    expect(w.find('[data-testid="logs-empty"]').exists()).toBe(true)
  })

  it('服务端没有实时日志文件时说明原因', async () => {
    const { w, ws } = open()
    ws.receive(chunk('', { available: false }))
    await w.vm.$nextTick()
    expect(w.find('[data-testid="logs-unavailable"]').exists()).toBe(true)
  })

  it('连接未登录时提示先登录', async () => {
    const { w, ws } = open()
    ws.receive({ type: 'unauthenticated', reason: 'missing' })
    await w.vm.$nextTick()
    expect(w.find('[data-testid="logs-unauthenticated"]').exists()).toBe(true)
  })

  it('丢弃早期行后给出截断提示', async () => {
    const { w, ws } = open()
    // 单块内容就超过字符上限,fold 时必然丢掉最早的行。
    const flood = `${'x'.repeat(1000)}\n`.repeat(1200)
    ws.receive(chunk(flood, { nextOffset: flood.length }))
    await w.vm.$nextTick()
    expect(w.find('[data-testid="logs-truncated"]').exists()).toBe(true)
  })
})

describe('LogsPage.vue — 跟随最新', () => {
  /** 给容器装上可控的滚动度量(happy-dom 的默认值全是 0)。 */
  function fakeMetrics(
    el: Element,
    m: { scrollTop: number; scrollHeight: number; clientHeight: number },
  ) {
    let top = m.scrollTop
    Object.defineProperty(el, 'scrollHeight', { value: m.scrollHeight, configurable: true })
    Object.defineProperty(el, 'clientHeight', { value: m.clientHeight, configurable: true })
    Object.defineProperty(el, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = v
      },
    })
  }

  it('停在底部时新内容到达自动滚到底', async () => {
    const { w, ws } = open()
    const body = w.get('[data-testid="logs-body"]').element
    fakeMetrics(body, { scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })
    await body.dispatchEvent(new Event('scroll'))

    ws.receive(chunk('new line\n'))
    await w.vm.$nextTick()
    await w.vm.$nextTick()
    expect(body.scrollTop).toBe(1000)
  })

  it('用户向上滚动后不再抢走视口', async () => {
    const { w, ws } = open()
    const body = w.get('[data-testid="logs-body"]').element
    fakeMetrics(body, { scrollTop: 100, scrollHeight: 1000, clientHeight: 100 })
    await body.dispatchEvent(new Event('scroll'))

    ws.receive(chunk('new line\n'))
    await w.vm.$nextTick()
    await w.vm.$nextTick()
    expect(body.scrollTop).toBe(100)
  })
})
