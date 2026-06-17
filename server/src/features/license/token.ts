// Offline verification of the LS-signed entitlement token (product-license
// PL-R5). Trust comes from the Ed25519 signature checked against the embedded
// public key — never from the network. A missing, malformed, expired, or
// unverifiable token is treated as **not entitled** (deny-by-default): callers
// gate new-session creation, never interrupt running work.
//
// Wire format (the Go twin is license-server/internal/token):
//
//   v1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>
//
// The signature covers the exact bytes "v1.<payloadB64>", so the verifier checks
// the token's own bytes and never needs a canonical JSON encoder to agree with
// the signer. Reuses the same raw-Ed25519 KeyObject construction as `c3 verify`
// (server/src/verify.ts).
import { createHash, createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto'
import { C3_LICENSE_PUBLIC_KEY } from '../../license-pubkey.js'

/** Token format version this module mints-against and accepts. */
export const ENTITLEMENT_TOKEN_VERSION = 'v1'

/** SPKI DER prefix for an Ed25519 public key; + raw(32) → 44-byte SPKI. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** The entitlement assertion carried by a verified token (times are unix secs). */
export interface EntitlementPayload {
  installationId: string
  licenseId: string
  status: string
  termStart: number
  termEnd: number
  issuedAt: number
  kid: string
}

export type VerifyTokenResult =
  | { ok: true; payload: EntitlementPayload }
  | { ok: false; reason: string }

function publicKeyObject(raw32: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw32]), format: 'der', type: 'spki' })
}

/** Short key id (sha256(pub)[:16] hex) — must match the token payload's `kid`. */
function keyIdFor(raw32: Buffer): string {
  return createHash('sha256').update(raw32).digest('hex').slice(0, 16)
}

function isPayload(v: unknown): v is EntitlementPayload {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  return (
    typeof p.installationId === 'string' &&
    typeof p.status === 'string' &&
    typeof p.termStart === 'number' &&
    typeof p.termEnd === 'number' &&
    typeof p.kid === 'string'
  )
}

/**
 * Verify an entitlement token offline against the embedded LS public key and
 * confirm `now` is within its validity window. Deny-by-default: any failure
 * returns `{ ok: false }` with a reason and never a payload.
 *
 * @param token      the `v1.<payload>.<sig>` string from activation/heartbeat
 * @param nowSeconds current time in unix seconds (injectable for tests)
 * @param publicKeyB64 raw-32 Ed25519 public key (defaults to the embedded key)
 */
export function verifyEntitlementToken(
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  publicKeyB64: string = C3_LICENSE_PUBLIC_KEY,
): VerifyTokenResult {
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, reason: 'empty token' }
  }
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== ENTITLEMENT_TOKEN_VERSION) {
    return { ok: false, reason: 'malformed token' }
  }
  const [version, payloadB64, sigB64] = parts

  let rawPub: Buffer
  try {
    rawPub = Buffer.from(publicKeyB64, 'base64')
    if (rawPub.length !== 32) return { ok: false, reason: 'bad public key length' }
  } catch {
    return { ok: false, reason: 'bad public key' }
  }

  let pubObj: KeyObject
  try {
    pubObj = publicKeyObject(rawPub)
  } catch (e) {
    return { ok: false, reason: `public key: ${(e as Error).message}` }
  }

  const signingInput = Buffer.from(`${version}.${payloadB64}`)
  let sig: Buffer
  try {
    sig = Buffer.from(sigB64, 'base64url')
  } catch {
    return { ok: false, reason: 'bad signature encoding' }
  }
  if (!edVerify(null, signingInput, pubObj, sig)) {
    return { ok: false, reason: 'signature does not verify' }
  }

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'))
  } catch {
    return { ok: false, reason: 'unparseable payload' }
  }
  if (!isPayload(payload)) {
    return { ok: false, reason: 'incomplete payload' }
  }
  if (payload.kid !== keyIdFor(rawPub)) {
    return { ok: false, reason: 'key id mismatch' }
  }
  if (nowSeconds < payload.termStart || nowSeconds >= payload.termEnd) {
    return { ok: false, reason: 'outside validity window' }
  }
  return { ok: true, payload }
}
