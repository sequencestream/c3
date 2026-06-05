// `c3 verify <file>` — offline distribution-trust check (release 3/7).
//
// Self-verification baked into the binary: checks a downloaded artifact against the
// EMBEDDED minisign public key (server/src/release-pubkey.ts) using only node:crypto
// (Ed25519 + BLAKE2b-512) — no network, no external `minisign` binary. This is the TS
// twin of the Node-side signer scripts/release/minisign.mjs (verify half); the two share a
// format and are cross-checked by tests so they cannot drift.
//
// Trust model: the .minisig (Ed25519 over the artifact) is the authority. The sibling
// .sha256 is an optional, human-friendly cross-check; signature verification is mandatory.
import { createHash, createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { C3_MINISIGN_PUBLIC_KEY } from './release-pubkey.js'

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex') // + pub(32) → 44 B
const ALG_PREHASH = 'ED' // signs blake2b512(content); 'Ed' = legacy (signs content)

function publicKeyObject(raw32: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw32]), format: 'der', type: 'spki' })
}

function parsePublicKey(text: string) {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const buf = Buffer.from(lines[lines.length - 1].trim(), 'base64')
  if (buf.length !== 42) throw new Error(`bad public key length ${buf.length}`)
  return { keyId: buf.subarray(2, 10), publicKeyRaw: buf.subarray(10, 42) }
}

function parseSignature(text: string) {
  const lines = text.split('\n')
  const sigBuf = Buffer.from((lines[1] ?? '').trim(), 'base64')
  const globalBuf = Buffer.from((lines[3] ?? '').trim(), 'base64')
  if (sigBuf.length !== 74) throw new Error(`bad signature length ${sigBuf.length}`)
  return {
    algorithm: sigBuf.subarray(0, 2).toString('ascii'),
    keyId: sigBuf.subarray(2, 10),
    signature: sigBuf.subarray(10, 74),
    trustedComment: (lines[2] ?? '').replace(/^trusted comment:\s?/, ''),
    globalSignature: globalBuf,
  }
}

function signedMessage(content: Buffer, algorithm: string): Buffer {
  return algorithm === ALG_PREHASH ? createHash('blake2b512').update(content).digest() : content
}

export interface VerifyResult {
  ok: boolean
  reason?: string
  sha256?: string
  sha256Checked: boolean
  signatureChecked: boolean
  trustedComment?: string
}

/**
 * Verify artifact `content` against its `.minisig` and (optionally) `.sha256` sidecars.
 * The signature is mandatory; sha256Line, when given, is an extra cross-check.
 */
export function verifyArtifact(opts: {
  content: Buffer
  sigText?: string
  sha256Line?: string
  publicKeyText: string
}): VerifyResult {
  const { content, sigText, sha256Line, publicKeyText } = opts
  const sha256 = createHash('sha256').update(content).digest('hex')

  // 1) optional sha256 cross-check
  let sha256Checked = false
  if (sha256Line != null && sha256Line.trim() !== '') {
    const expected = sha256Line.trim().split(/\s+/)[0]?.toLowerCase()
    if (expected !== sha256) {
      return {
        ok: false,
        reason: `sha256 mismatch (have ${sha256}, expected ${expected})`,
        sha256,
        sha256Checked: true,
        signatureChecked: false,
      }
    }
    sha256Checked = true
  }

  // 2) mandatory minisign signature
  if (!sigText) {
    return {
      ok: false,
      reason: 'no .minisig signature found',
      sha256,
      sha256Checked,
      signatureChecked: false,
    }
  }
  let pub, sig
  try {
    pub = parsePublicKey(publicKeyText)
  } catch (e) {
    return {
      ok: false,
      reason: `public key: ${(e as Error).message}`,
      sha256,
      sha256Checked,
      signatureChecked: false,
    }
  }
  try {
    sig = parseSignature(sigText)
  } catch (e) {
    return {
      ok: false,
      reason: `signature: ${(e as Error).message}`,
      sha256,
      sha256Checked,
      signatureChecked: false,
    }
  }
  if (!pub.keyId.equals(sig.keyId)) {
    return {
      ok: false,
      reason: `key id mismatch (sig ${sig.keyId.toString('hex')} ≠ embedded ${pub.keyId.toString('hex')})`,
      sha256,
      sha256Checked,
      signatureChecked: false,
    }
  }
  const pubObj = publicKeyObject(pub.publicKeyRaw)
  if (!edVerify(null, signedMessage(content, sig.algorithm), pubObj, sig.signature)) {
    return {
      ok: false,
      reason: 'content signature does not verify',
      sha256,
      sha256Checked,
      signatureChecked: true,
    }
  }
  const globalMsg = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf-8')])
  if (!edVerify(null, globalMsg, pubObj, sig.globalSignature)) {
    return {
      ok: false,
      reason: 'trusted-comment signature does not verify',
      sha256,
      sha256Checked,
      signatureChecked: true,
    }
  }
  return {
    ok: true,
    sha256,
    sha256Checked,
    signatureChecked: true,
    trustedComment: sig.trustedComment,
  }
}

/**
 * `c3 verify <file>`: reads `<file>`, its sibling `<file>.minisig` and `<file>.sha256`,
 * verifies against the embedded public key, prints a verdict, and returns an exit code.
 */
export function runVerify(
  filePath: string,
  publicKeyText: string = C3_MINISIGN_PUBLIC_KEY,
): number {
  if (!existsSync(filePath)) {
    console.error(`[c3 verify] file not found: ${filePath}`)
    return 1
  }
  const sigPath = `${filePath}.minisig`
  const sha256Path = `${filePath}.sha256`
  const result = verifyArtifact({
    content: readFileSync(filePath),
    sigText: existsSync(sigPath) ? readFileSync(sigPath, 'utf-8') : undefined,
    sha256Line: existsSync(sha256Path) ? readFileSync(sha256Path, 'utf-8') : undefined,
    publicKeyText,
  })

  const name = basename(filePath)
  if (result.ok) {
    console.log(`✓ VERIFIED  ${name}`)
    console.log(
      `  sha256     ${result.sha256}${result.sha256Checked ? '  (matches .sha256)' : '  (no .sha256 sidecar)'}`,
    )
    console.log(`  signature  OK${result.trustedComment ? `  — ${result.trustedComment}` : ''}`)
    return 0
  }
  console.error(`✗ FAILED    ${name}`)
  console.error(`  reason     ${result.reason}`)
  if (!existsSync(sigPath))
    console.error(`  hint       expected signature sidecar: ${basename(sigPath)}`)
  return 1
}
