// Embedded license-server (LS) Ed25519 PUBLIC key — the offline trust anchor for
// product entitlement (ADR-0026, PL-R5). c3 verifies every entitlement token
// against THIS key, offline, before honoring `active`; a token that does not
// verify is treated as not entitled (deny-by-default).
//
// Only the PUBLIC key ships in c3 (PL-R12). The matching private seed lives
// exclusively in LS (C3_LS_ED25519_PRIVATE_KEY) and never in this binary, the
// entitlement cache, or any c3 config. This mirrors the release-signing key
// discipline (server/src/release-pubkey.ts, ADR-0010).
//
// To rotate: regenerate with `go run ./scripts/gen-keypair` in license-server/,
// put the new seed in LS, and replace BOTH constants below. The key id is the
// first 16 hex chars of SHA-256 over the raw public key and is carried in every
// token payload so a token signed by an unknown key is rejected.

/** Raw 32-byte Ed25519 public key, standard base64. Dev key — replace for prod. */
export const C3_LICENSE_PUBLIC_KEY = 'b+QPibImJMu5uUF8ZyQ9sfZRymlaZGVkkHHZi9kRSDY='

/** Short key id (sha256(pub)[:16] hex) the signer stamps into each token. */
export const C3_LICENSE_KEY_ID = '8871ffe757ade2d0'
