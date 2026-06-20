/**
 * REQ-3: the SDD spec directory is a FIXED, centralized, READ-ONLY value.
 *
 * - `load_workspace_setting` / `save_workspace_setting` replies carry the
 *   server-resolved `resolvedSpecRoot` (= `getSpecsBase(proj)`) for display.
 * - `save_workspace_setting` NEVER accepts a client-supplied spec directory: a
 *   bogus `specPath` in the saved config is dropped (not persisted) and the
 *   resolved root is unchanged (AC-3.2 / AC-3.3).
 *
 * Uses the real config / state / db layers under a temp dir (no mocks), matching
 * `features/intents/spec.test.ts`. With no auth configured the admin gate is
 * inert, so `save` passes `requireAdmin`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  addWorkspace,
  pathToId,
  resetStateCacheForTests,
  resolveWorkspaceRoot,
} from '../../state.js'
import { resetSettingsCacheForTests } from '../../kernel/config/index.js'
import { getSpecsBase } from '../intents/specs-root.js'
import { loadWorkspaceSettingHandler, saveWorkspaceSettingHandler } from './index.js'

let dir: string
let prevC3Dir: string | undefined
let workspaceId: string
let proj: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-spec-root-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  prevC3Dir = process.env.C3_DIR
  process.env.C3_DIR = join(dir, 'c3home')
  resetDbForTests()
  resetSettingsCacheForTests()
  resetStateCacheForTests()
  addWorkspace(dir, 1)
  workspaceId = pathToId(dir)!
  proj = resolveWorkspaceRoot(workspaceId)!
})

afterEach(() => {
  resetDbForTests()
  resetStateCacheForTests()
  resetSettingsCacheForTests()
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.C3_DB_PATH
  if (prevC3Dir === undefined) delete process.env.C3_DIR
  else process.env.C3_DIR = prevC3Dir
  rmSync(dir, { recursive: true, force: true })
})

function fakeConn(): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn = {
    send: (m: ServerToClient) => sent.push(m),
    subject: null,
    authed: true,
    authToken: null,
    viewing: null,
    deliver: () => {},
    sendWorkspaces: () => {},
    sendSessions: async () => {},
  } as Conn
  return { conn, sent }
}

const ctx = {} as unknown as KernelContext

describe('workspace setting — fixed centralized spec root (REQ-3)', () => {
  it('AC-3.3: load reply carries resolvedSpecRoot = getSpecsBase(proj)', () => {
    const { conn, sent } = fakeConn()
    loadWorkspaceSettingHandler(ctx, conn, { type: 'load_workspace_setting', workspaceId })
    const reply = sent.find((m) => m.type === 'workspace_setting')
    expect(reply && 'resolvedSpecRoot' in reply ? reply.resolvedSpecRoot : undefined).toBe(
      getSpecsBase(proj),
    )
  })

  it('AC-3.2: a client-supplied spec directory does not change the resolved root and is not persisted', () => {
    const { conn, sent } = fakeConn()
    saveWorkspaceSettingHandler(ctx, conn, {
      type: 'save_workspace_setting',
      workspaceId,
      // Attempt to inject a custom spec directory via the protocol.
      config: { sddEnabled: true, specPath: 'evil/custom/specs' } as never,
    })
    const reply = sent.find((m) => m.type === 'workspace_setting')
    if (!reply || reply.type !== 'workspace_setting') throw new Error('no workspace_setting reply')
    // Resolved root unchanged (the injected value had no effect)…
    expect(reply.resolvedSpecRoot).toBe(getSpecsBase(proj))
    // …and the persisted config carries no spec directory field.
    expect((reply.config as Record<string, unknown>).specPath).toBeUndefined()
  })
})
