/**
 * `user_prompt` 的只读 kind 门禁 —— 前端聊天列的只读呈现之外的最终防线。
 *
 * `spec_review` 会话由系统运行并产出结论,人只能回放,不能续跑:即便伪造一条
 * `user_prompt`(会话页 / 详情页把它绑成活动会话后,任何入口都可能触发),服务端也必须
 * 在写入消息、改运行状态、team push 或 `launchRun` 之前拒绝。其他 kind 的会话不受影响。
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import type { ServerToClient } from '@ccc/shared/protocol'
import { ensureRuntime, removeRuntime, getRuntime } from '../../runs.js'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { isReadOnlySessionKind, userPrompt } from './index.js'

const proj = '/abs/readonly-proj'
const started: string[] = []

afterEach(() => {
  for (const id of started) removeRuntime(id)
  started.length = 0
})

function runtimeFor(sessionId: string, kind: 'spec_review' | 'spec' | 'work') {
  const rt = ensureRuntime(sessionId, proj, 'default', [], kind)
  started.push(sessionId)
  return rt
}

function fakeConn(viewing: string): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  return {
    sent,
    conn: {
      send: (m: ServerToClient) => sent.push(m),
      viewing,
      deliver: () => {},
      sendWorkspaces: () => {},
      sendSessions: async () => {},
      subject: null,
      authed: true,
      authToken: null,
    } as Conn,
  }
}

describe('isReadOnlySessionKind', () => {
  it('只把 spec_review 视为只读', () => {
    expect(isReadOnlySessionKind('spec_review')).toBe(true)
    for (const kind of ['work', 'intent', 'spec', 'discussion', 'automation', 'tool'] as const) {
      expect(isReadOnlySessionKind(kind)).toBe(false)
    }
  })
})

describe('userPrompt — spec_review 只读门禁', () => {
  it('拒绝伪造输入:不 launch、不改状态、不追加消息', async () => {
    const rt = runtimeFor('rev-1', 'spec_review')
    const bufferBefore = rt.buffer.length
    const launchRun = vi.fn()
    const { conn, sent } = fakeConn('rev-1')

    await userPrompt({ launchRun } as unknown as KernelContext, conn, {
      type: 'user_prompt',
      text: 'please approve',
    })

    expect(sent).toEqual([{ type: 'error', error: { code: 'session.readOnly' } }])
    expect(launchRun).not.toHaveBeenCalled()
    const after = getRuntime('rev-1')!
    expect(after.status).toBe('idle')
    expect(after.run).toBeFalsy()
    expect(after.buffer.length).toBe(bufferBefore)
  })

  it('即便评审会话是 team 常驻态也不 push 输入', async () => {
    const rt = runtimeFor('rev-team', 'spec_review')
    const pushInput = vi.fn()
    rt.team = true
    rt.run = { abort: new AbortController(), handle: { pushInput } as never }
    const launchRun = vi.fn()
    const { conn, sent } = fakeConn('rev-team')

    await userPrompt({ launchRun } as unknown as KernelContext, conn, {
      type: 'user_prompt',
      text: 'continue',
    })

    expect(sent).toEqual([{ type: 'error', error: { code: 'session.readOnly' } }])
    expect(pushInput).not.toHaveBeenCalled()
    expect(launchRun).not.toHaveBeenCalled()
    expect(getRuntime('rev-team')!.status).toBe('idle')
    // 拒绝不会顺手拆掉这个 run(评审执行本身不受影响)。
    expect(getRuntime('rev-team')!.run).toBeDefined()
    rt.run = null
  })

  it('规范撰写会话不受影响,照常 launch', async () => {
    runtimeFor('spec-1', 'spec')
    const launchRun = vi.fn().mockResolvedValue(undefined)
    const { conn, sent } = fakeConn('spec-1')

    await userPrompt({ launchRun } as unknown as KernelContext, conn, {
      type: 'user_prompt',
      text: 'tighten the scope',
    })

    expect(sent).toEqual([])
    expect(launchRun).toHaveBeenCalledTimes(1)
  })
})
