/**
 * Driver-path `save_intents` confirmation gate (2026-06-12-005). Verifies the gate
 * semantics with the real store + injected emit/waitForDecision:
 *  - allow ⇒ emits the `permission_request` frame, then persists + broadcasts.
 *  - deny  ⇒ emits the frame, persists NOTHING, returns a "拒绝" result.
 *  - the emitted frame mirrors the claude path (toolName mcp__c3__save_intents,
 *    input.intents, routed to the live run id from `getRunId`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { listIntents, resetStoreForTests } from './store.js'
import { gatedSave, type SaveGateBinding } from './save-gate.js'

const proj = '/abs/save-gate-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-save-gate-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function binding(over: Partial<SaveGateBinding> = {}): SaveGateBinding {
  return {
    workspacePath: proj,
    getRunId: () => 'run-1',
    signal: new AbortController().signal,
    ...over,
  }
}

const oneIntent = {
  intents: [
    { title: '加缓存', shortEnTitle: 'auto', content: '给热点接口加缓存', priority: 'P1' as const },
  ],
}

describe('gatedSave', () => {
  it('allow ⇒ emits permission_request then persists + broadcasts', async () => {
    const emitted: ServerToClient[] = []
    const broadcastIntents = vi.fn()
    const waitForDecision = vi.fn(async () => ({ decision: 'allow' as const }))

    const res = await gatedSave(
      {
        emit: (_runId, frame) => emitted.push(frame),
        waitForDecision,
        broadcastIntents,
        makeRequestId: () => 'req-xyz',
      },
      binding(),
      oneIntent,
    )

    // The gate emitted the claude-parity frame to the bound run.
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      type: 'permission_request',
      requestId: 'req-xyz',
      toolName: 'mcp__c3__save_intents',
      input: { intents: oneIntent.intents },
    })
    expect(waitForDecision).toHaveBeenCalledWith('req-xyz', expect.anything())
    // Persisted + broadcast.
    expect(res.isError).toBeFalsy()
    expect(broadcastIntents).toHaveBeenCalledWith(proj)
    expect(listIntents(proj).map((i) => i.title)).toContain('加缓存')
  })

  it('registers a WorkCenter event (onPermissionRequest) with source=intent before the frame', async () => {
    const order: string[] = []
    const onPermissionRequest = vi.fn(() => order.push('hook'))
    await gatedSave(
      {
        emit: () => order.push('emit'),
        waitForDecision: async () => ({ decision: 'deny' as const }),
        broadcastIntents: () => {},
        onPermissionRequest,
        makeRequestId: () => 'req-reg',
      },
      binding({ getRunId: () => 'run-7' }),
      oneIntent,
    )
    expect(onPermissionRequest).toHaveBeenCalledWith({
      requestId: 'req-reg',
      toolName: 'mcp__c3__save_intents',
      input: { intents: oneIntent.intents },
      sessionId: 'run-7',
      workspacePath: proj,
      sessionKind: 'intent',
    })
    // The hook fires BEFORE the wire frame (claude-parity ordering).
    expect(order).toEqual(['hook', 'emit'])
  })

  it('deny ⇒ emits the frame but persists nothing', async () => {
    const broadcastIntents = vi.fn()
    const res = await gatedSave(
      {
        emit: () => {},
        waitForDecision: async () => ({ decision: 'deny' as const }),
        broadcastIntents,
        makeRequestId: () => 'req-deny',
      },
      binding(),
      oneIntent,
    )

    expect(res.content[0].text).toContain('拒绝')
    expect(broadcastIntents).not.toHaveBeenCalled()
    expect(listIntents(proj)).toHaveLength(0)
  })

  it('routes the prompt to the LIVE run id (pending→real rebind safe)', async () => {
    let runId = 'pending-1'
    const seen: string[] = []
    await gatedSave(
      {
        emit: (id) => seen.push(id),
        waitForDecision: async () => ({ decision: 'deny' as const }),
        broadcastIntents: () => {},
      },
      binding({ getRunId: () => runId }),
      oneIntent,
    )
    expect(seen).toEqual(['pending-1'])
    // A later rebind would surface the new id, because getRunId reads live state.
    runId = 'real-9'
    expect(binding({ getRunId: () => runId }).getRunId()).toBe('real-9')
  })
})
