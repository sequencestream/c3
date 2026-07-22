import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import { createState, sumSessionCounts, type StateDeps } from './state'
import type { SessionPageKind } from './state'

function counts(
  partial: Partial<Record<SessionPageKind, number>>,
): Record<SessionPageKind, number> {
  return { work: 0, intent: 0, spec: 0, discussion: 0, automation: 0, tool: 0, ...partial }
}

describe('sumSessionCounts — 顶部「会话」tab 角标数值(六类求和)', () => {
  it('多类混合求和:六类各自计数相加', () => {
    expect(
      sumSessionCounts(
        counts({ work: 2, intent: 1, spec: 3, discussion: 1, automation: 4, tool: 2 }),
      ),
    ).toBe(13)
  })

  it('部分类有值、其余为 0 时只累加非零项', () => {
    expect(sumSessionCounts(counts({ work: 1, intent: 2 }))).toBe(3)
  })

  it('全 0 时和为 0(上层据此不渲染角标)', () => {
    expect(sumSessionCounts(counts({}))).toBe(0)
  })

  it('tool 关闭(服务端不推送 → tool=0)时不计入 tool', () => {
    const open = sumSessionCounts(counts({ work: 1, intent: 1, tool: 3 }))
    const closed = sumSessionCounts(counts({ work: 1, intent: 1, tool: 0 }))
    expect(open).toBe(5)
    expect(closed).toBe(2)
  })
})

// HEADER_TABS computed 与 sessionCounts 同源:console 项 badgeCount 即六类之和,
// 随 sessionCounts 响应式刷新;非 console 项无 badgeCount。
describe('createState — HEADER_TABS sessions visibility', () => {
  function makeState() {
    const deps = {
      t: (key: string) => key,
      modeLabel: (code: string) => code,
      auth: { status: ref('unknown') },
    } as unknown as StateDeps
    return createState(deps)
  }

  it('unknown and false omit console; true appends it after codes', () => {
    const s = makeState()
    expect(s.HEADER_TABS.value.map((tab) => tab.key)).toEqual([
      'intents',
      'discussion',
      'automations',
      'codes',
    ])
    s.serverSettings.value = { showSessionsPage: false } as never
    expect(s.HEADER_TABS.value.some((tab) => tab.key === 'console')).toBe(false)
    s.serverSettings.value = { showSessionsPage: true } as never
    expect(s.HEADER_TABS.value.map((tab) => tab.key)).toEqual([
      'intents',
      'discussion',
      'automations',
      'codes',
      'console',
    ])
  })

  it('visible console badgeCount follows the six session counts', () => {
    const s = makeState()
    s.serverSettings.value = { showSessionsPage: true } as never
    const consoleTab = () => s.HEADER_TABS.value.find((tab) => tab.key === 'console')

    expect(consoleTab()?.badgeCount).toBe(0)

    s.sessionCounts.value = counts({ work: 2, intent: 1, automation: 1 })
    expect(consoleTab()?.badgeCount).toBe(4)

    // 模拟 session_counts 增量推送后的合并结果。
    s.sessionCounts.value = { ...s.sessionCounts.value, tool: 3 }
    expect(consoleTab()?.badgeCount).toBe(7)
  })

  it('其余 tab 无 badgeCount', () => {
    const s = makeState()
    s.sessionCounts.value = counts({ work: 5 })
    for (const tab of s.HEADER_TABS.value) {
      if (tab.key !== 'console') expect(tab.badgeCount).toBeUndefined()
    }
  })
})
