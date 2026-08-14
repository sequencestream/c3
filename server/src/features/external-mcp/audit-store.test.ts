/**
 * The write-audit table. Two properties matter and both are about what the trail
 * can be trusted to say later: a row carries the full attribution (who, when,
 * which key, which workspace, which tool, what happened) and NOTHING that could
 * leak a credential; and a row that could not be written says so instead of
 * disappearing quietly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureExternalMcpWriteAuditSchema,
  listExternalMcpWriteAudits,
  recordExternalMcpWriteAudit,
  resetExternalMcpAuditStoreForTests,
  type ExternalMcpWriteAuditInput,
} from './audit-store.js'
import { resetDbForTests } from '../../kernel/infra/db.js'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-mcp-audit-'))
  process.env.C3_DB_PATH = join(home, 'c3.db')
  resetDbForTests()
  resetExternalMcpAuditStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  resetExternalMcpAuditStoreForTests()
  rmSync(home, { recursive: true, force: true })
})

const entry = (over: Partial<ExternalMcpWriteAuditInput> = {}): ExternalMcpWriteAuditInput => ({
  occurredAt: 1_700_000_000_000,
  keyId: 'key-a',
  ownerSubject: 'alice',
  workspaceName: 'alpha',
  tool: 'save_intents',
  result: 'success',
  ...over,
})

describe('the external MCP write audit', () => {
  it('materializes on first use', () => {
    expect(ensureExternalMcpWriteAuditSchema()).toBe(true)
  })

  it('round-trips every attribution field', () => {
    const written = recordExternalMcpWriteAudit(entry())
    const [read] = listExternalMcpWriteAudits()
    expect(read).toEqual({
      id: written.id,
      occurredAt: 1_700_000_000_000,
      keyId: 'key-a',
      ownerSubject: 'alice',
      workspaceName: 'alpha',
      tool: 'save_intents',
      result: 'success',
    })
    expect(written.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('keeps all three outcomes distinguishable', () => {
    for (const result of ['success', 'failure', 'rejected'] as const) {
      recordExternalMcpWriteAudit(entry({ result }))
    }
    expect(
      listExternalMcpWriteAudits()
        .map((r) => r.result)
        .sort(),
    ).toEqual(['failure', 'rejected', 'success'])
  })

  it('refuses a result value that is not one of the three', () => {
    expect(() =>
      recordExternalMcpWriteAudit(
        entry({ result: 'maybe' as unknown as ExternalMcpWriteAuditInput['result'] }),
      ),
    ).toThrow()
  })

  it('is append-only: a second attempt by the same key adds a row, never replaces one', () => {
    recordExternalMcpWriteAudit(entry({ occurredAt: 1 }))
    recordExternalMcpWriteAudit(entry({ occurredAt: 2, result: 'rejected' }))
    expect(listExternalMcpWriteAudits()).toHaveLength(2)
  })

  it('orders the newest first', () => {
    recordExternalMcpWriteAudit(entry({ occurredAt: 10, tool: 'save_intents' }))
    recordExternalMcpWriteAudit(entry({ occurredAt: 20, tool: 'start_discussion' }))
    expect(listExternalMcpWriteAudits().map((r) => r.tool)).toEqual([
      'start_discussion',
      'save_intents',
    ])
  })

  it('honours the limit', () => {
    for (let i = 0; i < 5; i++) recordExternalMcpWriteAudit(entry({ occurredAt: i }))
    expect(listExternalMcpWriteAudits(2)).toHaveLength(2)
  })

  it('stores no column that could carry secret material', () => {
    recordExternalMcpWriteAudit(entry())
    // The row IS the whole record: six known fields plus the generated id. A new
    // column carrying arguments, output or a credential would fail here.
    expect(Object.keys(listExternalMcpWriteAudits()[0]).sort()).toEqual([
      'id',
      'keyId',
      'occurredAt',
      'ownerSubject',
      'result',
      'tool',
      'workspaceName',
    ])
  })

  it('throws rather than silently dropping a row when the database is unusable', () => {
    // A directory where the database file should be: the driver cannot open it,
    // which is what an unavailable store looks like from here.
    process.env.C3_DB_PATH = home
    resetDbForTests()
    resetExternalMcpAuditStoreForTests()
    expect(() => recordExternalMcpWriteAudit(entry())).toThrow()
  })
})
