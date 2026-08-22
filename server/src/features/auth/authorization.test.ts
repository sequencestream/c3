/**
 * The one gate, against a real database: subject synthesis, the three-layer
 * intersection, and the guarantee that the console and an MCP caller resolving
 * the SAME subject get the SAME ordered workspace list.
 *
 * Each input is varied independently — empty owner scope, empty key tool set,
 * catalog-denied tool, administrator, `local` — because the failure this design
 * exists to prevent is one layer quietly widening what another narrowed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthConfig } from '@ccc/shared/protocol'
import { releaseConfigDb, useConfigDb } from '../../kernel/config/config-fixture.js'
import { loadSettings, saveSettings } from '../../kernel/config/index.js'
import { registerWorkspace } from '../../kernel/config/workspace-store.js'
import { readPolicyEpoch } from '../../kernel/config/policy-epoch.js'
import { hashPassword } from './password.js'
import { putWorkspaceScope, resetWorkspaceScopeStoreForTests } from './scope-store.js'
import {
  authorizeCall,
  isValidOwner,
  listWorkspacesForSubject,
  LOCAL_SUBJECT,
  localPrincipal,
  resolveAuthSubject,
  type ExternalMcpPrincipal,
} from './authorization.js'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-authz-'))
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

/** Configure `basic` with the given accounts, the first of them administrator. */
function useBasicAuth(...usernames: string[]): void {
  const auth: AuthConfig = {
    enabled: true,
    provider: {
      kind: 'basic',
      accounts: usernames.map((username) => ({
        username,
        passwordHash: hashPassword('correct horse'),
      })),
      adminUsername: usernames[0],
    },
    session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_KEY' },
  }
  saveSettings({ ...loadSettings(), auth })
}

function keyOf(owner: string, tools: readonly string[]): ExternalMcpPrincipal {
  return { keyId: 'key-1', ownerSubject: owner, secretVersion: 3, tools }
}

describe('subject synthesis', () => {
  it('maps an absent auth configuration to the local principal', () => {
    expect(resolveAuthSubject(null)).toBe(LOCAL_SUBJECT)
    expect(resolveAuthSubject('whoever')).toBe(LOCAL_SUBJECT)
  })

  it('maps a `basic` shell with no accounts to the local principal', () => {
    saveSettings({
      ...loadSettings(),
      auth: {
        enabled: false,
        provider: { kind: 'basic', accounts: [], adminUsername: '' },
        session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_KEY' },
      },
    })
    expect(resolveAuthSubject(null)).toBe(LOCAL_SUBJECT)
  })

  it('maps a verified subject to itself, and no subject to nobody, under enforced auth', () => {
    useBasicAuth('root', 'alice')
    expect(resolveAuthSubject('alice')).toBe('alice')
    expect(resolveAuthSubject(' alice ')).toBe('alice')
    expect(resolveAuthSubject(null)).toBeNull()
    expect(resolveAuthSubject('  ')).toBeNull()
  })
})

describe('owner validity', () => {
  it('accepts only `local` while no admin gate applies', () => {
    expect(isValidOwner(LOCAL_SUBJECT)).toBe(true)
    expect(isValidOwner('alice')).toBe(false)
    expect(isValidOwner('')).toBe(false)
  })

  it('accepts any known account — and stops accepting `local` — once basic auth is configured', () => {
    useBasicAuth('root', 'alice')
    expect(isValidOwner('root')).toBe(true)
    expect(isValidOwner('alice')).toBe(true)
    // A key minted on a localhost install is not silently handed to a real
    // account when the deployment grows one.
    expect(isValidOwner(LOCAL_SUBJECT)).toBe(false)
    expect(isValidOwner('departed')).toBe(false)
  })
})

