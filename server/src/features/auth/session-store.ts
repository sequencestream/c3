/**
 * In-process session-token store (ADR-0023, handshake-enforcement slice).
 *
 * `login` mints an OPAQUE random token and remembers it here so the WS handshake
 * can verify the `?token=` a (re)connecting client presents. There is NO
 * persistent store (ADR-0006: process-wide Map, no database) — sessions live
 * only in this process, so a server restart invalidates every session and the
 * client is re-prompted on its next reconnect (the token it re-presents no
 * longer verifies). Stateless token SIGNING (an HMAC keyed by
 * `AuthSessionPolicy.signingKeyRef`) remains deferred (ADR-0023); this stateful
 * store is the minimal mechanism that makes handshake enforcement real today.
 */
import { randomBytes } from 'node:crypto'
import type { AuthSessionToken } from '@ccc/shared/protocol'

/** Why a presented token failed to verify — mirrors `unauthenticated.reason`. */
export type SessionFailureReason = 'missing' | 'expired' | 'invalid'

/** `verifySession` outcome: the authenticated subject, or a structured reason. */
export type SessionVerifyResult =
  { ok: true; subject: string } | { ok: false; reason: SessionFailureReason }

// tokenId → issued token record. Module singleton: one store per server process.
const sessions = new Map<string, AuthSessionToken>()

/** Mint + remember a session for `subject`, expiring `ttlSeconds` from now. */
export function mintSession(
  subject: string,
  ttlSeconds: number,
): { token: string; expiresAt: number } {
  const tokenId = randomBytes(24).toString('hex')
  const issuedAt = Date.now()
  const expiresAt = issuedAt + ttlSeconds * 1000
  sessions.set(tokenId, { tokenId, subject, issuedAt, expiresAt })
  return { token: tokenId, expiresAt }
}

/** Verify a presented token. Lazily evicts an expired entry on read. */
export function verifySession(token: string | null | undefined): SessionVerifyResult {
  if (!token) return { ok: false, reason: 'missing' }
  const rec = sessions.get(token)
  if (!rec) return { ok: false, reason: 'invalid' }
  if (rec.expiresAt <= Date.now()) {
    sessions.delete(token)
    return { ok: false, reason: 'expired' }
  }
  return { ok: true, subject: rec.subject }
}

/** Revoke a session (logout). No-op when the token is unknown/null. */
export function revokeSession(token: string | null | undefined): void {
  if (token) sessions.delete(token)
}

/** Test/maintenance hook: drop every session. */
export function clearAllSessions(): void {
  sessions.clear()
}
