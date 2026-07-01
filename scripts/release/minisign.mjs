// minisign crypto core (release 3/7) — distribution-trust signing/verification.
//
// Pure Node (node:crypto Ed25519 + BLAKE2b-512), NO third-party deps. Produces and
// verifies STANDARD minisign-format artifacts, so the official `minisign` CLI can verify
// our signatures and vice-versa. We hold the secret key as a raw seed (GH Secret / offline
// file), not minisign's password-encrypted .key format — only the .pub and .minisig the
// world sees are standard. The binary's `c3 verify` reimplements the *verify* half in TS
// (server/src/verify.ts); this module is the Node-side signer + the test oracle.
//
// File formats (https://jedisct1.github.io/minisign/):
//   public key  : line2 = base64( "Ed"(2) || keyId(8) || ed25519_pub(32) )            = 42 B
//   signature   : line2 = base64( alg(2) || keyId(8) || ed25519_sig(64) )             = 74 B
//                 alg = "Ed" (legacy, signs content) | "ED" (prehashed, signs blake2b512)
//                 line4 = base64( ed25519_globalSig(64) ) over ( sig(64) || trustedComment )
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  randomBytes,
} from 'node:crypto'

// DER wrappers for raw 32-byte Ed25519 keys (prefixes verified against node's own export).
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex') // + pub(32)  → 44 B
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex') // + seed(32) → 48 B

const ALG_LEGACY = 'Ed' // signs raw content
const ALG_PREHASH = 'ED' // signs blake2b512(content)

function publicKeyObject(raw32) {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw32]), format: 'der', type: 'spki' })
}
function privateKeyObject(seed32) {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed32]),
    format: 'der',
    type: 'pkcs8',
  })
}

/** Generate a fresh keypair. secretBlob = keyId(8) || seed(32), held offline / as GH Secret. */
export function generateKeypair({ comment = 'c3 minisign key' } = {}) {
  const keyId = randomBytes(8)
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, randomBytes(32)]),
    format: 'der',
    type: 'pkcs8',
  })
  // Re-derive a proper keypair from node (the random seed above is a valid Ed25519 seed,
  // but read the canonical seed/pub back out so callers get matched bytes).
  const seed = priv.export({ type: 'pkcs8', format: 'der' }).subarray(PKCS8_PREFIX.length)
  const publicKeyRaw = createPublicKey(priv)
    .export({ type: 'spki', format: 'der' })
    .subarray(SPKI_PREFIX.length)
  const publicKeyText = formatPublicKey({ keyId, publicKeyRaw, comment })
  const secretBlob = Buffer.concat([keyId, seed])
  return {
    keyId,
    seed,
    publicKeyRaw,
    publicKeyText,
    secretKeyB64: secretBlob.toString('base64'),
  }
}

/** Parse `secretKeyB64` (base64 of keyId(8)||seed(32)) → { keyId, seed }. */
export function parseSecretBlob(b64) {
  const buf = Buffer.from(String(b64).trim(), 'base64')
  if (buf.length !== 40) throw new Error(`bad secret blob length ${buf.length}, expected 40`)
  return { keyId: buf.subarray(0, 8), seed: buf.subarray(8, 40) }
}

export function formatPublicKey({ keyId, publicKeyRaw, comment = 'c3 minisign public key' }) {
  const body = Buffer.concat([Buffer.from(ALG_LEGACY, 'ascii'), keyId, publicKeyRaw])
  return `untrusted comment: ${comment}\n${body.toString('base64')}\n`
}

/** Derive the standard minisign PUBLIC key (`.pub` text) from a secret blob (keyId||seed), so a
 *  signer can emit a shippable `minisign.pub` that provably matches the key it just signed with. */
export function publicKeyTextFromSecret(
  secretKeyB64,
  comment = 'c3 release signing key (minisign)',
) {
  const { keyId, seed } = parseSecretBlob(secretKeyB64)
  const publicKeyRaw = createPublicKey(privateKeyObject(seed))
    .export({ type: 'spki', format: 'der' })
    .subarray(SPKI_PREFIX.length)
  return { keyId, publicKeyRaw, text: formatPublicKey({ keyId, publicKeyRaw, comment }) }
}

