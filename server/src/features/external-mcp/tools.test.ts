/**
 * The catalog's EXECUTION-TIME guarantees, over the real intent/discussion
 * stores and the real owner-scope resolver.
 *
 * Three properties live here, and each of them only means something because the
 * caller is assumed hostile — a model that was talked into naming a workspace it
 * does not have or an id it saw quoted somewhere:
 *
 *  1. an id is checked against the workspace the CALL was authorized for, and a
 *     mismatch is answered exactly like a missing id;
 *  2. `list_workspaces` / `whoami` answer from the same resolver the gate
 *     intersects, never from arguments, and never with a path;
 *  3. provenance (`publish_event`'s envelope, an intent's session back-link) is
 *     derived from the scope, so nothing the caller writes can forge it.
 *
 * The dispatch ORDER these hang off — refuse before the handler, audit either
 * way — is the transport's, tested in `transport/external-mcp/index.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenericEventEnvelope } from '@ccc/shared'
import type { AuthConfig } from '@ccc/shared/protocol'
import { buildExternalMcpCatalog, externalMcpSourceId, type ExternalMcpTool } from './tools.js'
import type { EffectiveScope } from '../auth/authorization.js'
import { putWorkspaceScope } from '../auth/scope-store.js'
import { hashPassword } from '../auth/password.js'
import { authorizeCall, localPrincipal } from '../auth/authorization.js'
import {
  createDiscussion,
  resetStoreForTests as resetDiscussionStoreForTests,
} from '../discussions/store.js'
import { findIntents, getIntent, insertIntents, resetStoreForTests } from '../intents/store.js'
import { EventNormalizerRegistry } from '../../kernel/events/generic-event.js'
import { normalizeGenericEventDefault } from '../events/default-normalizer.js'
import {
  loadSettings,
  resetSettingsCacheForTests,
  saveSettings,
} from '../../kernel/config/index.js'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { addWorkspace, pathToName, resetStateCacheForTests } from '../../state.js'

const ADMIN = 'root'
/** A non-administrator account granted `alpha` and nothing else. */
const NARROW = 'agent'

let home: string
let alphaDir: string
let betaDir: string
let alpha: string
let beta: string
let published: GenericEventEnvelope[]
let broadcasts: string[]
let catalog: Map<string, ExternalMcpTool>

const normalizers = new EventNormalizerRegistry(normalizeGenericEventDefault)

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-external-tools-'))
  process.env.C3_DIR = home
  process.env.C3_DB_PATH = join(home, 'c3.db')
  resetSettingsCacheForTests()
  resetStateCacheForTests()
  resetDbForTests()
  resetStoreForTests()
  resetDiscussionStoreForTests()

  alphaDir = join(home, 'alpha')
  betaDir = join(home, 'beta')
  mkdirSync(alphaDir, { recursive: true })
  mkdirSync(betaDir, { recursive: true })
  addWorkspace(alphaDir, Date.now())
  addWorkspace(betaDir, Date.now())
  alpha = pathToName(alphaDir)!
  beta = pathToName(betaDir)!

  const auth: AuthConfig = {
    enabled: true,
    provider: {
      kind: 'basic',
      accounts: [
        { username: ADMIN, passwordHash: hashPassword('correct horse') },
        { username: NARROW, passwordHash: hashPassword('battery staple') },
      ],
      adminUsername: ADMIN,
    },
    session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_KEY' },
  }
  saveSettings({ ...loadSettings(), auth })
  putWorkspaceScope(NARROW, 'selected', [alpha], Date.now())

  published = []
  broadcasts = []
  catalog = new Map(
    buildExternalMcpCatalog({
      normalizeEvent: (core) => normalizers.normalize(core),
      publishEvent: (payload) => published.push(payload),
      broadcastIntents: (path) => broadcasts.push(path),
      broadcastDiscussions: (path) => broadcasts.push(path),
      broadcastDiscussionMessage: () => undefined,
      startDiscussionRun: () => undefined,
      launchRun: async () => undefined,
    }).map((tool) => [tool.name, tool]),
  )
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  delete process.env.C3_DIR
  resetSettingsCacheForTests()
  resetStateCacheForTests()
  rmSync(home, { recursive: true, force: true })
})

/** The gate's own answer for one caller — never a hand-built scope. */
function scopeFor(
  owner: string,
  workspaceName: string,
  tools: readonly string[] = ['find_intents'],
): EffectiveScope {
  const decision = authorizeCall(
    { keyId: 'key-1', ownerSubject: owner, secretVersion: 1, tools },
    workspaceName,
    null,
  )
  if (!decision.ok) throw new Error(`unexpected denial: ${decision.reason}`)
  return decision.scope
}

