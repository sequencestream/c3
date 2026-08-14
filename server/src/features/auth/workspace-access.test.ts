/**
 * The console's two views of `user_workspace_scopes`, against a real database:
 * the administrator's editor and the per-workspace accessor list.
 *
 * What is asserted is mostly what does NOT happen — a non-admin does not receive
 * the roster, an immutable subject does not get a row, a rejected save does not
 * move the epoch or close a session — because every one of those is a way the
 * editor could hand out access nobody granted.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthConfig, ServerToClient } from '@ccc/shared/protocol'
import { releaseConfigDb, useConfigDb } from '../../kernel/config/config-fixture.js'
import { loadSettings, saveSettings } from '../../kernel/config/index.js'
import { registerWorkspace } from '../../kernel/config/workspace-store.js'
import { readPolicyEpoch } from '../../kernel/config/policy-epoch.js'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { hashPassword } from './password.js'
import {
  putWorkspaceScope,
  readWorkspaceScope,
  resetWorkspaceScopeStoreForTests,
} from './scope-store.js'
import {
  getUserWorkspaceAccessHandler,
  getWorkspaceAccessorsHandler,
  saveUserWorkspaceAccessHandler,
  setExternalMcpOwnerSessionCloser,
} from './workspace-access.js'

const ctx = {} as KernelContext

let dir: string
/** Owners whose live sessions the composition-root hook was asked to close. */
let closed: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-ws-access-'))
  useConfigDb(dir)
  resetWorkspaceScopeStoreForTests()
  closed = []
  setExternalMcpOwnerSessionCloser((owner) => closed.push(owner))
})

