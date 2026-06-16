/**
 * Password hashing for the `basic` auth provider (ADR-0023, runtime slice).
 *
 * Dependency-free by design: built on `node:crypto.scrypt` so it survives
 * `bun build --compile` (no native addon) and adds no supply-chain surface. The
 * stored form is a self-describing PHC-style string — algorithm + params + salt
 * + digest in one field — so {@link verifyPassword} needs nothing but the hash:
 *
 *   $scrypt$ln=15,r=8,p=1$<saltB64>$<digestB64>
 *
 * Plaintext is NEVER persisted (AUTH-R3): only this string lands in a basic
 * account's `passwordHash`. Verification is constant-time (`timingSafeEqual`).
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** scrypt cost params. `ln` is log2(N); N=2^15 keeps a single hash well under ~100ms. */
const SCRYPT_LN = 15
const SCRYPT_R = 8
const SCRYPT_P = 1
const KEY_LEN = 32
const SALT_LEN = 16
/** scrypt's internal memory bound must exceed 128*N*r; raise maxmem so N=2^15 fits. */
const MAXMEM = 64 * 1024 * 1024

function derive(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, KEY_LEN, {
    N: 2 ** SCRYPT_LN,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAXMEM,
  })
}

/**
 * Hash a plaintext password into a PHC-style `$scrypt$…` string. A fresh random
 * salt is generated per call, so the same password hashes differently each time.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LEN)
  const digest = derive(password, salt)
  const params = `ln=${SCRYPT_LN},r=${SCRYPT_R},p=${SCRYPT_P}`
  return `$scrypt$${params}$${salt.toString('base64')}$${digest.toString('base64')}`
}

/**
 * Verify a plaintext password against a stored PHC `$scrypt$…` string. Returns
 * `false` (never throws) on any malformed/unknown hash so a corrupt settings
 * file can't crash a login. Comparison is constant-time.
 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split('$')
    // ['', 'scrypt', 'ln=..,r=..,p=..', '<saltB64>', '<digestB64>']
    if (parts.length !== 5 || parts[1] !== 'scrypt') return false
    const params = Object.fromEntries(
      parts[2].split(',').map((kv) => {
        const [k, v] = kv.split('=')
        return [k, Number(v)]
      }),
    ) as { ln: number; r: number; p: number }
    const salt = Buffer.from(parts[3], 'base64')
    const expected = Buffer.from(parts[4], 'base64')
    const actual = scryptSync(password, salt, expected.length, {
      N: 2 ** params.ln,
      r: params.r,
      p: params.p,
      maxmem: MAXMEM,
    })
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}
