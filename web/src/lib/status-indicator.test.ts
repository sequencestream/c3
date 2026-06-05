import { describe, it, expect } from 'vitest'
import {
  sessionStatusIndicator,
  discussionRowIndicator,
  TONE_ICON,
  type StatusTone,
} from './status-indicator'
import type { RunActivity } from './chat-types'

/*
 * status-indicator — the shared `<icon> <agent>.<status>` model. These cover the
 * two pure state→indicator mappers: the precedence/取舍 each consumer encodes and
 * the no-agent graceful degradation (`agent` omitted ⇒ no leftover separator).
 * DOM-free; the components only resolve i18n text on top of these.
 */

function session(over: Partial<Parameters<typeof sessionStatusIndicator>[0]> = {}) {
  return sessionStatusIndicator({
    running: false,
    teamActive: false,
    activity: { phase: 'idle' } as RunActivity,
    ...over,
  })
}

describe('sessionStatusIndicator — 状态取舍与降级', () => {
  it('reconnecting 优先于一切(含 running+thinking)', () => {
    const ind = session({ running: true, reconnecting: true, activity: { phase: 'thinking' } })
    expect(ind.tone).toBe<StatusTone>('reconnecting')
    expect(ind.spin).toBe(true)
    expect(ind.statusKey).toBe('session.statusBar.reconnecting')
  })

  it('sideEffectPending(已 idle)→ error 态、不 spin', () => {
    const ind = session({ running: false, sideEffectPending: true })
    expect(ind.tone).toBe<StatusTone>('error')
    expect(ind.spin).toBe(false)
    expect(ind.statusKey).toBe('session.statusBar.sideEffectPending')
  })

  it('activity.error → error 态并带 message 参数', () => {
    const ind = session({ running: true, activity: { phase: 'error', message: 'boom' } })
    expect(ind.tone).toBe<StatusTone>('error')
    expect(ind.statusKey).toBe('session.statusBar.error')
    expect(ind.statusParams).toEqual({ message: 'boom' })
  })

  it('非运行 → idle/ready', () => {
    const ind = session({ running: false })
    expect(ind.tone).toBe<StatusTone>('idle')
    expect(ind.statusKey).toBe('session.statusBar.ready')
  })

  it('awaiting → awaiting 态', () => {
    const ind = session({ running: true, activity: { phase: 'awaiting' } })
    expect(ind.tone).toBe<StatusTone>('awaiting')
    expect(ind.statusKey).toBe('session.statusBar.awaiting')
  })

  it('team 在回合间(idle)→ running 态、teamRunning 文案、spin', () => {
    const ind = session({ running: true, teamActive: true, activity: { phase: 'idle' } })
    expect(ind.tone).toBe<StatusTone>('running')
    expect(ind.spin).toBe(true)
    expect(ind.statusKey).toBe('session.statusBar.teamRunning')
  })

  it('tool → running 态并带 toolName 参数', () => {
    const ind = session({ running: true, activity: { phase: 'tool', toolName: 'Bash' } })
    expect(ind.tone).toBe<StatusTone>('running')
    expect(ind.statusKey).toBe('session.statusBar.runningTool')
    expect(ind.statusParams).toEqual({ toolName: 'Bash' })
  })

  it('普通运行(thinking)→ running/thinking', () => {
    const ind = session({ running: true, activity: { phase: 'thinking' } })
    expect(ind.tone).toBe<StatusTone>('running')
    expect(ind.statusKey).toBe('session.statusBar.thinking')
  })

  it('agent 名存在 → 作为前缀;空白/缺失 → 优雅省略', () => {
    expect(session({ running: true, currentAgentName: 'Echo' }).agent).toBe('Echo')
    expect(session({ running: true, currentAgentName: '   ' }).agent).toBeUndefined()
    expect(session({ running: true }).agent).toBeUndefined()
  })
})

describe('discussionRowIndicator — run 优先于生命周期 + 无 agent 降级', () => {
  it('有 running run → run 态压过生命周期,agent 取在途名', () => {
    const ind = discussionRowIndicator({
      status: 'in_progress',
      runState: 'running',
      agentName: 'Planner',
    })
    expect(ind.tone).toBe<StatusTone>('running')
    expect(ind.spin).toBe(true)
    expect(ind.statusKey).toBe('discussion.item.run.running.label')
    expect(ind.agent).toBe('Planner')
  })

  it('有 paused run → paused 态、不 spin', () => {
    const ind = discussionRowIndicator({
      status: 'in_progress',
      runState: 'paused',
      agentName: 'Planner',
    })
    expect(ind.tone).toBe<StatusTone>('paused')
    expect(ind.spin).toBe(false)
    expect(ind.statusKey).toBe('discussion.item.run.paused.label')
    expect(ind.agent).toBe('Planner')
  })

  it('run 在途但无 agent 名 → agent 省略(降级),仍为 run 态', () => {
    const ind = discussionRowIndicator({ status: 'in_progress', runState: 'running' })
    expect(ind.tone).toBe<StatusTone>('running')
    expect(ind.agent).toBeUndefined()
  })

  it('无 run → 回退生命周期态,且无 agent 段', () => {
    const cases: Array<[Parameters<typeof discussionRowIndicator>[0]['status'], StatusTone]> = [
      ['draft', 'draft'],
      ['in_progress', 'in_progress'],
      ['completed', 'completed'],
      ['cancelled', 'cancelled'],
    ]
    for (const [status, tone] of cases) {
      const ind = discussionRowIndicator({ status, runState: undefined })
      expect(ind.tone).toBe(tone)
      expect(ind.statusKey).toBe(`discussion.status.${status}`)
      expect(ind.agent).toBeUndefined()
      expect(ind.spin).toBe(false)
    }
  })
})

describe('TONE_ICON — 每个 tone 都有非空图标', () => {
  it('全部 tone 映射到非空 emoji', () => {
    const tones: StatusTone[] = [
      'running',
      'paused',
      'awaiting',
      'reconnecting',
      'error',
      'idle',
      'draft',
      'in_progress',
      'completed',
      'cancelled',
    ]
    for (const tone of tones) {
      expect(TONE_ICON[tone]).toBeTruthy()
    }
  })
})