function tool(name: string): ExternalMcpTool {
  const entry = catalog.get(name)
  if (!entry) throw new Error(`no such tool: ${name}`)
  return entry
}

/** What the dispatcher would answer with, or `null` when the call may proceed. */
function refusal(name: string, args: unknown, scope: EffectiveScope): string | null {
  return tool(name).validate?.(args, scope) ?? null
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((c) => c.text).join('\n')
}

describe('the write-only workspace override', () => {
  it('is offered by every write tool and by no read tool', () => {
    for (const entry of catalog.values()) {
      expect(
        Object.keys(entry.inputSchema).includes('workspaceName'),
        `${entry.name} (${entry.access})`,
      ).toBe(entry.access === 'write')
    }
  })

  it('is optional on every write tool — an existing client that omits it stays valid', () => {
    for (const entry of catalog.values()) {
      if (entry.access !== 'write') continue
      const field = z.object({ workspaceName: entry.inputSchema.workspaceName })
      expect(field.safeParse({}).success, entry.name).toBe(true)
      expect(field.safeParse({ workspaceName: alpha }).success, entry.name).toBe(true)
      expect(field.safeParse({ workspaceName: 7 }).success, entry.name).toBe(false)
    }
  })
})

describe('id ownership', () => {
  it('accepts an upsert target that really belongs to the authorized workspace', () => {
    const [mine] = insertIntents(alphaDir, [
      { title: 'Mine', shortEnTitle: 'mine', content: '', priority: 'P2' },
    ])
    const args = {
      intents: [
        { id: mine.id, title: 'Mine', shortEnTitle: 'mine', content: 'x', priority: 'P2' as const },
      ],
    }
    expect(refusal('save_intents', args, scopeFor(NARROW, alpha))).toBeNull()
  })

  it('refuses a save_intents upsert target owned by another workspace, before any write', () => {
    const [foreign] = insertIntents(betaDir, [
      { title: 'Foreign', shortEnTitle: 'foreign', content: '', priority: 'P2' },
    ])
    const args = {
      intents: [
        {
          id: foreign.id,
          title: 'Hijacked',
          shortEnTitle: 'hijacked',
          content: 'x',
          priority: 'P0' as const,
        },
      ],
    }
    expect(refusal('save_intents', args, scopeFor(NARROW, alpha))).toBe(
      `未找到 id 为 ${foreign.id} 的意图(本项目)。`,
    )
    expect(getIntent(foreign.id)?.title).toBe('Foreign')
  })

  it('refuses a persisted dependency reference owned by another workspace', () => {
    const [foreign] = insertIntents(betaDir, [
      { title: 'Foreign', shortEnTitle: 'foreign', content: '', priority: 'P2' },
    ])
    const args = {
      intents: [
        {
          title: 'New here',
          shortEnTitle: 'new-here',
          content: '',
          priority: 'P2' as const,
          dependsOn: [foreign.id],
        },
      ],
    }
    expect(refusal('save_intents', args, scopeFor(NARROW, alpha))).toBe(
      `未找到 id 为 ${foreign.id} 的意图(本项目)。`,
    )
  })

  it('rejects the WHOLE batch when one item of many is hostile', () => {
    const [foreign] = insertIntents(betaDir, [
      { title: 'Foreign', shortEnTitle: 'foreign', content: '', priority: 'P2' },
    ])
    const [mine] = insertIntents(alphaDir, [
      { title: 'Mine', shortEnTitle: 'mine', content: '', priority: 'P2' },
    ])
    const args = {
      intents: [
        {
          id: mine.id,
          title: 'Edited',
          shortEnTitle: 'edited',
          content: 'x',
          priority: 'P2' as const,
        },
        {
          id: foreign.id,
          title: 'Hijacked',
          shortEnTitle: 'hijacked',
          content: 'x',
          priority: 'P0' as const,
        },
      ],
    }
    expect(refusal('save_intents', args, scopeFor(NARROW, alpha))).not.toBeNull()
    // Nothing ran, so the innocent sibling is untouched too.
    expect(getIntent(mine.id)?.title).toBe('Mine')
  })

  it('refuses a foreign dependency through the create-only writer too', () => {
    // `save_intent_directly` mints new rows, so it has no upsert target to own —
    // but the edge it persists is the same one, and guarding only the other
    // intent writer would leave the cross-workspace edge one tool name away.
    const [foreign] = insertIntents(betaDir, [
      { title: 'Foreign', shortEnTitle: 'foreign', content: '', priority: 'P2' },
    ])
    const args = {
      intents: [
        {
          title: 'New here',
          shortEnTitle: 'new-here',
          content: '',
          priority: 'P2' as const,
          dependsOn: [foreign.id],
        },
      ],
    }
    const scope = scopeFor(NARROW, alpha)
    expect(refusal('save_intent_directly', args, scope)).toBe(
      `未找到 id 为 ${foreign.id} 的意图(本项目)。`,
    )
    // Word-for-word what a plainly non-existent id answers, so the refusal
    // cannot be read as "that id exists in some other workspace".
    const absent = '00000000-0000-4000-8000-000000000000'
    expect(
      refusal(
        'save_intent_directly',
        { intents: [{ ...args.intents[0], dependsOn: [absent] }] },
        scope,
      ),
    ).toBe(`未找到 id 为 ${absent} 的意图(本项目)。`)
    // And nothing was written on the way to finding out.
    expect(findIntents(alphaDir, {})).toHaveLength(0)
  })

  it('accepts a create-only batch whose dependency is this workspace’s own', () => {
    const [mine] = insertIntents(alphaDir, [
      { title: 'Mine', shortEnTitle: 'mine', content: '', priority: 'P2' },
    ])
    const args = {
      intents: [
        {
          title: 'Follows mine',
          shortEnTitle: 'follows-mine',
          content: '',
          priority: 'P2' as const,
          dependsOn: [mine.id],
        },
      ],
    }
    expect(refusal('save_intent_directly', args, scopeFor(NARROW, alpha))).toBeNull()
  })

  it('leaves intra-batch index dependencies alone — they address this batch', () => {
    const args = {
      intents: [
        { title: 'First', shortEnTitle: 'first', content: '', priority: 'P2' as const },
        {
          title: 'Second',
          shortEnTitle: 'second',
          content: '',
          priority: 'P2' as const,
          dependsOnIndexes: [0],
        },
      ],
    }
    expect(refusal('save_intents', args, scopeFor(NARROW, alpha))).toBeNull()
  })

  it.each([
    ['submit_spec_review', (id: string) => ({ intentId: id, verdict: 'pass', reason: 'x' })],
    ['start_session_for_intent', (id: string) => ({ intentId: id, sessionType: 'work' })],
  ])('refuses %s for an intent owned by another workspace', (name, build) => {
    const [foreign] = insertIntents(betaDir, [
      { title: 'Foreign', shortEnTitle: 'foreign', content: '', priority: 'P2' },
    ])
    const scope = scopeFor(NARROW, alpha)
    expect(refusal(name, build(foreign.id), scope)).not.toBeNull()
    // …and an id that does not exist at all is answered identically, so the
    // refusal cannot be read as "this id exists somewhere else".
    expect(refusal(name, build('00000000-0000-4000-8000-000000000000'), scope)).toBe(
      refusal(name, build(foreign.id), scope),
    )
  })

  // Both discussion writers are checked BEFORE their handler, so a mis-owned id
  // is a `rejected` from either — never a `failure` from one and a `rejected`
  // from the other for the same mistake.
  it.each(['continue_discussion', 'start_discussion'])(
    'refuses %s for a discussion owned by another workspace',
    (name) => {
      const foreign = createDiscussion({ workspacePath: betaDir, title: 'Foreign', type: 'design' })
      const scope = scopeFor(NARROW, alpha)
      expect(refusal(name, { discussionId: foreign.id }, scope)).toBe(
        `未找到 id 为 ${foreign.id} 的讨论(本项目)。`,
      )
    },
  )

  it.each(['continue_discussion', 'start_discussion'])(
    'accepts a discussion that belongs to the authorized workspace (%s)',
    (name) => {
      const mine = createDiscussion({ workspacePath: alphaDir, title: 'Mine', type: 'design' })
      expect(refusal(name, { discussionId: mine.id }, scopeFor(NARROW, alpha))).toBeNull()
    },
  )

  it('accepts a foreign id once the CALL is authorized for that workspace', () => {
    // The check is against the workspace the call was authorized for, not
    // against the session's — an administrator naming `beta` explicitly is
    // entitled to act on `beta`'s intents.
    const [there] = insertIntents(betaDir, [
      { title: 'Over there', shortEnTitle: 'over-there', content: '', priority: 'P2' },
    ])
    expect(
      refusal(
        'submit_spec_review',
        { intentId: there.id, verdict: 'pass', reason: 'x' },
        scopeFor(ADMIN, beta),
      ),
    ).toBeNull()
  })
})

