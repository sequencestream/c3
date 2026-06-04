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

/*
 * reconnecting 中间态(AVAIL-7):agent run 撞到 socket 断连、退避中等待单次自动
 * resume。状态栏须给出独立的「正在重连」反馈(独立 dot class + spinner),而非普通
 * 「思考中」。断言锁结构(dot class / spinner 存在),不锁文案。
 */
describe('SessionStatusBar.vue — reconnecting 中间态', () => {
  it('reconnecting=true:渲染独立 reconnecting 点色 + spinner', () => {
    const w = mountBar({ running: true, reconnecting: true })
    expect(w.find('.status-dot').classes()).toContain('reconnecting')
    expect(w.find('.status-spinner').exists()).toBe(true)
    // 不展示危险态的「继续」按钮。
    expect(w.find('.status-continue').exists()).toBe(false)
  })

  it('reconnecting 优先级高于普通 running:不落到 thinking 点色', () => {
    const normal = mountBar({ running: true, activity: { phase: 'thinking' } as RunActivity })
    const recon = mountBar({
      running: true,
      reconnecting: true,
      activity: { phase: 'thinking' } as RunActivity,
    })
    expect(normal.find('.status-dot').classes()).toContain('running')
    expect(normal.find('.status-dot').classes()).not.toContain('reconnecting')
    expect(recon.find('.status-dot').classes()).toContain('reconnecting')
  })
})

/*
 * 危险态确认(AS-R19):副作用闸门拒绝自动 resume,turn 落到 idle,需用户手动续接。
 * 即便 running=false(已 idle),也须展示确认文案 + 手动「继续」按钮;点击 emit
 * `continue`(App 据此走 user_prompt 续接同一 session)。
 */
describe('SessionStatusBar.vue — 危险态手动 continue', () => {
  it('sideEffectPending=true(已 idle):渲染危险态 + 「继续」按钮', () => {
    const w = mountBar({
      running: false,
      sideEffectPending: true,
      activity: { phase: 'error', message: 'socket' } as RunActivity,
    })
    expect(w.find('.status-continue').exists()).toBe(true)
    // 危险态点色复用 error;不展示重连 spinner。
    expect(w.find('.status-dot').classes()).toContain('error')
    expect(w.find('.status-spinner').exists()).toBe(false)
  })

  it('点击「继续」emit continue', async () => {
    const w = mountBar({ running: false, sideEffectPending: true })
    await w.find('.status-continue').trigger('click')
    expect(w.emitted('continue')).toHaveLength(1)
  })

  it('非危险态:不渲染「继续」按钮', () => {
    const w = mountBar({ running: false, sideEffectPending: false })
    expect(w.find('.status-continue').exists()).toBe(false)
  })
})
