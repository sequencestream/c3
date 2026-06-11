// Web-side authentication state (ADR-0023, auth-overview Roadmap step 3).
//
// A reactive singleton shared by App.vue (message routing + the login gate) and
// Login.vue (the form). The model is PURELY REACTIVE to the server: status stays
// `'unknown'` until the server says otherwise. When auth is disabled the server
// never emits `unauthenticated`, so status never leaves `'unknown'` and the app
// renders normally — existing (no-auth) users are unaffected (AUTH-R2).
//
//   unknown ──(unauthenticated)──▶ login-required ──(login_result.ok)──▶ authenticated
//      ▲                                                                      │
//      └──────────────────────── (this connection never re-auths) ───────────┘
//   authenticated ──(logout | unauthenticated)──▶ login-required
//
// The token minted on a successful login is persisted (lib/authToken) and
// re-presented on every WS (re)connect as a `?token=` handshake param, so a
// reconnect (server restart, network blip) resumes the session without a
// re-prompt — the "smooth session" the spec requires.

import { ref, readonly } from 'vue'
import type { ClientToServer, AuthLoginResult, AuthFailureCode } from '@ccc/shared/protocol'
import { getToken as readStoredToken, setToken, clearToken } from '@/lib/authToken'

/** WS-level 401 reasons (server→client `unauthenticated.reason`). */
export type UnauthenticatedReason = 'missing' | 'expired' | 'invalid'

/** Login-gate visibility / session state. */
export type AuthStatus = 'unknown' | 'authenticated' | 'login-required'

type Sender = (msg: ClientToServer) => void

// --- Module-singleton state (shared across all useAuth() callers) -----------
const status = ref<AuthStatus>('unknown')
const token = ref<string | null>(readStoredToken())
const loginError = ref<AuthFailureCode | null>(null)
const pending = ref(false)
const lastReason = ref<UnauthenticatedReason | null>(null)

let send: Sender | null = null

/** Bind the live WS sender (App.vue owns the client). */
function bindSender(fn: Sender): void {
  send = fn
}

/** The token to present on the next WS (re)connect, or null. Passed to `createWsClient`. */
function currentToken(): string | null {
  return token.value
}

/** Submit credentials — fires a `login` message; the result arrives via `handleLoginResult`. */
function submitLogin(username: string, password: string): void {
  loginError.value = null
  pending.value = true
  send?.({ type: 'login', request: { username, password } })
}

/** Server reply to a `login` attempt. */
function handleLoginResult(result: AuthLoginResult): void {
  pending.value = false
  if (result.ok) {
    token.value = result.token
    setToken(result.token)
    loginError.value = null
    lastReason.value = null
    status.value = 'authenticated'
  } else {
    loginError.value = result.code
  }
}

/** Server signalled the connection is unauthenticated (the WS analogue of HTTP 401). */
function handleUnauthenticated(reason: UnauthenticatedReason): void {
  token.value = null
  clearToken()
  lastReason.value = reason
  pending.value = false
  status.value = 'login-required'
}

/** User-initiated logout — revoke server-side, drop the local session, show the gate. */
function logout(): void {
  send?.({ type: 'logout' })
  token.value = null
  clearToken()
  loginError.value = null
  lastReason.value = null
  status.value = 'login-required'
}

export function useAuth() {
  return {
    status: readonly(status),
    loginError: readonly(loginError),
    pending: readonly(pending),
    lastReason: readonly(lastReason),
    bindSender,
    currentToken,
    submitLogin,
    handleLoginResult,
    handleUnauthenticated,
    logout,
  }
}
