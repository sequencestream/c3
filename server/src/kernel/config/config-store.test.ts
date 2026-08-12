/**
 * Integration tests for the config tables over the shared c3.db adapter: schema
 * creation, scope isolation, replace-vs-patch write semantics, prefix deletion,
 * transaction rollback, and the workspace registry's id stability (the property the
 * whole per-workspace configuration hangs off).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDb, resetDbForTests } from '../infra/db.js'
import {
  configTx,
  deleteKeyPrefix,
  deleteKeys,
  deleteScope,
  isConfigStoreAvailable,
  listScopeOwners,
  readAllScopes,
  readScope,
  resetConfigStoreForTests,
  writeScope,
} from './config-store.js'
import {
  ensureWorkspaceId,
  findWorkspaceByPath,
  listWorkspaceRows,
  registerWorkspace,
  touchWorkspaceRow,
  unregisterWorkspace,
} from './workspace-store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-cfg-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetConfigStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('schema', () => {
  it('creates every config table on first access', () => {
    expect(isConfigStoreAvailable()).toBe(true)
    const names = getDb()!
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name)
    for (const table of [
      'workspaces',
      'system_configs',
      'workspace_configs',
      'personalized_configs',
      'session_configs',
      'mcp_api_keys',
    ]) {
      expect(names).toContain(table)
    }
  })
})

describe('scopes', () => {
  it('round-trips rows within a scope', () => {
    writeScope({ kind: 'system' }, [
      { key: 'timezone', value: 'Asia/Shanghai', type: 'string' },
      { key: 'proxy.enabled', value: 'true', type: 'boolean' },
    ])
    expect(readScope({ kind: 'system' }).sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: 'proxy.enabled', value: 'true', type: 'boolean' },
      { key: 'timezone', value: 'Asia/Shanghai', type: 'string' },
    ])
  })

  it('keeps owners of the same kind independent', () => {
    writeScope({ kind: 'workspace', owner: 'w1' }, [
      { key: 'sddEnabled', value: 'true', type: 'boolean' },
    ])
    writeScope({ kind: 'workspace', owner: 'w2' }, [
      { key: 'sddEnabled', value: 'false', type: 'boolean' },
    ])
    expect(readScope({ kind: 'workspace', owner: 'w1' })[0].value).toBe('true')
    expect(readScope({ kind: 'workspace', owner: 'w2' })[0].value).toBe('false')
    expect(listScopeOwners('workspace').sort()).toEqual(['w1', 'w2'])
    expect([...readAllScopes('workspace').keys()].sort()).toEqual(['w1', 'w2'])
  })

  it('replace drops keys the write did not mention', () => {
    const scope = { kind: 'personalized' as const, owner: 'alice' }
    writeScope(scope, [
      { key: 'uiLang', value: 'zh', type: 'string' },
      { key: 'theme', value: 'dark', type: 'string' },
    ])
    writeScope(scope, [{ key: 'uiLang', value: 'en', type: 'string' }])
    expect(readScope(scope)).toEqual([{ key: 'uiLang', value: 'en', type: 'string' }])
  })

  it('patch leaves untouched keys alone', () => {
    const scope = { kind: 'personalized' as const, owner: 'alice' }
    writeScope(scope, [
      { key: 'uiLang', value: 'zh', type: 'string' },
      { key: 'theme', value: 'dark', type: 'string' },
    ])
    writeScope(scope, [{ key: 'uiLang', value: 'en', type: 'string' }], { replace: false })
    const rows = Object.fromEntries(readScope(scope).map((e) => [e.key, e.value]))
    expect(rows).toEqual({ uiLang: 'en', theme: 'dark' })
  })

  it('deletes a whole scope, single keys, and key prefixes', () => {
    const scope = { kind: 'session' as const, owner: 's1' }
    writeScope(scope, [
      { key: 'agentId', value: 'a', type: 'string' },
      { key: 'vendor', value: 'claude', type: 'string' },
    ])
    deleteKeys(scope, ['vendor'])
    expect(readScope(scope).map((e) => e.key)).toEqual(['agentId'])
    deleteScope(scope)
    expect(readScope(scope)).toEqual([])

    writeScope({ kind: 'system' }, [
      { key: 'state.skillAck', value: '1', type: 'string' },
      { key: 'state.skillAcks', value: '{}', type: 'json' },
      { key: 'state.skillAcks.x', value: '1', type: 'string' },
      { key: 'timezone', value: 'UTC', type: 'string' },
    ])
    deleteKeyPrefix({ kind: 'system' }, 'state.skillAcks')
    expect(
      readScope({ kind: 'system' })
        .map((e) => e.key)
        .sort(),
    ).toEqual(['state.skillAck', 'timezone'])
  })
})

describe('configTx', () => {
  it('rolls the whole batch back when the body throws', () => {
    writeScope({ kind: 'system' }, [{ key: 'timezone', value: 'UTC', type: 'string' }])
    expect(() =>
      configTx(() => {
        writeScope({ kind: 'system' }, [{ key: 'timezone', value: 'Asia/Tokyo', type: 'string' }])
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(readScope({ kind: 'system' })[0].value).toBe('UTC')
  })
})

describe('workspace registry', () => {
  it('keeps the id (and therefore the configuration) across unregister/re-register', () => {
    const first = registerWorkspace('/tmp/proj-a', 1_000)
    writeScope({ kind: 'workspace', owner: first.id }, [
      { key: 'sddEnabled', value: 'true', type: 'boolean' },
    ])
    unregisterWorkspace('/tmp/proj-a')
    expect(listWorkspaceRows()).toEqual([])

    const again = registerWorkspace('/tmp/proj-a', 2_000)
    expect(again.id).toBe(first.id)
    expect(again.lastAccessed).toBe(2_000)
    expect(readScope({ kind: 'workspace', owner: again.id })[0].value).toBe('true')
  })

  it('creates configuration-only rows that never reach the workspace list', () => {
    const id = ensureWorkspaceId('/tmp/only-config', 1_000)
    expect(listWorkspaceRows()).toEqual([])
    expect(findWorkspaceByPath('/tmp/only-config')).toMatchObject({ id, registered: false })
    // Registering later adopts the same id, so the imported configuration applies.
    expect(registerWorkspace('/tmp/only-config', 2_000).id).toBe(id)
    expect(listWorkspaceRows()).toHaveLength(1)
  })

  it('touch only moves a registered workspace', () => {
    const row = registerWorkspace('/tmp/proj-b', 1_000)
    touchWorkspaceRow('/tmp/proj-b', 5_000)
    expect(findWorkspaceByPath('/tmp/proj-b')?.lastAccessed).toBe(5_000)
    unregisterWorkspace('/tmp/proj-b')
    touchWorkspaceRow('/tmp/proj-b', 9_000)
    expect(findWorkspaceByPath('/tmp/proj-b')).toMatchObject({ id: row.id, lastAccessed: 5_000 })
  })
})