afterEach(() => {
  releaseConfigDb()
  resetWorkspaceScopeStoreForTests()
  setExternalMcpOwnerSessionCloser(null)
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

function connAs(subject: string | null): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn = {
    send: (m: ServerToClient) => sent.push(m),
    authed: true,
    authToken: 'tok',
    subject,
  } as unknown as Conn
  return { conn, sent }
}

type AccessMsg = Extract<ServerToClient, { type: 'user_workspace_access' }>
type AccessorsMsg = Extract<ServerToClient, { type: 'workspace_accessors' }>

describe('get_user_workspace_access', () => {
  it('refuses a non-admin connection without disclosing one account or workspace', () => {
    useBasicAuth('root', 'alice')
    makeWorkspace('proj')
    const { conn, sent } = connAs('alice')
    getUserWorkspaceAccessHandler(ctx, conn, { type: 'get_user_workspace_access' })

    expect(sent).toEqual([{ type: 'error', error: { code: 'auth.adminOnly' } }])
    // Not merely "the tab is hidden": the inventory never crosses the wire.
    expect(JSON.stringify(sent)).not.toContain('proj')
    expect(JSON.stringify(sent)).not.toContain('alice')
  })

  it('distinguishes an absent policy from selected-with-nothing-selected and from all', () => {
    useBasicAuth('root', 'alice', 'bob', 'carol')
    const proj = makeWorkspace('proj')
    putWorkspaceScope('bob', 'selected', [], 1)
    putWorkspaceScope('carol', 'all', [], 1)

    const { conn, sent } = connAs('root')
    getUserWorkspaceAccessHandler(ctx, conn, { type: 'get_user_workspace_access' })
    const msg = sent[0] as AccessMsg

    expect(msg.workspaces.map((w) => w.name)).toEqual([proj])
    const byName = Object.fromEntries(msg.accounts.map((a) => [a.subject, a]))
    // Nobody configured alice. Bob was deliberately given nothing. Both deny —
    // only one of them is a decision, and the editor has to be able to say which.
    expect(byName.alice.policy).toBeNull()
    expect(byName.bob.policy).toEqual({ mode: 'selected', workspaces: [] })
    expect(byName.carol.policy).toEqual({ mode: 'all', workspaces: [] })
  })

  it('shows the administrator as an immutable row and never as a stored policy', () => {
    useBasicAuth('root', 'alice')
    const { conn, sent } = connAs('root')
    getUserWorkspaceAccessHandler(ctx, conn, { type: 'get_user_workspace_access' })
    const msg = sent[0] as AccessMsg

    const root = msg.accounts.find((a) => a.subject === 'root')!
    expect(root).toEqual({ subject: 'root', isAdmin: true, editable: false, policy: null })
    expect(msg.accounts.find((a) => a.subject === 'alice')?.editable).toBe(true)
  })

  it('shows `local` as the sole immutable identity when no administrator applies', () => {
    // Trusted-local: the gate is inert, so any connection reads the roster — and
    // the roster is exactly one implicit principal.
    const { conn, sent } = connAs(null)
    getUserWorkspaceAccessHandler(ctx, conn, { type: 'get_user_workspace_access' })
    const msg = sent[0] as AccessMsg
    expect(msg.accounts).toEqual([
      { subject: 'local', isAdmin: true, editable: false, policy: null },
    ])
  })
})

describe('save_user_workspace_access', () => {
  it('replaces exactly one account’s policy, bumps the epoch, and closes that owner’s sessions', () => {
    useBasicAuth('root', 'alice', 'bob')
    const a = makeWorkspace('alpha')
    const b = makeWorkspace('beta')
    putWorkspaceScope('bob', 'selected', [b], 1)
    const before = readPolicyEpoch()

    const { conn, sent } = connAs('root')
    saveUserWorkspaceAccessHandler(ctx, conn, {
      type: 'save_user_workspace_access',
      subject: 'alice',
      mode: 'selected',
      workspaces: [a],
    })

    expect(readWorkspaceScope('alice')).toMatchObject({ mode: 'selected', workspaces: [a] })
    // The neighbouring account is untouched — one save is one account.
    expect(readWorkspaceScope('bob')).toMatchObject({ mode: 'selected', workspaces: [b] })
    expect(readPolicyEpoch()).toBeGreaterThan(before)
    // Persist-first, close-second, and only the edited owner.
    expect(closed).toEqual(['alice'])
    const msg = sent[0] as AccessMsg
    expect(msg.type).toBe('user_workspace_access')
    expect(msg.accounts.find((x) => x.subject === 'alice')?.policy).toEqual({
      mode: 'selected',
      workspaces: [a],
    })
  })

  it('stores no names under `all`, because `all` follows the registry', () => {
    useBasicAuth('root', 'alice')
    const a = makeWorkspace('alpha')
    const { conn } = connAs('root')
    saveUserWorkspaceAccessHandler(ctx, conn, {
      type: 'save_user_workspace_access',
      subject: 'alice',
      mode: 'all',
      workspaces: [a],
    })
    expect(readWorkspaceScope('alice')).toMatchObject({ mode: 'all', workspaces: [] })
  })

  it('refuses a non-admin connection and writes nothing', () => {
    useBasicAuth('root', 'alice', 'bob')
    const a = makeWorkspace('alpha')
    const before = readPolicyEpoch()
    const { conn, sent } = connAs('bob')
    saveUserWorkspaceAccessHandler(ctx, conn, {
      type: 'save_user_workspace_access',
      subject: 'alice',
      mode: 'selected',
      workspaces: [a],
    })

    expect(sent).toEqual([{ type: 'error', error: { code: 'auth.adminOnly' } }])
    expect(readWorkspaceScope('alice')).toBeNull()
    expect(readPolicyEpoch()).toBe(before)
    expect(closed).toEqual([])
  })

  it('refuses to write the administrator, so an administrator cannot lock themselves out', () => {
    useBasicAuth('root', 'alice')
    const before = readPolicyEpoch()
    const { conn, sent } = connAs('root')
    saveUserWorkspaceAccessHandler(ctx, conn, {
      type: 'save_user_workspace_access',
      subject: 'root',
      mode: 'selected',
      workspaces: [],
    })

    expect(sent[0]).toMatchObject({ error: { code: 'userAccess.immutableSubject' } })
    expect(readWorkspaceScope('root')).toBeNull()
    expect(readPolicyEpoch()).toBe(before)
    expect(closed).toEqual([])
  })

  it('refuses to write the synthesized local identity', () => {
    const { conn, sent } = connAs(null)
    saveUserWorkspaceAccessHandler(ctx, conn, {
      type: 'save_user_workspace_access',
      subject: 'local',
      mode: 'all',
      workspaces: [],
    })
    expect(sent[0]).toMatchObject({ error: { code: 'userAccess.immutableSubject' } })
    expect(readWorkspaceScope('local')).toBeNull()
  })

  it('rolls back the whole save when one workspace name is unknown', () => {
    useBasicAuth('root', 'alice')
    const a = makeWorkspace('alpha')
    const before = readPolicyEpoch()
    const { conn, sent } = connAs('root')
    saveUserWorkspaceAccessHandler(ctx, conn, {
      type: 'save_user_workspace_access',
      subject: 'alice',
      mode: 'selected',
      workspaces: [a, 'ghost'],
    })

    expect(sent[0]).toMatchObject({
      error: { code: 'userAccess.unknownWorkspace', params: { workspaceName: 'ghost' } },
    })
    // Not even the valid half landed — what is saved is always what was submitted.
    expect(readWorkspaceScope('alice')).toBeNull()
    expect(readPolicyEpoch()).toBe(before)
    expect(closed).toEqual([])
  })

  it('refuses an account the roster does not have', () => {
    useBasicAuth('root', 'alice')
    const { conn, sent } = connAs('root')
    saveUserWorkspaceAccessHandler(ctx, conn, {
      type: 'save_user_workspace_access',
      subject: 'departed',
      mode: 'all',
      workspaces: [],
    })
    expect(sent[0]).toMatchObject({
      error: { code: 'userAccess.unknownAccount', params: { subject: 'departed' } },
    })
    expect(readWorkspaceScope('departed')).toBeNull()
    expect(closed).toEqual([])
  })

  it('refuses a mode it cannot interpret rather than guessing either way', () => {
    useBasicAuth('root', 'alice')
    const before = readPolicyEpoch()
    const { conn, sent } = connAs('root')
    saveUserWorkspaceAccessHandler(ctx, conn, {
      type: 'save_user_workspace_access',
      subject: 'alice',
      mode: 'everything' as 'all',
      workspaces: [],
    })
    expect(sent[0]).toMatchObject({ error: { code: 'userAccess.invalidMode' } })
    expect(readWorkspaceScope('alice')).toBeNull()
    expect(readPolicyEpoch()).toBe(before)
  })

  it('still saves when no external route is wired (unit / embedded server)', () => {
    setExternalMcpOwnerSessionCloser(null)
    useBasicAuth('root', 'alice')
    const { conn, sent } = connAs('root')
    saveUserWorkspaceAccessHandler(ctx, conn, {
      type: 'save_user_workspace_access',
      subject: 'alice',
      mode: 'all',
      workspaces: [],
    })
    expect(readWorkspaceScope('alice')).toMatchObject({ mode: 'all' })
    expect((sent[0] as { type: string }).type).toBe('user_workspace_access')
  })
})

describe('a newly registered workspace', () => {
  it('is immediately effective for `all` and stays out of `selected`, without rewriting details', () => {
    useBasicAuth('root', 'wide', 'narrow')
    const alpha = makeWorkspace('alpha')
    putWorkspaceScope('wide', 'all', [], 1)
    putWorkspaceScope('narrow', 'selected', [alpha], 1)

    const beta = makeWorkspace('beta')

    const { conn, sent } = connAs('root')
    getUserWorkspaceAccessHandler(ctx, conn, { type: 'get_user_workspace_access' })
    const msg = sent[0] as AccessMsg
    // Both are offered as checkboxes. Registry ORDER is the registry's business
    // (it is recency-ordered), so this asserts membership and nothing more.
    expect(msg.workspaces.map((w) => w.name).sort()).toEqual([alpha, beta].sort())
    // The selected list is untouched — a registration does not edit a policy.
    expect(readWorkspaceScope('narrow')).toMatchObject({ mode: 'selected', workspaces: [alpha] })

    // And the effect shows up where it is enforced: `all` reaches the new
    // workspace, `selected` does not.
    const wide = connAs('root')
    getWorkspaceAccessorsHandler(ctx, wide.conn, {
      type: 'get_workspace_accessors',
      workspaceName: beta,
    })
    expect((wide.sent[0] as AccessorsMsg).subjects).toEqual(['root', 'wide'])
  })
})

describe('get_workspace_accessors', () => {
  it('lists the effective accessors, administrator included, for a workspace the caller can see', () => {
    useBasicAuth('root', 'alice', 'bob')
    const alpha = makeWorkspace('alpha')
    makeWorkspace('beta')
    putWorkspaceScope('alice', 'selected', [alpha], 1)
    putWorkspaceScope('bob', 'selected', [], 1)

    const { conn, sent } = connAs('alice')
    getWorkspaceAccessorsHandler(ctx, conn, {
      type: 'get_workspace_accessors',
      workspaceName: alpha,
    })
    const msg = sent[0] as AccessorsMsg
    expect(msg.workspaceName).toBe(alpha)
    // `root` through its implicit `all`, `alice` through her selection; `bob`
    // was deliberately given nothing and is absent.
    expect(msg.subjects).toEqual(['root', 'alice'])
  })

  it('refuses an unknown workspace and an out-of-scope one identically', () => {
    useBasicAuth('root', 'alice')
    const alpha = makeWorkspace('alpha')
    const beta = makeWorkspace('beta')
    putWorkspaceScope('alice', 'selected', [alpha], 1)

    const hidden = connAs('alice')
    getWorkspaceAccessorsHandler(ctx, hidden.conn, {
      type: 'get_workspace_accessors',
      workspaceName: beta,
    })
    const ghost = connAs('alice')
    getWorkspaceAccessorsHandler(ctx, ghost.conn, {
      type: 'get_workspace_accessors',
      workspaceName: 'no-such-workspace',
    })

    // One shape for both, so the read cannot be used to probe which names exist.
    const refusal = [{ type: 'error', error: { code: 'workspaceAccessors.forbidden' } }]
    expect(hidden.sent).toEqual(refusal)
    expect(ghost.sent).toEqual(refusal)
  })

  it('refuses an unauthenticated connection under basic auth', () => {
    useBasicAuth('root', 'alice')
    const alpha = makeWorkspace('alpha')
    const { conn, sent } = connAs(null)
    getWorkspaceAccessorsHandler(ctx, conn, {
      type: 'get_workspace_accessors',
      workspaceName: alpha,
    })
    expect(sent).toEqual([{ type: 'error', error: { code: 'workspaceAccessors.forbidden' } }])
  })

  it('answers `local` for a trusted-local deployment', () => {
    const alpha = makeWorkspace('alpha')
    const { conn, sent } = connAs(null)
    getWorkspaceAccessorsHandler(ctx, conn, {
      type: 'get_workspace_accessors',
      workspaceName: alpha,
    })
    expect((sent[0] as AccessorsMsg).subjects).toEqual(['local'])
  })
})
