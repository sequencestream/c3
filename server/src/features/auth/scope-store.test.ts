/**
 * The stored half of the workspace-scope model: the two relations, the
 * "selected with nothing selected" state a single list could not express, and
 * the transactional coupling between a policy write and the policy epoch.
 *
 * Resolution (what a subject actually reaches) is `authorization.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseConfigDb, useConfigDb } from '../../kernel/config/config-fixture.js'
import { configDb, configTx } from '../../kernel/config/config-store.js'
import { bumpPolicyEpoch, readPolicyEpoch } from '../../kernel/config/policy-epoch.js'
import { registerWorkspace, unregisterWorkspace } from '../../kernel/config/workspace-store.js'
import { loadSettings, saveSettings } from '../../kernel/config/index.js'
import {
  deleteWorkspaceScope,
  listWorkspaceScopes,
  putWorkspaceScope,
  readWorkspaceScope,
  resetWorkspaceScopeStoreForTests,
} from './scope-store.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-auth-scope-'))
  useConfigDb(dir)
  resetWorkspaceScopeStoreForTests()
})

afterEach(() => {
  releaseConfigDb()
  resetWorkspaceScopeStoreForTests()
  rmSync(dir, { recursive: true, force: true })
})

function makeWorkspace(name: string): string {
  const p = join(dir, name)
  mkdirSync(p, { recursive: true })
  return registerWorkspace(p, name, Date.now()).name
}

describe('schema', () => {
  it('materializes both relations on a fresh database', () => {
    putWorkspaceScope('alice', 'all', [], 1)
    const tables = configDb()!
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
      .map((r) => r.name)
    expect(tables).toContain('user_workspace_scopes')
    expect(tables).toContain('user_workspace_scope_items')
  })

  it('is idempotent — a second ensure over the same database changes nothing', () => {
    putWorkspaceScope('alice', 'selected', ['a'], 1)
    resetWorkspaceScopeStoreForTests()
    expect(readWorkspaceScope('alice')?.workspaces).toEqual(['a'])
  })
})

describe('the policy row and its details', () => {
  it('reports no policy for a subject that has none — never "all"', () => {
    expect(readWorkspaceScope('nobody')).toBeNull()
  })

  it('represents "selected with nothing selected" as a real, distinct state', () => {
    putWorkspaceScope('alice', 'selected', [], 1)
    const scope = readWorkspaceScope('alice')
    expect(scope).not.toBeNull()
    expect(scope!.mode).toBe('selected')
    expect(scope!.workspaces).toEqual([])
    // Distinguishable from "no policy at all", which is what a bare empty list
    // would have collapsed it into.
    expect(readWorkspaceScope('bob')).toBeNull()
  })

  it('stores no detail rows for an `all` scope', () => {
    putWorkspaceScope('alice', 'all', ['ignored'], 1)
    expect(readWorkspaceScope('alice')!.workspaces).toEqual([])
    const rows = configDb()!.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM user_workspace_scope_items',
    )
    expect(rows[0].n).toBe(0)
  })

  it('de-duplicates, trims and orders the selected names', () => {
    putWorkspaceScope('alice', 'selected', [' beta ', 'alpha', 'beta', '  '], 1)
    expect(readWorkspaceScope('alice')!.workspaces).toEqual(['alpha', 'beta'])
  })

  it('replaces the whole policy on write rather than merging into it', () => {
    putWorkspaceScope('alice', 'selected', ['alpha', 'beta'], 1)
    putWorkspaceScope('alice', 'selected', ['gamma'], 2)
    expect(readWorkspaceScope('alice')!.workspaces).toEqual(['gamma'])

    putWorkspaceScope('alice', 'all', [], 3)
    expect(readWorkspaceScope('alice')!.mode).toBe('all')
    expect(readWorkspaceScope('alice')!.workspaces).toEqual([])
  })

  it('refuses a blank subject', () => {
    expect(() => putWorkspaceScope('   ', 'all', [], 1)).toThrow()
  })

  it('refuses an unknown mode at the database level', () => {
    putWorkspaceScope('alice', 'all', [], 1)
    expect(() =>
      configDb()!.run("UPDATE user_workspace_scopes SET mode='everything' WHERE subject='alice'"),
    ).toThrow(/CHECK constraint/)
  })

  it('treats an uninterpretable mode as no policy at all, not as everything', () => {
    putWorkspaceScope('alice', 'all', [], 1)
    // Simulate a relation written by a schema that did not constrain `mode` — a
    // database restored from a different c3, or edited by hand. Reading such a
    // row generously is the one way a corrupt record could widen access.
    const d = configDb()!
    d.exec(`
      DROP TABLE user_workspace_scopes;
      CREATE TABLE user_workspace_scopes (
        subject TEXT PRIMARY KEY, mode TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO user_workspace_scopes VALUES ('alice','everything',1,1);
    `)
    expect(readWorkspaceScope('alice')).toBeNull()
    expect(listWorkspaceScopes()).toEqual([])
  })

  it('lists every stored policy in subject order', () => {
    putWorkspaceScope('bob', 'selected', ['b'], 1)
    putWorkspaceScope('alice', 'all', [], 2)
    expect(listWorkspaceScopes().map((s) => s.subject)).toEqual(['alice', 'bob'])
  })

  it('deletes a policy, leaving the subject with no access and no detail rows', () => {
    putWorkspaceScope('alice', 'selected', ['alpha'], 1)
    expect(deleteWorkspaceScope('alice')).toBe(true)
    expect(readWorkspaceScope('alice')).toBeNull()
    const rows = configDb()!.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM user_workspace_scope_items',
    )
    expect(rows[0].n).toBe(0)
  })
})

describe('the policy epoch', () => {
  it('starts at zero on a fresh database', () => {
    expect(readPolicyEpoch()).toBe(0)
  })

  it('advances exactly once per scope write, in the same commit', () => {
    const before = readPolicyEpoch()
    putWorkspaceScope('alice', 'selected', ['alpha'], 1)
    expect(readPolicyEpoch()).toBe(before + 1)
    putWorkspaceScope('alice', 'all', [], 2)
    expect(readPolicyEpoch()).toBe(before + 2)
  })

  it('does not advance when a delete removes nothing', () => {
    const before = readPolicyEpoch()
    expect(deleteWorkspaceScope('nobody')).toBe(false)
    expect(readPolicyEpoch()).toBe(before)
    putWorkspaceScope('alice', 'all', [], 1)
    expect(deleteWorkspaceScope('alice')).toBe(true)
    expect(readPolicyEpoch()).toBe(before + 2)
  })

  it('rolls back the epoch with the policy when the transaction fails', () => {
    putWorkspaceScope('alice', 'all', [], 1)
    const epoch = readPolicyEpoch()
    expect(() =>
      configTx(() => {
        putWorkspaceScope('alice', 'selected', ['alpha'], 2)
        throw new Error('write failed downstream')
      }),
    ).toThrow('write failed downstream')

    // Neither the data nor the freshness boundary moved: a failed write must not
    // revoke an otherwise-current session.
    expect(readPolicyEpoch()).toBe(epoch)
    expect(readWorkspaceScope('alice')!.mode).toBe('all')
  })

  it('advances when the workspace registry changes an effective `all` scope', () => {
    const before = readPolicyEpoch()
    const alpha = makeWorkspace('alpha')
    expect(readPolicyEpoch()).toBe(before + 1)

    unregisterWorkspace(alpha)
    expect(readPolicyEpoch()).toBe(before + 2)
    // A second unregister changes nothing, so it publishes nothing.
    unregisterWorkspace(alpha)
    expect(readPolicyEpoch()).toBe(before + 2)
  })

  it('survives a whole-object system-settings save', () => {
    bumpPolicyEpoch()
    bumpPolicyEpoch()
    const epoch = readPolicyEpoch()
    expect(epoch).toBe(2)

    // The epoch shares the `auth.*` key space but is not part of SystemSettings;
    // a save that states the whole object must preserve it, not delete a row it
    // never mentioned.
    saveSettings({ ...loadSettings(), baseUrl: 'http://192.168.1.5:3000' })
    expect(readPolicyEpoch()).toBe(epoch)
    expect(
      (loadSettings() as unknown as { auth?: { policyEpoch?: unknown } }).auth?.policyEpoch,
    ).toBeUndefined()
  })
})
