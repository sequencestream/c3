// Minimal type declarations for the JS module minisign.mjs. Only the exports
// consumed by TypeScript callers (server upgrade test fixtures) are typed.
export interface KeyPair {
  keyId: Buffer
  seed: Buffer
  publicKeyRaw: Buffer
  publicKeyText: string
  secretKeyB64: string
}

export function generateKeypair(opts?: { comment?: string }): KeyPair

export function signContent(
  content: Buffer,
  opts: { seed: Buffer; keyId: Buffer; trustedComment: string; untrustedComment: string },
): string
