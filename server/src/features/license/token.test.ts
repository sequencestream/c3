import { describe, expect, it } from 'vitest'
import { verifyEntitlementToken } from './token.js'

// A real entitlement token signed by the license-server Go signer with the dev
// seed whose public key is embedded in c3 (license-pubkey.ts). Pinning a
// cross-language fixture proves the Go signer and the TS verifier agree on the
// wire format — they cannot drift without this test failing. Regenerate with
// `go run ./scripts/gen-keypair` + the token package if the dev key rotates.
const GO_SIGNED_TOKEN =
  'v1.eyJpbnN0YWxsYXRpb25JZCI6Imluc3QtZml4dHVyZSIsImxpY2Vuc2VJZCI6IjciLCJwbGFuIjoidHJpYWwtMW0iLCJzdGF0dXMiOiJhY3RpdmUiLCJ0ZXJtU3RhcnQiOjE3MDAwMDAwMDAsInRlcm1FbmQiOjE3MDI1OTIwMDAsImlzc3VlZEF0IjoxNzAwMDAwMDAwLCJraWQiOiIxMGRiMGQyMjFjMTI1NzNjIn0.cNsvjU1NoYycw5ENEzCrjXtc5BH_IgQa9AfZhxfJj04pKo559NwfLT8pquQF2sp3G-Lim6hsrsRmg8m-jJGhBQ'

// Within the fixture's validity window [1700000000, 1702592000).
const WITHIN = 1_700_500_000

describe('verifyEntitlementToken', () => {
  it('verifies a genuine Go-signed token within its window (PL-R5 interop)', () => {
    const res = verifyEntitlementToken(GO_SIGNED_TOKEN, WITHIN)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.payload.installationId).toBe('inst-fixture')
      expect(res.payload.plan).toBe('trial-1m')
      expect(res.payload.status).toBe('active')
      expect(res.payload.kid).toBe('10db0d221c12573c')
    }
  })

  it('rejects a token outside its validity window (deny-by-default)', () => {
    expect(verifyEntitlementToken(GO_SIGNED_TOKEN, 1_702_592_001).ok).toBe(false) // after end
    expect(verifyEntitlementToken(GO_SIGNED_TOKEN, 1_699_999_999).ok).toBe(false) // before start
  })

  it('rejects a tampered payload (signature fails)', () => {
    const [v, , sig] = GO_SIGNED_TOKEN.split('.')
    const forged = Buffer.from(
      JSON.stringify({
        installationId: 'attacker',
        plan: 'trial-1m',
        status: 'active',
        termStart: 0,
        termEnd: 9_999_999_999,
        kid: '10db0d221c12573c',
      }),
    ).toString('base64url')
    const res = verifyEntitlementToken(`${v}.${forged}.${sig}`, WITHIN)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('signature')
  })

  it('rejects a token signed by a different key (wrong embedded pubkey)', () => {
    // A valid-looking but unrelated public key must not verify the token.
    const otherPubB64 = Buffer.alloc(32, 7).toString('base64')
    expect(verifyEntitlementToken(GO_SIGNED_TOKEN, WITHIN, otherPubB64).ok).toBe(false)
  })

  it('rejects malformed/empty/wrong-version tokens', () => {
    for (const bad of ['', 'v1', 'v1.abc', 'v2.abc.def', 'a.b.c.d', 'not-a-token']) {
      expect(verifyEntitlementToken(bad, WITHIN).ok).toBe(false)
    }
  })
})