describe('scope discovery', () => {
  it('lists exactly the selected subset for a narrowly-scoped owner', async () => {
    const result = await tool('list_workspaces').handler({}, scopeFor(NARROW, alpha))
    expect(JSON.parse(textOf(result))).toEqual({ workspaces: [alpha] })
  })

  it('lists the whole registry for the administrator', async () => {
    const result = await tool('list_workspaces').handler({}, scopeFor(ADMIN, alpha))
    expect(JSON.parse(textOf(result)).workspaces.sort()).toEqual([alpha, beta].sort())
  })

  it('lists nothing for an owner whose selection is empty', async () => {
    putWorkspaceScope(NARROW, 'selected', [], Date.now())
    // The gate itself now refuses every workspace, so the scope under test is
    // the last one the owner legitimately held.
    const stale = { ...scopeFor(ADMIN, alpha), ownerSubject: NARROW }
    const result = await tool('list_workspaces').handler({}, stale)
    expect(JSON.parse(textOf(result))).toEqual({ workspaces: [] })
  })

  it('lists the whole registry for the trusted-local principal', async () => {
    saveSettings({ ...loadSettings(), auth: undefined })
    const local = localPrincipal()
    const decision = authorizeCall(local, alpha, null)
    expect(decision.ok).toBe(true)
    if (!decision.ok) return
    const result = await tool('list_workspaces').handler({}, decision.scope)
    expect(JSON.parse(textOf(result)).workspaces.sort()).toEqual([alpha, beta].sort())
  })

  it('never returns a filesystem path', async () => {
    const result = await tool('list_workspaces').handler({}, scopeFor(ADMIN, alpha))
    expect(textOf(result)).not.toContain(alphaDir)
    expect(textOf(result)).not.toContain(home)
  })

  it('reports owner, reach and granted tools in whoami — and nothing secret', async () => {
    const scope = scopeFor(NARROW, alpha, ['find_intents', 'whoami', 'save_intents'])
    const identity = JSON.parse(textOf(await tool('whoami').handler({}, scope))) as {
      keyId: string
      owner: string
      workspace: string
      workspaces: string[]
      tools: string[]
    }
    expect(identity).toEqual({
      keyId: 'key-1',
      owner: NARROW,
      workspace: alpha,
      workspaces: [alpha],
      tools: ['find_intents', 'whoami', 'save_intents'],
    })
    // The scope carries a resolved path; whoami must not pass it on.
    expect(textOf(await tool('whoami').handler({}, scope))).not.toContain(alphaDir)
  })

  it('reports the tools the gate actually granted, not the ones the key asked for', async () => {
    // A key carrying a name the catalog does not offer grants nothing by it, and
    // whoami must show the intersected truth rather than the stored wish.
    const scope = scopeFor(NARROW, alpha, ['find_intents', 'no_such_tool'])
    const identity = JSON.parse(textOf(await tool('whoami').handler({}, scope))) as {
      tools: string[]
    }
    expect(identity.tools).toEqual(['find_intents'])
  })
})

