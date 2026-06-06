import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ChatMessages from './ChatMessages.vue'
import type { ChatMsg, SpeakerView } from '../../lib/chat-types'

let nextId = 1
function id(): number {
  return nextId++
}

function toolUse(toolName: string, input: unknown): ChatMsg {
  return { id: id(), kind: 'tool-use', toolUseId: `u${nextId}`, toolName, input }
}
function toolUsePre(toolName: string, input: unknown, preApproved: boolean): ChatMsg {
  return { id: id(), kind: 'tool-use', toolUseId: `u${nextId}`, toolName, input, preApproved }
}
function speakerMsg(text: string, speaker?: SpeakerView): ChatMsg {
  return { id: id(), kind: 'assistant', text, speaker }
}
function permission(toolName: string, requestId: string): ChatMsg {
  return { id: id(), kind: 'permission', requestId, toolName, input: {}, decision: null }
}

function mountChat(messages: ChatMsg[], actionablePermissionId: string | null = null) {
  return mount(ChatMessages, {
    props: { messages, hasActiveSession: true, actionablePermissionId },
  })
}

describe('ChatMessages.vue — 折叠批次头追加首个工具请求预览', () => {
  it('单工具 batch:摘要后展示该 tool-use 的单行预览', () => {
    const w = mountChat([toolUse('Write', { file_path: '/a/b.ts', content: 'x' })])
    const head = w.find('.batch-summary')
    expect(head.text()).toContain('Write.1')
    // 预览来自 oneLine(fmt(input)) —— input 字段压成单行后出现在头部。
    const preview = w.find('.batch-preview')
    expect(preview.exists()).toBe(true)
    expect(preview.text()).toContain('file_path')
    expect(preview.text()).toContain('/a/b.ts')
  })

  it('多工具 batch:预览取第一个 tool-use,而非其后的工具', () => {
    const w = mountChat([
      toolUse('Read', { file_path: '/first.ts' }),
      toolUse('Write', { file_path: '/second.ts' }),
    ])
    const head = w.find('.batch-summary')
    expect(head.text()).toContain('Read.1')
    expect(head.text()).toContain('Write.1')
    const preview = w.find('.batch-preview')
    expect(preview.text()).toContain('/first.ts')
    expect(preview.text()).not.toContain('/second.ts')
  })

  it('预览与摘要同处一个 .batch-summary,共享 CSS ellipsis(不换行截断)', () => {
    const w = mountChat([toolUse('Write', { content: 'A'.repeat(500) })])
    // 预览嵌在 .batch-summary 之内,由其 white-space:nowrap + text-overflow:ellipsis 截断,
    // 不手动截字 —— 断言结构关系即可。
    expect(w.find('.batch-summary .batch-preview').exists()).toBe(true)
  })

  it('仅 permission(无 tool-use)的 batch:不追加预览、回退权限工具名、不报错', () => {
    const w = mountChat([permission('Bash', 'req-1')], null)
    const head = w.find('.batch-summary')
    expect(head.text()).toContain('Bash.1')
    expect(w.find('.batch-preview').exists()).toBe(false)
  })

  it('展开后:批次头回到纯 Name.count(不显示预览),body 逐项渲染', async () => {
    const w = mountChat([toolUse('Write', { file_path: '/a/b.ts' })])
    expect(w.find('.batch-preview').exists()).toBe(true)
    await w.find('.batch-head').trigger('click')
    // 展开态头部不再展示预览;body 出现工具卡片。
    expect(w.find('.batch-preview').exists()).toBe(false)
    expect(w.find('.batch-body').exists()).toBe(true)
    expect(w.find('.batch-body .tool-label').text()).toContain('Write')
  })

  it('待处理 permission 强制展开:batch 打开、头部不显示预览、body 渲染、不报错', () => {
    const w = mountChat(
      [toolUse('Write', { file_path: '/a/b.ts' }), permission('Write', 'req-live')],
      'req-live',
    )
    // hasPending 强制 open。
    expect(w.find('.batch.open').exists()).toBe(true)
    expect(w.find('.batch-preview').exists()).toBe(false)
    expect(w.find('.batch-body').exists()).toBe(true)
  })
})

describe('ChatMessages.vue — 异构 vendor 徽章(2026-06-06-004)', () => {
  it('discussion 发言带 speaker.vendor → 渲染对应 vendor-tag(claude / opencode 各色)', () => {
    const w = mountChat([
      speakerMsg('hi', { icon: '🤖', name: 'Claude A', vendor: 'claude' }),
      speakerMsg('yo', { icon: '🦊', name: 'OpenCode A', vendor: 'opencode' }),
    ])
    // 双家同席:两个 vendor 各自的色标类都在,来源可识别。
    expect(w.find('.vendor-tag.vendor-claude').exists()).toBe(true)
    expect(w.find('.vendor-tag.vendor-opencode').exists()).toBe(true)
  })

  it('speaker 无 vendor(human / organizer)→ 有 speaker 行但不渲染 vendor-tag', () => {
    const w = mountChat([speakerMsg('q', { icon: '🙋', name: 'You' })])
    expect(w.find('.speaker').exists()).toBe(true)
    expect(w.find('.vendor-tag').exists()).toBe(false)
  })

  it('session 路径(无 speaker)→ 既无 speaker 行也无 vendor-tag(单人布局不回归)', () => {
    const w = mountChat([speakerMsg('plain')])
    expect(w.find('.speaker').exists()).toBe(false)
    expect(w.find('.vendor-tag').exists()).toBe(false)
  })
})

describe('ChatMessages.vue — 审批双色标(预放行 vs c3 手动)(2026-06-06-004)', () => {
  it('preApproved tool-use:展开后渲染「厂商规则预放行」色标', async () => {
    const w = mountChat([toolUsePre('bash', { cmd: 'ls' }, true)])
    await w.find('.batch-head').trigger('click')
    expect(w.find('.approval-tag.pre-approved').exists()).toBe(true)
  })

  it('c3 把关的普通 tool-use(无 preApproved)→ 不渲染预放行色标', async () => {
    const w = mountChat([toolUse('bash', { cmd: 'ls' })])
    await w.find('.batch-head').trigger('click')
    expect(w.find('.approval-tag.pre-approved').exists()).toBe(false)
  })
})
