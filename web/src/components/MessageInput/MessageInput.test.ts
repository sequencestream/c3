import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import MessageInput from './MessageInput.vue'
import * as promptImage from '../../lib/prompt-image'

// Drive image intake deterministically: stub the DOM-bound readImageFiles (which
// would otherwise reach for FileReader/Image/canvas) while keeping the real
// toWire/fromWire so the emitted payload reflects production mapping.
vi.mock('../../lib/prompt-image', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/prompt-image')>('../../lib/prompt-image')
  return { ...actual, readImageFiles: vi.fn() }
})
const readImageFiles = vi.mocked(promptImage.readImageFiles)

function processed(over: Partial<promptImage.ProcessedImage> = {}): promptImage.ProcessedImage {
  return {
    mediaType: 'image/png',
    data: 'AAAA',
    previewUrl: 'data:image/png;base64,AAAA',
    bytes: 3,
    name: 'shot.png',
    ...over,
  }
}

// Intake awaits readImageFiles then mutates reactive state — flush both the
// awaited promise chain and the ensuing render.
async function flush(): Promise<void> {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

const pngFile = (): File => new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })

/*
 * MessageInput auto-grow — the composer textarea sizes its height to content up
 * to a 200px cap, then scrolls internally; clearing/prefill/send keep it in sync.
 *
 * happy-dom never computes a real `scrollHeight`, so we stub the element's
 * getter to a controllable value. The component's resize path reads it after
 * resetting `height` to `auto`; our getter ignores style, making the geometry
 * deterministic. We assert the inline `height`/`overflowY` the component writes.
 */