describe('provenance', () => {
  it('derives the publish_event envelope from the scope, not from the payload', async () => {
    const scope = scopeFor(NARROW, alpha, ['publish_event'])
    await tool('publish_event').handler(
      {
        type: 'custom:ping',
        status: 'success',
        // Every field a caller might use to claim it is somebody else.
        metadata: { workspaceName: beta, sessionId: 'run-42', source: 'c3-internal' },
        data: { workspacePath: betaDir, sessionId: 'run-42' },
      },
      scope,
    )
    expect(published).toHaveLength(1)
    expect(published[0].workspacePath).toBe(alphaDir)
    expect(published[0].sessionId).toBe(externalMcpSourceId('key-1', alpha))
  })

  it('names the workspace in the source id, so one key stays attributable across workspaces', async () => {
    await tool('publish_event').handler({ type: 'custom:ping' }, scopeFor(ADMIN, alpha))
    await tool('publish_event').handler({ type: 'custom:ping' }, scopeFor(ADMIN, beta))
    expect(published.map((p) => p.sessionId)).toEqual([
      `external-mcp:key-1@${alpha}`,
      `external-mcp:key-1@${beta}`,
    ])
  })

  it('never persists a caller-supplied intentSessionId', async () => {
    const scope = scopeFor(NARROW, alpha, ['save_intents'])
    const result = await tool('save_intents').handler(
      {
        intents: [
          {
            title: 'Backlinked',
            shortEnTitle: 'backlinked',
            content: '',
            priority: 'P2',
            intentSessionId: 'somebody-elses-session',
          },
        ],
      },
      scope,
    )
    expect(result.isError).toBeFalsy()
    const saved = findIntents(alphaDir, { keyword: 'Backlinked' })
    expect(saved).toHaveLength(1)
    expect(saved[0].intentSessionId).toBeNull()
  })
})
