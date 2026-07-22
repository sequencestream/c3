import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { addWorkspace, pathToId, resetStateCacheForTests } from '../../state.js'
import { createIntent, deleteIntent } from './index.js'
import { getIntent, listIntentLogs, listIntents, resetStoreForTests } from './store.js'

let dir: string
let workspaceId: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-create-intent-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  process.env.C3_DIR = join(dir, 'c3-home')
  process.env.CLAUDE_CONFIG_DIR = dir
  resetDbForTests()
  resetStoreForTests()
  resetStateCacheForTests()
  addWorkspace(dir, 1)
  workspaceId = pathToId(dir)!
})

afterEach(() => {
  resetDbForTests()
  resetStateCacheForTests()
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  delete process.env.CLAUDE_CONFIG_DIR
  rmSync(dir, { recursive: true, force: true })
})

function harness() {
  const sent: ServerToClient[] = []
  const conn = { send: (m: ServerToClient) => sent.push(m), subject: 'alice' } as unknown as Conn
  const broadcastIntents = vi.fn()
  const ctx = { broadcastIntents } as unknown as KernelContext
  return { sent, conn, ctx, broadcastIntents }
}

describe('create_intent', () => {
  it('creates exactly one fixed draft and returns its exact id before broadcasting', () => {
    const h = harness()
    createIntent(h.ctx, h.conn, { type: 'create_intent', workspaceId })
    const [created] = listIntents(dir)
    expect(created).toMatchObject({
      title: 'new intent',
      content: '',
      priority: 'P2',
      status: 'draft',
      module: '',
      automate: false,
      intentSessionId: null,
      specSessionId: null,
      lastWorkSessionId: null,
    })
    expect(h.sent[0]).toMatchObject({
      type: 'create_intent_result',
      workspaceId,
      intent: { id: created.id },
    })
    expect(listIntentLogs(created.id)).toMatchObject([
      { operationType: 'intent_created', actor: 'alice' },
    ])
    expect(h.broadcastIntents).toHaveBeenCalledOnce()
  })

  it('rejects an unknown workspace without writing', () => {
    const h = harness()
    createIntent(h.ctx, h.conn, { type: 'create_intent', workspaceId: 'missing' })
    expect(listIntents(dir)).toEqual([])
    expect(h.sent[0]).toMatchObject({ type: 'error', error: { code: 'workspace.unknown' } })
  })

  it('allows physical deletion only while the new intent remains an asset-free draft', () => {
    const h = harness()
    createIntent(h.ctx, h.conn, { type: 'create_intent', workspaceId })
    const id = listIntents(dir)[0].id
    deleteIntent(h.ctx, h.conn, { type: 'delete_intent', intentId: id })
    expect(getIntent(id)).toBeNull()
    expect(listIntentLogs(id)).toEqual([])
  })
})
