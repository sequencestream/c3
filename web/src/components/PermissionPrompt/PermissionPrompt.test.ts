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