export function parsePublicKey(text) {
  const lines = String(text)
    .split('\n')
    .filter((l) => l.trim() !== '')
  const b64 = lines[lines.length - 1].trim()
  const buf = Buffer.from(b64, 'base64')
  if (buf.length !== 42) throw new Error(`bad public key length ${buf.length}, expected 42`)
  return {
    algorithm: buf.subarray(0, 2).toString('ascii'),
    keyId: buf.subarray(2, 10),
    publicKeyRaw: buf.subarray(10, 42),
  }
}

export function parseSignature(text) {
  const lines = String(text).split('\n')
  const sigLine = lines[1]?.trim()
  const trustedLine = lines[2] ?? ''
  const globalLine = lines[3]?.trim()
  if (!sigLine || !globalLine) throw new Error('malformed .minisig: expected 4 lines')
  const sigBuf = Buffer.from(sigLine, 'base64')
  if (sigBuf.length !== 74) throw new Error(`bad signature length ${sigBuf.length}, expected 74`)
  const trustedComment = trustedLine.replace(/^trusted comment:\s?/, '')
  return {
    algorithm: sigBuf.subarray(0, 2).toString('ascii'),
    keyId: sigBuf.subarray(2, 10),
    signature: sigBuf.subarray(10, 74),
    trustedComment,
    globalSignature: Buffer.from(globalLine, 'base64'),
  }
}

/** Message that gets Ed25519-signed, per algorithm. */
function signedMessage(content, algorithm) {
  return algorithm === ALG_PREHASH ? createHash('blake2b512').update(content).digest() : content
}

/**
 * Sign `content` (Buffer) → standard .minisig text. Prehashed (`ED`) by default so large
 * binaries hash once; the official `minisign -V` auto-detects the algorithm.
 */
export function signContent(
  content,
  { seed, keyId, trustedComment = '', untrustedComment = 'signed by c3', prehash = true } = {},
) {
  const algorithm = prehash ? ALG_PREHASH : ALG_LEGACY
  const priv = privateKeyObject(seed)
  const signature = sign(null, signedMessage(content, algorithm), priv)
  const sigBlob = Buffer.concat([Buffer.from(algorithm, 'ascii'), keyId, signature])
  const globalSig = sign(
    null,
    Buffer.concat([signature, Buffer.from(trustedComment, 'utf-8')]),
    priv,
  )
  return (
    `untrusted comment: ${untrustedComment}\n` +
    `${sigBlob.toString('base64')}\n` +
    `trusted comment: ${trustedComment}\n` +
    `${globalSig.toString('base64')}\n`
  )
}

/**
 * Verify `content` against a .minisig text and a public-key text.
 * @returns {{ ok: boolean, reason?: string, trustedComment?: string }}
 */
export function verifyContent(content, sigText, pubKeyText) {
  let pub, sig
  try {
    pub = parsePublicKey(pubKeyText)
  } catch (e) {
    return { ok: false, reason: `public key: ${e.message}` }
  }
  try {
    sig = parseSignature(sigText)
  } catch (e) {
    return { ok: false, reason: `signature: ${e.message}` }
  }
  if (!pub.keyId.equals(sig.keyId)) {
    return {
      ok: false,
      reason: `key id mismatch (sig ${sig.keyId.toString('hex')} ≠ key ${pub.keyId.toString('hex')})`,
    }
  }
  const pubObj = publicKeyObject(pub.publicKeyRaw)
  const message = signedMessage(content, sig.algorithm)
  if (!verify(null, message, pubObj, sig.signature)) {
    return { ok: false, reason: 'content signature does not verify' }
  }
  const globalMsg = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf-8')])
  if (!verify(null, globalMsg, pubObj, sig.globalSignature)) {
    return { ok: false, reason: 'trusted-comment (global) signature does not verify' }
  }
  return { ok: true, trustedComment: sig.trustedComment }
}