describe('workspace resolution', () => {
  it('gives the local principal every registered workspace, with no stored policy', () => {
    const alpha = makeWorkspace('alpha')
    const beta = makeWorkspace('beta')
    expect(
      listWorkspacesForSubject(LOCAL_SUBJECT)
        .map((w) => w.name)
        .sort(),
    ).toEqual([alpha, beta].sort())
  })

  it('gives the administrator every workspace without a stored policy row', () => {
    const alpha = makeWorkspace('alpha')
    useBasicAuth('root', 'alice')
    expect(listWorkspacesForSubject('root').map((w) => w.name)).toEqual([alpha])
  })

  it('gives a non-admin account with no policy nothing at all', () => {
    makeWorkspace('alpha')
    useBasicAuth('root', 'alice')
    expect(listWorkspacesForSubject('alice')).toEqual([])
  })

  it('honours `selected` exactly, including the empty selection', () => {
    const alpha = makeWorkspace('alpha')
    makeWorkspace('beta')
    useBasicAuth('root', 'alice')

    putWorkspaceScope('alice', 'selected', [alpha], 1)
    expect(listWorkspacesForSubject('alice').map((w) => w.name)).toEqual([alpha])

    putWorkspaceScope('alice', 'selected', [], 2)
    expect(listWorkspacesForSubject('alice')).toEqual([])
  })

  it('does not auto-expand a `selected` scope when a workspace is registered, but `all` does', () => {
    const alpha = makeWorkspace('alpha')
    useBasicAuth('root', 'alice')
    putWorkspaceScope('alice', 'selected', [alpha], 1)
    const gamma = makeWorkspace('gamma')
    expect(listWorkspacesForSubject('alice').map((w) => w.name)).toEqual([alpha])

    putWorkspaceScope('alice', 'all', [], 2)
    expect(
      listWorkspacesForSubject('alice')
        .map((w) => w.name)
        .sort(),
    ).toEqual([alpha, gamma].sort())
  })

  it('ignores a selected name the registry no longer has', () => {
    const alpha = makeWorkspace('alpha')
    useBasicAuth('root', 'alice')
    putWorkspaceScope('alice', 'selected', [alpha, 'vanished'], 1)
    expect(listWorkspacesForSubject('alice').map((w) => w.name)).toEqual([alpha])
  })

  it('returns nothing for an unresolvable subject rather than the raw registry', () => {
    makeWorkspace('alpha')
    useBasicAuth('root', 'alice')
    expect(listWorkspacesForSubject(null)).toEqual([])
    expect(listWorkspacesForSubject('   ')).toEqual([])
  })

  it('gives a console caller and an MCP caller the same ordered list for one subject', () => {
    const alpha = makeWorkspace('alpha')
    const beta = makeWorkspace('beta')
    useBasicAuth('root', 'alice')
    putWorkspaceScope('alice', 'selected', [alpha, beta], 1)

    // The console path: a verified WebSocket subject.
    const console = listWorkspacesForSubject(resolveAuthSubject('alice'))
    // The MCP path: the same subject reached through a key's owner.
    const mcp = listWorkspacesForSubject(keyOf('alice', []).ownerSubject)
    expect(console.map((w) => w.name)).toEqual(mcp.map((w) => w.name))
    expect(console.length).toBe(2)
  })

  it('lets a no-auth console see everything without any policy row existing', () => {
    const alpha = makeWorkspace('alpha')
    // `conn.subject` is null on a no-account deployment; the resolver, not the
    // socket, decides that this means `local`.
    expect(listWorkspacesForSubject(resolveAuthSubject(null)).map((w) => w.name)).toEqual([alpha])
  })

  it('returns nothing for a subject removed from the account roster', () => {
    const alpha = makeWorkspace('alpha')
    useBasicAuth('root', 'alice')
    putWorkspaceScope('alice', 'selected', [alpha], 1)
    expect(listWorkspacesForSubject('alice').map((w) => w.name)).toEqual([alpha])

    const settings = loadSettings()
    const provider = settings.auth?.provider
    if (provider?.kind !== 'basic') throw new Error('expected basic')
    saveSettings({
      ...settings,
      auth: {
        ...settings.auth!,
        provider: {
          ...provider,
          accounts: provider.accounts.filter((a) => a.username !== 'alice'),
        },
      },
    })
    expect(listWorkspacesForSubject('alice')).toEqual([])
  })
})

