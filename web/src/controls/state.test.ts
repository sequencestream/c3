import { describe, it, expect } from 'vitest'
import { ref } from 'vue'
import {
  createState,
  emptyOwnerCounts,
  runningSessionsFingerprint,
  runningSessionsFingerprintOf,
  sumSessionCounts,
  type StateDeps,
} from './state'
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

  it('「代码」tab 无 badgeCount;会话计数不外溢到条目角标', () => {
    const s = makeState()
    s.sessionCounts.value = counts({ work: 5 })
    expect(s.HEADER_TABS.value.find((tab) => tab.key === 'codes')?.badgeCount).toBeUndefined()
    for (const key of ['intents', 'discussion', 'automations'] as const) {
      expect(s.HEADER_TABS.value.find((tab) => tab.key === key)?.badgeCount).toBe(0)
    }
  })
})

// 工作台首个前端状态的默认活动页:待办性质的「用户通知」优先,免去进入后再点一次。
describe('createState — workcenterPage 初始值', () => {
  function makeState() {
    const deps = {
      t: (key: string) => key,
      modeLabel: (code: string) => code,
      auth: { status: ref('unknown') },
    } as unknown as StateDeps
    return createState(deps)
  }

  it('新建状态默认停在「用户通知」而非「总览」', () => {
    const s = makeState()
    expect(s.workcenterPage.value).toBe('notifications')
  })
})

// 顶部「意图/讨论/自动化」角标:各自独立读 ownerRunningCounts(服务端按 owner 去重后的
// 条目数),0 时上层 `v-if="tab.badgeCount"` 不渲染;无障碍文案按 tab 生成而非共用会话文案。
describe('createState — HEADER_TABS 进行中条目角标', () => {
  function makeState() {
    const deps = {
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key,
      modeLabel: (code: string) => code,
      auth: { status: ref('unknown') },
    } as unknown as StateDeps
    return createState(deps)
  }

  function badgeOf(s: ReturnType<typeof makeState>, key: string): number | undefined {
    return s.HEADER_TABS.value.find((tab) => tab.key === key)?.badgeCount
  }

  it('三个 tab 各自读自己的计数,互不串位', () => {
    const s = makeState()
    s.ownerRunningCounts.value = { intent: 2, discussion: 1, automation: 3 }
    expect(badgeOf(s, 'intents')).toBe(2)
    expect(badgeOf(s, 'discussion')).toBe(1)
    expect(badgeOf(s, 'automations')).toBe(3)
  })

  it('计数更新后角标响应式跟随(无需重建状态)', () => {
    const s = makeState()
    expect(badgeOf(s, 'intents')).toBe(0)
    s.ownerRunningCounts.value = { ...emptyOwnerCounts(), intent: 1 }
    expect(badgeOf(s, 'intents')).toBe(1)
    s.ownerRunningCounts.value = emptyOwnerCounts()
    expect(badgeOf(s, 'intents')).toBe(0)
  })

  it('角标无障碍文案按 tab 取,不共用「会话」文案', () => {
    const s = makeState()
    s.ownerRunningCounts.value = { intent: 2, discussion: 1, automation: 3 }
    const aria = (key: string): string | undefined =>
      s.HEADER_TABS.value.find((tab) => tab.key === key)?.badgeAriaLabel
    expect(aria('intents')).toBe('nav.tab.intents.ariaLabel:{"count":2}')
    expect(aria('discussion')).toBe('nav.tab.discussion.ariaLabel:{"count":1}')
    expect(aria('automations')).toBe('nav.tab.automations.ariaLabel:{"count":3}')
  })

  it('「会话」tab 角标仍是六类会话求和,与条目计数互不影响', () => {
    const s = makeState()
    s.serverSettings.value = { showSessionsPage: true } as never
    s.ownerRunningCounts.value = { intent: 1, discussion: 0, automation: 0 }
    s.sessionCounts.value = counts({ work: 2, spec: 1 })
    expect(badgeOf(s, 'console')).toBe(3)
    expect(badgeOf(s, 'intents')).toBe(1)
  })
})

// 运行集合指纹:session_status 是全量快照,指纹变化才代表「有会话开始/结束执行」,
// 是顶部角标向服务端重取权威计数的触发条件。
describe('runningSessionsFingerprint — 运行集合变化判定', () => {
  it('idle 会话不进指纹,顺序不同视为同一集合', () => {
    expect(runningSessionsFingerprint({ a: 'running', b: 'idle', c: 'team' })).toBe('a,c')
    expect(
      runningSessionsFingerprintOf([
        { sessionId: 'c', status: 'team' },
        { sessionId: 'b', status: 'idle' },
        { sessionId: 'a', status: 'running' },
      ]),
    ).toBe('a,c')
  })

  it('idle → running → idle 两次跃迁都改变指纹', () => {
    const idle = runningSessionsFingerprintOf([{ sessionId: 'a', status: 'idle' }])
    const running = runningSessionsFingerprintOf([{ sessionId: 'a', status: 'running' }])
    expect(running).not.toBe(idle)
    expect(runningSessionsFingerprintOf([{ sessionId: 'a', status: 'idle' }])).toBe(idle)
  })

  it('同一快照重播指纹不变(不触发重复请求)', () => {
    const statuses = [
      { sessionId: 'a', status: 'running' as const },
      { sessionId: 'b', status: 'awaiting_permission' as const },
    ]
    expect(runningSessionsFingerprintOf(statuses)).toBe(
      runningSessionsFingerprint({ a: 'running', b: 'awaiting_permission' }),
    )
  })
})
