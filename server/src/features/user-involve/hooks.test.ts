/**
 * `createPermissionRequestHandler` — the CREATE side of the wait-user-involve
 * lifecycle. Asserts the handler persists an event with the caller-provided
 * `source` (NOT a hard-coded 'session') and broadcasts the refreshed todo list,
 * so a codex/opencode intent prompt lands in WorkCenter under the right tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient, WaitUserInvolveSource } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { listEvents, resetStoreForTests } from './store.js'
import { createPermissionRequestHandler } from './hooks.js'
import type { PermissionRequestCtx } from '../../kernel/permission/index.js'

const proj = '/abs/hooks-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-hooks-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function ctx(
  source: WaitUserInvolveSource,
  over: Partial<PermissionRequestCtx> = {},
): PermissionRequestCtx {
  return {
    requestId: 'req-1',
    toolName: 'mcp__c3__save_intents',
    input: { intents: [] },
    sessionId: 'sess-1',
    workspacePath: proj,
    source,
    ...over,
  }
}

describe('createPermissionRequestHandler', () => {
  it('persists an event with the caller-provided source and broadcasts the todo list', () => {
    const sent: ServerToClient[] = []
    const handler = createPermissionRequestHandler({
      broadcaster: { toAll: (m: ServerToClient) => sent.push(m) } as never,
    })

    handler(ctx('intent'))

    const events = listEvents(proj, 'todo')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      source: 'intent',
      sourceId: 'sess-1',
      requestId: 'req-1',
      toolName: 'mcp__c3__save_intents',
      status: 'todo',
    })
    // Broadcast carries the refreshed list.
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'wait_user_events' })
  })

  it('honours source=session (no longer hard-coded)', () => {
    const handler = createPermissionRequestHandler({ broadcaster: { toAll: vi.fn() } as never })
    handler(ctx('session', { requestId: 'req-2', sessionId: 'work-9' }))
    const events = listEvents(proj, 'todo')
    expect(events).toHaveLength(1)
    expect(events[0].source).toBe('session')
  })
})
