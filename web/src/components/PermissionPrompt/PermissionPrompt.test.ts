import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PermissionPrompt from './PermissionPrompt.vue'
import type { PermissionMsg } from '../../lib/chat-types'

// PermissionPrompt's c3-gateway provenance tag (2026-06-06-004): a c3/human
// decision that allowed a tool shows the green 「c3 allowed」 tag — the deliberate
// counterpart to ChatMessages' amber 「vendor pre-approved」 tag. Together the two
// colors make explicit that c3 is a gateway, not the sole authority (PG-R12).
// Assertions key off the structural class, never the visible copy (i18n-spec §4).

let nextId = 1
function perm(over: Partial<PermissionMsg> = {}): PermissionMsg {
  return {
    id: nextId++,
    kind: 'permission',
    requestId: `req-${nextId}`,
    toolName: 'bash',
    input: { cmd: 'ls' },
    decision: null,
    ...over,
  }
}

function mountPrompt(m: PermissionMsg, actionable = false) {
  return mount(PermissionPrompt, { props: { m, actionable } })
}

describe('PermissionPrompt.vue — c3 网关放行色标(2026-06-06-004)', () => {
  it('decided allow(c3/人决定放行)→ 渲染 c3-gateway 色标', () => {
    const w = mountPrompt(perm({ decision: 'allow' }))
    expect(w.find('.decided .approval-tag.c3-gateway').exists()).toBe(true)
  })

  it('decided deny → 不渲染 c3-gateway 色标(只有放行才标网关来源)', () => {
    const w = mountPrompt(perm({ decision: 'deny' }))
    expect(w.find('.decided').exists()).toBe(true)
    expect(w.find('.approval-tag.c3-gateway').exists()).toBe(false)
  })

  it('actionable(尚可作答,未决)→ 渲染按钮而非 decided 色标', () => {
    const w = mountPrompt(perm({ decision: null }), true)
    expect(w.find('.actions').exists()).toBe(true)
    expect(w.find('.approval-tag.c3-gateway').exists()).toBe(false)
  })
})

describe('PermissionPrompt.vue — AskQuestion（Cursor 规范名）', () => {
  const askInput = {
    questions: [
      {
        header: '',
        question: '部署到生产？',
        multiSelect: false,
        options: [{ label: '是' }, { label: '否' }],
      },
      {
        header: '',
        question: '执行哪些检查？',
        multiSelect: true,
        options: [{ label: '单测' }, { label: 'E2E' }],
      },
    ],
  }

  it('renders the per-question answer panel and labels the actual tool name', () => {
    const w = mountPrompt(perm({ toolName: 'AskQuestion', input: askInput }), true)
    expect(w.find('.ask-panel').exists()).toBe(true)
    expect(w.find('.label code').text()).toBe('AskQuestion')
    expect(w.findAll('.ask-q')).toHaveLength(2)
    expect(w.find('.actions .deny').exists()).toBe(true)
  })

  it('keeps submit disabled until every question has an answer', async () => {
    const w = mountPrompt(perm({ toolName: 'AskQuestion', input: askInput }), true)
    const submit = () => w.find('.actions button:not(.deny)')
    expect((submit().element as HTMLButtonElement).disabled).toBe(true)
    // 单选答完,多选题仍空 → 依旧禁用。
    await w.findAll('input[type=radio]')[0].setValue(true)
    expect((submit().element as HTMLButtonElement).disabled).toBe(true)
  })

  it('emits submit-ask with question-text keyed answers for single and multi select', async () => {
    const m = perm({ toolName: 'AskQuestion', input: askInput })
    const w = mountPrompt(m, true)
    await w.findAll('input[type=radio]')[0].setValue(true)
    await w.findAll('input[type=checkbox]')[0].setValue(true)
    await w.findAll('input[type=checkbox]')[1].setValue(true)
    await w.find('.actions button:not(.deny)').trigger('click')
    expect(w.emitted('submit-ask')?.[0]).toEqual([
      m,
      { '部署到生产？': '是', '执行哪些检查？': '单测, E2E' },
    ])
  })

  it('collects a custom reply into the answer when the synthetic option is active', async () => {
    const m = perm({
      toolName: 'AskQuestion',
      input: {
        questions: [
          {
            question: '部署方式？',
            header: '',
            multiSelect: false,
            options: [{ label: '直接上' }],
          },
        ],
      },
    })
    const w = mountPrompt(m, true)
    await w.findAll('input[type=radio]')[1].setValue(true) // custom 是单选面板的第二个 radio
    const customInput = w.find('.ask-custom')
    expect(customInput.exists()).toBe(true)
    await customInput.setValue('灰度发布')
    expect((w.find('.actions button:not(.deny)').element as HTMLButtonElement).disabled).toBe(false)
    await w.find('.actions button:not(.deny)').trigger('click')
    expect(w.emitted('submit-ask')?.[0]).toEqual([m, { '部署方式？': '灰度发布' }])
  })

  it('renders a replayed AskQuestion request as a static history line naming the tool', () => {
    const w = mountPrompt(perm({ toolName: 'AskQuestion', input: askInput, decision: null }), false)
    expect(w.find('.perm-history').exists()).toBe(true)
    expect(w.find('.perm-history').text()).toContain('AskQuestion')
    expect(w.find('.actions').exists()).toBe(false)
  })

  it('AskUserQuestion 回归:同一面板按两种 ask 工具渲染', () => {
    const w = mountPrompt(perm({ toolName: 'AskUserQuestion', input: askInput }), true)
    expect(w.find('.ask-panel').exists()).toBe(true)
    expect(w.find('.label code').text()).toBe('AskUserQuestion')
  })
})
