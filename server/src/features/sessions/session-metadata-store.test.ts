/**
 * `getBoundByVendorSessionId` — the projection read behind the session→agent
 * binding fallback.
 *
 * The caller (the composition root's `setOnSessionBindingFallback`) knows only
 * the native session id the wire carries, so the lookup is on `vendor_session_id`
 * alone: no workspace, no vendor. What it must answer is "which agent/vendor does
 * this session's own row record", and it must answer nothing at all for a pending
 * row (no transcript, its intent has its own read-through).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Automation } from '@ccc/shared/protocol'

import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  getBoundByVendorSessionId,
  resetStoreForTests,
  upsertAutomationExecutionRow,
  upsertPendingRow,
} from './session-metadata-store.js'

const WS = '/abs/sm-proj'
let dir: string
let prevHome: string | undefined

function codexAutomation(): Automation {
  return {
    id: 'auto-1',
    type: 'llm',
    workspaceName: WS,
    agentId: 'agent-codex',
    vendor: 'codex',
    config: { name: 'nightly', prompt: 'do a thing' },
  } as unknown as Automation
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-sm-'))
  prevHome = process.env.HOME
  process.env.HOME = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('getBoundByVendorSessionId', () => {
  it("returns the automation row's own vendor + agent for its native session id", () => {
    upsertAutomationExecutionRow({
      automation: codexAutomation(),
      sessionId: 'codex-sid-1',
      workspacePath: WS,
    })

    const row = getBoundByVendorSessionId('codex-sid-1')

    expect(row?.vendor).toBe('codex')
    expect(row?.agentId).toBe('agent-codex')
    expect(row?.sessionKind).toBe('automation')
    expect(row?.ownerId).toBe('auto-1')
  })

  it('returns null for an unknown session id', () => {
    expect(getBoundByVendorSessionId('nope')).toBeNull()
  })

  it('returns null for an empty id (never scan the table for nothing)', () => {
    expect(getBoundByVendorSessionId('')).toBeNull()
  })

  it('ignores pending rows — they carry no vendor session id at all', () => {
    upsertPendingRow({
      pendingId: 'pending-1',
      workspacePath: WS,
      vendor: 'codex',
      agentId: 'agent-codex',
    })

    expect(getBoundByVendorSessionId('pending-1')).toBeNull()
  })
})
