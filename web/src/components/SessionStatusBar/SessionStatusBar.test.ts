import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SessionStatusBar from './SessionStatusBar.vue'
import type { RunActivity } from '../../lib/chat-types'

/*
 * SessionStatusBar — the Stop control moved here from the composer. It's a red
 * square button left of the refresh ↻: enabled while the viewed session is
 * running OR a team is active, disabled when idle. Clicking emits `stop` (App
 * routes both ordinary-turn stop and team teardown through the same `stop_run`).
 * Assertions key off structure (`.status-stop`) and emitted events, never copy.
 */

function mountBar(over: Partial<Record<string, unknown>> = {}) {
  return mount(SessionStatusBar, {
    props: {
      hasActiveSession: true,
      running: false,
      teamActive: false,
      connection: 'open' as const,
      activity: { phase: 'idle' } as RunActivity,
      ...over,
    },
  })
}

describe('SessionStatusBar.vue — 状态栏停止按钮', () => {
  it('空闲(非运行/非团队):停止按钮禁用,不可点击', async () => {
    const w = mountBar({ running: false, teamActive: false })
    const btn = w.find('.status-stop')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeDefined()
    await btn.trigger('click')
    // happy-dom won't fire click on a disabled button, but assert no emit regardless.
    expect(w.emitted('stop')).toBeFalsy()
  })

  it('普通会话运行中:停止按钮可点击,点击 emit stop', async () => {
    const w = mountBar({ running: true, teamActive: false })
    const btn = w.find('.status-stop')
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    expect(w.emitted('stop')).toHaveLength(1)
  })

  it('团队会话进行中:停止按钮可点击,点击 emit stop(结束团队)', async () => {
    const w = mountBar({ running: true, teamActive: true })
    const btn = w.find('.status-stop')
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    expect(w.emitted('stop')).toHaveLength(1)
  })

  it('普通 vs 团队:title 文案不同(stop turn vs end team)', () => {
    const ordinary = mountBar({ running: true, teamActive: false })
    const team = mountBar({ running: true, teamActive: true })
    const ot = ordinary.find('.status-stop').attributes('title')
    const tt = team.find('.status-stop').attributes('title')
    expect(ot).toBeTruthy()
    expect(tt).toBeTruthy()
    expect(ot).not.toBe(tt)
  })

  it('停止按钮位于刷新按钮左侧', () => {
    const w = mountBar({ running: true })
    const buttons = w.findAll('button')
    const stopIdx = buttons.findIndex((b) => b.classes('status-stop'))
    const refreshIdx = buttons.findIndex((b) => b.classes('status-refresh'))
    expect(stopIdx).toBeGreaterThanOrEqual(0)
    expect(refreshIdx).toBeGreaterThan(stopIdx)
  })

  it('刷新按钮行为不变:开放连接下可点击,emit refresh', async () => {
    const w = mountBar({ connection: 'open' })
    await w.find('.status-refresh').trigger('click')
    expect(w.emitted('refresh')).toHaveLength(1)
  })
})