function mountInput(over: Partial<Record<string, unknown>> = {}) {
  return mount(MessageInput, {
    props: {
      running: false,
      teamActive: false,
      hasActiveSession: true,
      availableCommands: [],
      voiceLang: 'en-US',
      ...over,
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

const originalVisualViewport = window.visualViewport

afterEach(() => {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: originalVisualViewport,
  })
  document.documentElement.style.removeProperty('--composer-keyboard-offset')
})

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

describe('MessageInput.vue — 停止控件已上移到状态栏', () => {
  it('普通运行中:输入区不再有 Stop 按钮,Send 文案保持不变', () => {
    const idle = mountInput({ running: false })
    const running = mountInput({ running: true })
    // No Stop/End-team button in the composer anymore.
    expect(running.find('.stop-btn').exists()).toBe(false)
    // Send copy is fixed: identical between idle and running.
    expect(running.find('.send-btn').text()).toBe(idle.find('.send-btn').text())
  })

  it('团队会话:输入区不再有 End team 按钮', () => {
    const w = mountInput({ running: true, teamActive: true })
    expect(w.find('.stop-btn').exists()).toBe(false)
  })

  it('组件不再声明 stop 事件(停止经由状态栏)', () => {
    const w = mountInput({ running: true })
    expect(w.vm.$options.emits).not.toContain('stop')
  })

  it('普通运行中点击 Send:入队(enqueue)而非提交,功能不变', async () => {
    const w = mountInput({ running: true })
    await w.find('textarea').setValue('hello')
    await w.find('.send-btn').trigger('click')
    expect(w.emitted('enqueue')).toHaveLength(1)
    expect(w.emitted('submit')).toBeFalsy()
  })
})

describe('MessageInput.vue — 输入框选图(点击/粘贴/拖拽)', () => {
  beforeEach(() => {
    readImageFiles.mockReset()
    readImageFiles.mockResolvedValue({ images: [processed()], rejectedCount: 0 })
  })

  it('点击附件按钮:触发隐藏 file input 的文件选择', async () => {
    const w = mountInput()
    const fileEl = w.find('input.file-input').element as HTMLInputElement
    const clickSpy = vi.spyOn(fileEl, 'click')
    await w.find('.attach-btn').trigger('click')
    expect(clickSpy).toHaveBeenCalledTimes(1)
  })

  it('选图(file input change):缩略图展示已选图片', async () => {
    const w = mountInput()
    readImageFiles.mockResolvedValue({
      images: [processed(), processed({ name: 'b.png' })],
      rejectedCount: 0,
    })
    const fileEl = w.find('input.file-input').element as HTMLInputElement
    Object.defineProperty(fileEl, 'files', { configurable: true, value: [pngFile(), pngFile()] })
    await w.find('input.file-input').trigger('change')
    await flush()
    expect(w.findAll('.image-thumb')).toHaveLength(2)
  })

  it('粘贴图片:加入待发送列表', async () => {
    const w = mountInput()
    await w.find('textarea').trigger('paste', { clipboardData: { files: [pngFile()] } })
    await flush()
    expect(w.findAll('.image-thumb')).toHaveLength(1)
  })

  it('粘贴纯文本(无文件):不拦截、不加图', async () => {
    const w = mountInput()
    await w.find('textarea').trigger('paste', { clipboardData: { files: [] } })
    await flush()
    expect(readImageFiles).not.toHaveBeenCalled()
    expect(w.findAll('.image-thumb')).toHaveLength(0)
  })

  it('拖拽放下图片:加入待发送列表', async () => {
    const w = mountInput()
    await w.find('.message-input').trigger('drop', { dataTransfer: { files: [pngFile()] } })
    await flush()
    expect(w.findAll('.image-thumb')).toHaveLength(1)
  })

  it('删除某张缩略图:不再展示且发送不携带它', async () => {
    const w = mountInput()
    readImageFiles.mockResolvedValue({
      images: [processed({ data: 'AAAA' }), processed({ data: 'BBBB', name: 'b.png' })],
      rejectedCount: 0,
    })
    const fileEl = w.find('input.file-input').element as HTMLInputElement
    Object.defineProperty(fileEl, 'files', { configurable: true, value: [pngFile(), pngFile()] })
    await w.find('input.file-input').trigger('change')
    await flush()
    expect(w.findAll('.image-thumb')).toHaveLength(2)

    await w.findAll('.image-remove')[0].trigger('click')
    expect(w.findAll('.image-thumb')).toHaveLength(1)

    await w.find('.send-btn').trigger('click')
    const payload = w.emitted('submit')?.[0]
    expect(payload?.[1]).toEqual([{ mediaType: 'image/png', data: 'BBBB' }])
  })

  it('发送:图片(wire 形态)随文本一并提交并清空', async () => {
    const w = mountInput()
    await w.find('.message-input').trigger('drop', { dataTransfer: { files: [pngFile()] } })
    await flush()
    await w.find('textarea').setValue('look at this')
    await w.find('.send-btn').trigger('click')

    expect(w.emitted('submit')?.[0]).toEqual([
      'look at this',
      [{ mediaType: 'image/png', data: 'AAAA' }],
    ])
    // Thumbnails clear after send.
    expect(w.findAll('.image-thumb')).toHaveLength(0)
  })

  it('仅图片(无文本)也可发送', async () => {
    const w = mountInput()
    await w.find('.message-input').trigger('drop', { dataTransfer: { files: [pngFile()] } })
    await flush()
    // Send is enabled with images but no text.
    expect((w.find('.send-btn').element as HTMLButtonElement).disabled).toBe(false)
    await w.find('.send-btn').trigger('click')
    expect(w.emitted('submit')?.[0]).toEqual(['', [{ mediaType: 'image/png', data: 'AAAA' }]])
  })

  it('运行中发送带图:走入队(enqueue)并携带图片', async () => {
    const w = mountInput({ running: true })
    await w.find('.message-input').trigger('drop', { dataTransfer: { files: [pngFile()] } })
    await flush()
    await w.find('textarea').setValue('queued with image')
    await w.find('.send-btn').trigger('click')
    expect(w.emitted('enqueue')?.[0]).toEqual([
      'queued with image',
      [{ mediaType: 'image/png', data: 'AAAA' }],
    ])
    expect(w.emitted('submit')).toBeFalsy()
  })

  it('非图片文件被拒:显示忽略提示', async () => {
    const w = mountInput()
    readImageFiles.mockResolvedValue({ images: [], rejectedCount: 1 })
    await w.find('.message-input').trigger('drop', { dataTransfer: { files: [pngFile()] } })
    await flush()
    expect(w.find('.attach-notice').exists()).toBe(true)
    expect(w.findAll('.image-thumb')).toHaveLength(0)
  })

  it('无文本无图片:发送按钮禁用', () => {
    const w = mountInput()
    expect((w.find('.send-btn').element as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('MessageInput.vue — 移动端软键盘避让', () => {
  it('visualViewport 变化时同步 composer 键盘偏移 CSS 变量', async () => {
    const viewport = new EventTarget() as EventTarget & {
      height: number
      offsetTop: number
      addEventListener: EventTarget['addEventListener']
      removeEventListener: EventTarget['removeEventListener']
    }
    viewport.height = 520
    viewport.offsetTop = 0
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })

    const w = mountInput()
    await nextTick()

    expect(document.documentElement.style.getPropertyValue('--composer-keyboard-offset')).toBe(
      '280px',
    )

    viewport.height = 700
    viewport.dispatchEvent(new Event('resize'))

    expect(document.documentElement.style.getPropertyValue('--composer-keyboard-offset')).toBe(
      '100px',
    )

    w.unmount()
    expect(document.documentElement.style.getPropertyValue('--composer-keyboard-offset')).toBe('')
  })
})
