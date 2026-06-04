import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import MessageInput from './MessageInput.vue'

/*
 * MessageInput auto-grow — the composer textarea sizes its height to content up
 * to a 200px cap, then scrolls internally; clearing/prefill/send keep it in sync.
 *
 * happy-dom never computes a real `scrollHeight`, so we stub the element's
 * getter to a controllable value. The component's resize path reads it after
 * resetting `height` to `auto`; our getter ignores style, making the geometry
 * deterministic. We assert the inline `height`/`overflowY` the component writes.
 */

function mountInput() {
  return mount(MessageInput, {
    props: {
      running: false,
      teamActive: false,
      hasActiveSession: true,
      availableCommands: [],
      voiceLang: 'en-US',
    },
  })
}

// Make `scrollHeight` controllable per assertion (happy-dom returns 0 otherwise).
let scrollHeight = 0
function stubScrollHeight(el: HTMLElement): void {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => scrollHeight,
  })
}

describe('MessageInput.vue — 输入框自动增高(auto-grow)', () => {
  beforeEach(() => {
    scrollHeight = 0
  })

  it('键入多行内容:高度跟随内容(上限内),不出现内部滚动条', async () => {
    const w = mountInput()
    const el = w.find('textarea').element as HTMLTextAreaElement
    stubScrollHeight(el)

    scrollHeight = 96
    await w.find('textarea').setValue('line1\nline2\nline3')
    await nextTick()

    expect(el.style.height).toBe('96px')
    expect(el.style.overflowY).toBe('hidden')
  })

  it('内容超过上限:高度封顶到 200px 并出现内部滚动条', async () => {
    const w = mountInput()
    const el = w.find('textarea').element as HTMLTextAreaElement
    stubScrollHeight(el)

    scrollHeight = 480
    await w.find('textarea').setValue('a\n'.repeat(40))
    await nextTick()

    expect(el.style.height).toBe('200px')
    expect(el.style.overflowY).toBe('auto')
  })

  it('清空文本:高度复位回单行(收缩到内容高度)', async () => {
    const w = mountInput()
    const el = w.find('textarea').element as HTMLTextAreaElement
    stubScrollHeight(el)

    scrollHeight = 480
    await w.find('textarea').setValue('a\n'.repeat(40))
    await nextTick()
    expect(el.style.height).toBe('200px')

    scrollHeight = 24
    await w.find('textarea').setValue('')
    await nextTick()
    expect(el.style.height).toBe('24px')
    expect(el.style.overflowY).toBe('hidden')
  })

  it('prefill(待发队列回填):高度同步刷新', async () => {
    const w = mountInput()
    const el = w.find('textarea').element as HTMLTextAreaElement
    stubScrollHeight(el)

    scrollHeight = 140
    ;(w.vm as unknown as { prefill: (t: string) => void }).prefill('queued\nmulti\nline')
    await nextTick()
    await nextTick()

    expect(el.style.height).toBe('140px')
    expect(el.style.overflowY).toBe('hidden')
  })

  it('发送成功后清空:高度复位', async () => {
    const w = mountInput()
    const el = w.find('textarea').element as HTMLTextAreaElement
    stubScrollHeight(el)

    scrollHeight = 480
    await w.find('textarea').setValue('a\n'.repeat(40))
    await nextTick()
    expect(el.style.height).toBe('200px')

    scrollHeight = 24
    await w.find('.send-btn').trigger('click')
    await nextTick()

    expect(w.emitted('submit')).toBeTruthy()
    expect(el.style.height).toBe('24px')
  })
})
