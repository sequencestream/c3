import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { resetStoreForTests, getWriteApproval, listPendingWriteApprovals } from './store.js'
import {
  pendWriteApproval,
  resolveApproval,
  cancelAllForSchedule,
  cancelAllForWorkspace,
  pendingCount,
  setBroadcast,
  type BroadcastFn,
} from './queue.js'

let dir: string
const proj = '/abs/workspace-q'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-q-db-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
  setBroadcast(() => {}) // silence by default
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('pendWriteApproval + resolveApproval', () => {
  it('resolves to true when approved', async () => {
    const p = pendWriteApproval({
      scheduleId: 'sch-1',
      workspacePath: proj,
      toolName: 'Write',
      toolInput: { filePath: '/a' },
      diffPreview: 'preview',
    })
    expect(pendingCount()).toBe(1)

    // Find the created approval id
    const [approval] = listPendingWriteApprovals(proj)
    expect(approval).toBeDefined()

    const ok = resolveApproval(approval.id, 'approve', 'owner')
    expect(ok).toBe(true)

    await expect(p).resolves.toBe(true)
    expect(pendingCount()).toBe(0)

    const fetched = getWriteApproval(approval.id)
    expect(fetched!.status).toBe('approved')
  })

  it('resolves to false when rejected', async () => {
    const p = pendWriteApproval({
      scheduleId: 'sch-1',
      workspacePath: proj,
      toolName: 'Write',
      toolInput: {},
      diffPreview: '',
    })
    const [approval] = listPendingWriteApprovals(proj)
    resolveApproval(approval.id, 'reject', 'owner')

    await expect(p).resolves.toBe(false)
    const fetched = getWriteApproval(approval.id)
    expect(fetched!.status).toBe('rejected')
  })

  it('broadcasts pending then resolved events', async () => {
    const events: Array<{ type: string }> = []
    const broadcast: BroadcastFn = (e) => events.push({ type: e.type })
    setBroadcast(broadcast)

    const p = pendWriteApproval({
      scheduleId: 'sch-1',
      workspacePath: proj,
      toolName: 'Edit',
      toolInput: {},
      diffPreview: '',
    })
    expect(events).toEqual([{ type: 'pending' }])

    const [approval] = listPendingWriteApprovals(proj)
    resolveApproval(approval.id, 'approve', 'owner')
    await p

    expect(events).toEqual([{ type: 'pending' }, { type: 'resolved' }])
  })

  it('returns false for an unknown approval id', () => {
    expect(resolveApproval('does-not-exist', 'approve')).toBe(false)
  })

  it('blocks indefinitely until resolved (no auto-resolve)', async () => {
    const settled = vi.fn()
    const p = pendWriteApproval({
      scheduleId: 'sch-1',
      workspacePath: proj,
      toolName: 'Write',
      toolInput: {},
      diffPreview: '',
      ttlMs: 60_000,
    }).then(settled)

    await Promise.resolve()
    expect(settled).not.toHaveBeenCalled()

    const [approval] = listPendingWriteApprovals(proj)
    resolveApproval(approval.id, 'approve')
    await p
    expect(settled).toHaveBeenCalledWith(true)
  })
})

describe('cancelAllForSchedule / cancelAllForWorkspace', () => {
  it('cancels all pending approvals for a schedule (resolves false)', async () => {
    const p1 = pendWriteApproval({
      scheduleId: 'sch-1',
      workspacePath: proj,
      toolName: 'Write',
      toolInput: {},
      diffPreview: '',
    })
    const p2 = pendWriteApproval({
      scheduleId: 'sch-2',
      workspacePath: proj,
      toolName: 'Edit',
      toolInput: {},
      diffPreview: '',
    })

    cancelAllForSchedule('sch-1')

    await expect(p1).resolves.toBe(false)
    expect(pendingCount()).toBe(1) // sch-2 still pending

    // cleanup
    const remaining = listPendingWriteApprovals(proj)
    resolveApproval(remaining[0].id, 'reject')
    await p2
  })

  it('cancels all pending approvals for a workspace', async () => {
    const p1 = pendWriteApproval({
      scheduleId: 'sch-1',
      workspacePath: proj,
      toolName: 'Write',
      toolInput: {},
      diffPreview: '',
    })
    const p2 = pendWriteApproval({
      scheduleId: 'sch-2',
      workspacePath: proj,
      toolName: 'Edit',
      toolInput: {},
      diffPreview: '',
    })

    cancelAllForWorkspace(proj)

    await expect(p1).resolves.toBe(false)
    await expect(p2).resolves.toBe(false)
    expect(pendingCount()).toBe(0)
  })
})
