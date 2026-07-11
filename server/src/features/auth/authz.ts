/**
 * Request-level authorization — the admin gate (ADR-0023 authz slice).
 *
 * "Only the administrator may change system configuration." The account roster
 * already records exactly one admin (`basic.adminUsername`, see the unique-admin
 * config layer); this module turns that config-layer fact into a RUNTIME gate the
 * config-mutating handlers consult.
 *
 * Provider-neutral by construction (the same neutral-abstraction shape as the
 * vendor model): `isAdminConn` resolves the active provider's admin identity and
 * compares it to the connection's authenticated subject. The gate is INERT — every
 * local connection is trusted — whenever no admin can apply:
 *  - auth disabled / absent, or `kind: 'none'`  → loopback bootstrap-trust (AUTH-R2);
 *  - an unconfigured `basic` shell (`adminUsername === ''`) → the bootstrap window
 *    where the first admin is still being created (mirrors `set_admin_password`).
 *
 * The gate is never the sole defense — it composes with the handshake/dispatch
 * auth gate (an unauthenticated connection cannot reach these handlers at all).
 */
import type { AuthConfig } from '@ccc/shared/protocol'
import type { Conn } from '../../transport/handler-registry.js'
import { loadSettings } from '../../kernel/config/index.js'

/**
 * The configured admin identity for an auth block, or `null` when no admin gate
 * applies (auth disabled/absent, `kind: 'none'`, or an unconfigured `basic` shell
 * whose admin field is still empty). Pure over its argument (no I/O) so it is
 * trivially unit-testable across every provider arm.
 */
export function configuredAdmin(auth: AuthConfig | undefined): string | null {
  if (!auth || !auth.enabled) return null
  const provider = auth.provider
  if (provider.kind === 'basic') return provider.adminUsername || null
  return null // 'none' — no admin concept
}

/**
 * Whether `conn` is authorized to mutate system configuration: it is the unique
 * admin under the active provider, OR no admin gate applies (see module doc).
 * `null` configured-admin ⇒ inert gate ⇒ trusted; otherwise the connection's
 * authenticated subject must equal the configured admin exactly.
 */
export function isAdminConn(conn: Conn): boolean {
  const auth = loadSettings().auth
  const admin = configuredAdmin(auth)
  if (admin === null) return true // no admin gate applies ⇒ trusted
  return conn.subject !== null && conn.subject === admin
}

/**
 * Guard for a config-mutating handler: returns `true` and lets the caller proceed
 * when authorized; otherwise emits the `auth.adminOnly` error frame on `conn` and
 * returns `false` so the caller can `if (!requireAdmin(conn)) return`.
 */
export function requireAdmin(conn: Conn): boolean {
  if (isAdminConn(conn)) return true
  conn.send({ type: 'error', error: { code: 'auth.adminOnly' } })
  return false
}
