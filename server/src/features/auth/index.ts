/**
 * `auth` feature handlers — contract-only (ADR-0023).
 *
 * The wire messages `login` / `logout` are part of the EXHAUSTIVE `HandlerMap`
 * (ADR-0009), so they need handlers to compile. This phase ships NO auth runtime
 * — no credential verification, no token signing, no middleware. These handlers
 * are deliberately minimal plumbing that reflects the "auth disabled" default:
 *
 * - `login` always replies `login_result { ok: false, code: 'auth_disabled' }`.
 * - `logout` is a no-op (no session tokens are issued yet, so nothing to clear).
 *
 * The real verification/token lifecycle lands in a later task (see the auth
 * domain spec roadmap); replace these stubs then.
 */
import type { Handler } from '../../transport/handler-registry.js'

export const login: Handler<'login'> = (_ctx, conn) => {
  conn.send({ type: 'login_result', result: { ok: false, code: 'auth_disabled' } })
}

export const logout: Handler<'logout'> = () => {
  // Contract-only: no session token is ever issued yet, so there is nothing to
  // invalidate. The real implementation (token revocation) arrives with the
  // auth runtime task.
}
