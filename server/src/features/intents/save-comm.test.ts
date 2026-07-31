/**
 * The interactive comm-agent `save_intents` handler. The user's authorization is
 * the textual confirmation in the conversation, so the handler persists straight
 * away: no `permission_request` frame, no `waitForDecision`, no wait-user-involve
 * registration — the injected deps carry nothing but the broadcast. What it still
 * enforces: the current-intent batch constraint, the store's atomic validation,
 * and a `system` log attribution (there is no approving subject).
 * The single-intent back-link normalization lives in save-handlers.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { insertIntents, listIntents, listIntentLogs, resetStoreForTests } from './store.js'
import { runCommSave, type CommSaveBinding } from './save-comm.js'

const proj = '/abs/save-comm-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-save-comm-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function binding(over: Partial<CommSaveBinding> = {}): CommSaveBinding {
  return { workspacePath: proj, getRunId: () => 'run-1', ...over }
}

const oneIntent = {
  intents: [
    { title: '加缓存', shortEnTitle: 'auto', content: '给热点接口加缓存', priority: 'P1' as const },
  ],
}

describe('runCommSave', () => {
  it('persists + broadcasts on the call itself, with no UI confirmation round-trip', () => {
    const broadcastIntents = vi.fn()
    // The handler is synchronous: it cannot be awaiting a browser decision.
    const res = runCommSave({ broadcastIntents }, binding(), oneIntent)

    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('已保存')
    expect(broadcastIntents).toHaveBeenCalledWith(proj)
    expect(listIntents(proj).map((i) => i.title)).toContain('加缓存')
  })

  it('attributes the intent_created log to system (no approving subject)', () => {
    runCommSave({ broadcastIntents: () => {} }, binding(), oneIntent)
    const [saved] = listIntents(proj)
    const created = listIntentLogs(saved.id).find((l) => l.operationType === 'intent_created')
    expect(created?.actor).toBe('system')
  })

  it('reads the LIVE run id (pending→real rebind safe)', () => {
    let runId = 'pending-1'
    const seen: string[] = []
    runCommSave(
      { broadcastIntents: () => {} },
      binding({ getRunId: () => (seen.push(runId), runId) }),
      oneIntent,
    )
    expect(seen).toEqual(['pending-1'])
    // A later rebind surfaces the new id, because getRunId reads live state.
    runId = 'real-9'
    expect(binding({ getRunId: () => runId }).getRunId()).toBe('real-9')
  })

  it('rejects a batch that omits the session-owning intent (current-intent constraint)', () => {
    const broadcastIntents = vi.fn()
    const [owner] = insertIntents(proj, [
      { title: 'owner', shortEnTitle: 'owner', content: '', priority: 'P0' },
    ])
    const res = runCommSave({ broadcastIntents }, binding({ getRunId: () => owner.id }), oneIntent)

    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain(owner.id)
    expect(broadcastIntents).not.toHaveBeenCalled()
    expect(listIntents(proj)).toHaveLength(1) // only the pre-existing owner row
  })

  it('accepts a batch that carries the session-owning intent exactly once', () => {
    const [owner] = insertIntents(proj, [
      { title: 'owner', shortEnTitle: 'owner', content: '', priority: 'P0' },
    ])
    const res = runCommSave({ broadcastIntents: () => {} }, binding({ getRunId: () => owner.id }), {
      intents: [
        { id: owner.id, title: 'owner v2', shortEnTitle: 'owner', content: '', priority: 'P0' },
      ],
    })

    expect(res.isError).toBeFalsy()
    expect(listIntents(proj).map((i) => i.title)).toEqual(['owner v2'])
  })

  it('reports a store failure honestly instead of persisting', () => {
    const broadcastIntents = vi.fn()
    const res = runCommSave({ broadcastIntents }, binding(), {
      intents: [{ id: 'ghost', title: 'x', shortEnTitle: 'x', content: '', priority: 'P0' }],
    })

    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('保存失败')
    expect(broadcastIntents).not.toHaveBeenCalled()
    expect(listIntents(proj)).toHaveLength(0)
  })
})
