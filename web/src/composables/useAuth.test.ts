import { describe, it, expect, beforeEach } from 'vitest'
import type { ClientToServer } from '@ccc/shared/protocol'
import { useAuth } from './useAuth'

// useAuth is a module singleton; vitest isolates module state per test file, so
// this file owns a single instance. We re-establish a known precondition in each
// test via the public methods (each handler sets a fully-determined state).
const auth = useAuth()

describe('useAuth — auth state machine (ADR-0023)', () => {
  let sent: ClientToServer[]

  beforeEach(() => {
    sent = []
    auth.bindSender((m) => sent.push(m))
  })

  it('submitLogin → 发 login 消息并置 pending', () => {
    auth.submitLogin('alice', 'pw')
    expect(sent).toEqual([{ type: 'login', request: { username: 'alice', password: 'pw' } }])
    expect(auth.pending.value).toBe(true)
  })

  it('login_result.ok → authenticated + 存 token + 清 pending/错误', () => {
    auth.handleLoginResult({ ok: true, token: 'tok-123', expiresAt: 999 })
    expect(auth.status.value).toBe('authenticated')
    expect(auth.currentToken()).toBe('tok-123')
    expect(auth.pending.value).toBe(false)
    expect(auth.loginError.value).toBe(null)
  })

  it('login_result 失败 → 记录错误码、停 pending,不进主界面', () => {
    auth.submitLogin('alice', 'bad')
    auth.handleLoginResult({ ok: false, code: 'invalid_credentials' })
    expect(auth.loginError.value).toBe('invalid_credentials')
    expect(auth.pending.value).toBe(false)
  })

  it('unauthenticated → login-required + 清 token + 记 reason', () => {
    auth.handleLoginResult({ ok: true, token: 'tok-xyz', expiresAt: 1 }) // 先认证
    auth.handleUnauthenticated('expired')
    expect(auth.status.value).toBe('login-required')
    expect(auth.currentToken()).toBe(null)
    expect(auth.lastReason.value).toBe('expired')
  })

  it('logout → 发 logout 消息、清 token、回登录门', () => {
    auth.handleLoginResult({ ok: true, token: 'tok-9', expiresAt: 1 })
    auth.logout()
    expect(sent).toContainEqual({ type: 'logout' })
    expect(auth.currentToken()).toBe(null)
    expect(auth.status.value).toBe('login-required')
  })
})