describe('authorizeCall', () => {
  it('refuses an owner this deployment does not recognize, before naming any workspace', () => {
    const alpha = makeWorkspace('alpha')
    useBasicAuth('root')
    const result = authorizeCall(keyOf('departed', ['find_intents']), alpha, 'find_intents')
    expect(result).toEqual({ ok: false, reason: 'owner' })
  })

  it('refuses a workspace outside the owner scope even when the tool is granted', () => {
    const alpha = makeWorkspace('alpha')
    const beta = makeWorkspace('beta')
    useBasicAuth('root', 'alice')
    putWorkspaceScope('alice', 'selected', [alpha], 1)

    expect(authorizeCall(keyOf('alice', ['find_intents']), beta, 'find_intents')).toEqual({
      ok: false,
      reason: 'workspace',
    })
    expect(authorizeCall(keyOf('alice', ['find_intents']), alpha, 'find_intents').ok).toBe(true)
  })

  it('refuses everything when the owner scope is empty, whatever the key carries', () => {
    const alpha = makeWorkspace('alpha')
    useBasicAuth('root', 'alice')
    putWorkspaceScope('alice', 'selected', [], 1)
    expect(authorizeCall(keyOf('alice', ['find_intents']), alpha, 'find_intents')).toEqual({
      ok: false,
      reason: 'workspace',
    })
  })

  it('refuses an unknown or blank workspace name without consulting the tool set', () => {
    useBasicAuth('root')
    expect(authorizeCall(keyOf('root', ['find_intents']), 'nope', 'find_intents')).toEqual({
      ok: false,
      reason: 'workspace',
    })
    expect(authorizeCall(keyOf('root', ['find_intents']), '   ', null)).toEqual({
      ok: false,
      reason: 'workspace',
    })
  })

  it('grants nothing when the key tool set is empty, even for an all-scope owner', () => {
    const alpha = makeWorkspace('alpha')
    useBasicAuth('root')
    expect(authorizeCall(keyOf('root', []), alpha, 'find_intents')).toEqual({
      ok: false,
      reason: 'tool',
    })
    // The session itself may still be established; it just advertises nothing.
    const established = authorizeCall(keyOf('root', []), alpha, null)
    expect(established.ok).toBe(true)
    expect(established.ok && established.scope.tools).toEqual([])
  })

  it('drops a name the catalog does not offer instead of honouring it', () => {
    const alpha = makeWorkspace('alpha')
    useBasicAuth('root')
    const principal = keyOf('root', ['find_intents', 'retired_tool'])
    expect(authorizeCall(principal, alpha, 'retired_tool')).toEqual({ ok: false, reason: 'tool' })
    const listed = authorizeCall(principal, alpha, null)
    expect(listed.ok && listed.scope.tools).toEqual(['find_intents'])
  })

  it('returns a frozen scope carrying the registry path and the pinning tuple', () => {
    const alpha = makeWorkspace('alpha')
    useBasicAuth('root')
    const result = authorizeCall(keyOf('root', ['find_intents']), alpha, 'find_intents')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.scope).toMatchObject({
      keyId: 'key-1',
      ownerSubject: 'root',
      secretVersion: 3,
      workspaceName: alpha,
      policyEpoch: readPolicyEpoch(),
    })
    expect(result.scope.workspacePath).toBe(join(dir, 'alpha'))
    expect(Object.isFrozen(result.scope)).toBe(true)
    expect(Object.isFrozen(result.scope.tools)).toBe(true)
  })

  it('gives the trusted-local principal every workspace and the whole catalog', () => {
    const alpha = makeWorkspace('alpha')
    const result = authorizeCall(localPrincipal(), alpha, 'save_intents')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.scope.keyId).toBe(LOCAL_SUBJECT)
    expect(result.scope.secretVersion).toBe(0)
    expect(result.scope.tools).toContain('find_intents')
    expect(result.scope.tools).toContain('save_intents')
  })

  it('stops honouring the trusted-local principal once basic auth is configured', () => {
    const alpha = makeWorkspace('alpha')
    useBasicAuth('root')
    expect(authorizeCall(localPrincipal(), alpha, 'find_intents')).toEqual({
      ok: false,
      reason: 'owner',
    })
  })

  it('reports the current epoch, so a policy change is visible to the next call', () => {
    const alpha = makeWorkspace('alpha')
    useBasicAuth('root', 'alice')
    putWorkspaceScope('alice', 'all', [], 1)
    const before = authorizeCall(keyOf('alice', ['find_intents']), alpha, null)
    putWorkspaceScope('alice', 'all', [], 2)
    const after = authorizeCall(keyOf('alice', ['find_intents']), alpha, null)
    expect(before.ok && after.ok && after.scope.policyEpoch).toBeGreaterThan(
      before.ok ? before.scope.policyEpoch : 0,
    )
  })
})
