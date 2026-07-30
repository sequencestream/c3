import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ClientToServer, PersonalizedSettings, ServerToClient } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'

// Stub the store: the handlers own authorization + wire shape, not persistence
// (persistence has its own tests in kernel/config/personalized.test.ts). Recording
// the subject each call receives is how we assert a client can never address
// another account.
const h = vi.hoisted(() => ({
  resolveCalls: [] as { subject: string | null; localFallback?: PersonalizedSettings }[],
  saveCalls: [] as { subject: string | null; settings: PersonalizedSettings }[],
  stored: { uiLang: 'zh' } as PersonalizedSettings,
  throwOnResolve: false,
  throwOnSave: false,
}))
vi.mock('../../kernel/config/personalized.js', () => ({
  resolvePersonalized: (subject: string | null, localFallback?: PersonalizedSettings) => {
    h.resolveCalls.push({ subject, localFallback })
    if (h.throwOnResolve) throw new Error('disk unavailable')
    return h.stored
  },
  savePersonalizedFor: (subject: string | null, settings: PersonalizedSettings) => {
    h.saveCalls.push({ subject, settings })
    if (h.throwOnSave) throw new Error('disk unavailable')
    return settings
  },
}))

// The admin gate must never be consulted for this settings class; a throwing stub
// turns any accidental call into a failing test rather than a silent policy change.
vi.mock('../auth/authz.js', () => ({
  requireAdmin: () => {
    throw new Error('personalized settings must not consult the admin gate')
  },
}))

const { getPersonalizedSettings, savePersonalizedSettingsHandler } =
  await import('./personalized.js')

const ctx = {} as KernelContext

function makeConn(subject: string | null): { conn: Conn; sent: ServerToClient[] } {
  const sent: ServerToClient[] = []
  const conn = {
    send: (m: ServerToClient) => sent.push(m),
    authed: true,
    authToken: subject ? 'tok' : null,
    subject,
  } as unknown as Conn
  return { conn, sent }
}

beforeEach(() => {
  h.resolveCalls = []
  h.saveCalls = []
  h.stored = { uiLang: 'zh' }
  h.throwOnResolve = false
  h.throwOnSave = false
})

describe('get_personalized_settings', () => {
  it('reads the connection subject and echoes the account scope', () => {
    const { conn, sent } = makeConn('alice')
    getPersonalizedSettings(ctx, conn, { type: 'get_personalized_settings' })
    expect(h.resolveCalls).toEqual([{ subject: 'alice', localFallback: undefined }])
    expect(sent).toEqual([
      { type: 'personalized_settings', settings: { uiLang: 'zh' }, scope: 'account' },
    ])
  })

  it('passes the browser fallback through as a seed', () => {
    const { conn } = makeConn('alice')
    getPersonalizedSettings(ctx, conn, {
      type: 'get_personalized_settings',
      localFallback: { uiLang: 'ru' },
    })
    expect(h.resolveCalls[0].localFallback).toEqual({ uiLang: 'ru' })
  })

  it('reports the local scope when no account applies', () => {
    const { conn, sent } = makeConn(null)
    h.stored = { uiLang: 'en' }
    getPersonalizedSettings(ctx, conn, { type: 'get_personalized_settings' })
    expect(h.resolveCalls[0].subject).toBe(null)
    expect(sent).toEqual([
      { type: 'personalized_settings', settings: { uiLang: 'en' }, scope: 'local' },
    ])
  })

  it('ignores a subject the client tries to smuggle into the frame', () => {
    const { conn } = makeConn('alice')
    getPersonalizedSettings(ctx, conn, {
      type: 'get_personalized_settings',
      // A hand-crafted frame naming someone else's account.
      subject: 'bob',
    } as unknown as Extract<ClientToServer, { type: 'get_personalized_settings' }>)
    expect(h.resolveCalls[0].subject).toBe('alice')
  })

  it('answers a failed read with an error, never a fabricated snapshot', () => {
    const { conn, sent } = makeConn('alice')
    h.throwOnResolve = true
    getPersonalizedSettings(ctx, conn, { type: 'get_personalized_settings' })
    expect(sent).toEqual([{ type: 'error', error: { code: 'personalizedSetting.loadFailed' } }])
  })
})

describe('save_personalized_settings', () => {
  it('lets a plain non-admin account save its own settings', () => {
    const { conn, sent } = makeConn('bob')
    savePersonalizedSettingsHandler(ctx, conn, {
      type: 'save_personalized_settings',
      settings: { uiLang: 'ja' },
    })
    expect(h.saveCalls).toEqual([{ subject: 'bob', settings: { uiLang: 'ja' } }])
    expect(sent).toEqual([
      { type: 'personalized_settings', settings: { uiLang: 'ja' }, scope: 'account' },
    ])
  })

  it('writes under the connection subject, not one named in the frame', () => {
    const { conn } = makeConn('bob')
    savePersonalizedSettingsHandler(ctx, conn, {
      type: 'save_personalized_settings',
      settings: { uiLang: 'ja' },
      subject: 'alice',
    } as unknown as Extract<ClientToServer, { type: 'save_personalized_settings' }>)
    expect(h.saveCalls[0].subject).toBe('bob')
  })

  it('saves with a local scope when no account applies', () => {
    const { conn, sent } = makeConn(null)
    savePersonalizedSettingsHandler(ctx, conn, {
      type: 'save_personalized_settings',
      settings: { uiLang: 'ko' },
    })
    expect(h.saveCalls[0].subject).toBe(null)
    expect(sent).toEqual([
      { type: 'personalized_settings', settings: { uiLang: 'ko' }, scope: 'local' },
    ])
  })

  it('answers a failed write with an error, never a pseudo-success echo', () => {
    const { conn, sent } = makeConn('bob')
    h.throwOnSave = true
    savePersonalizedSettingsHandler(ctx, conn, {
      type: 'save_personalized_settings',
      settings: { uiLang: 'ja' },
    })
    expect(sent).toEqual([{ type: 'error', error: { code: 'personalizedSetting.saveFailed' } }])
  })
})
