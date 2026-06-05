// Tests for release 3/7 — distribution-trust signing.
// Proves: (1) minisign sign/verify roundtrip (prehash + legacy), tamper-detects;
// (2) signArtifacts writes consistent .sha256/SHA256SUMS/.minisig (and skips .minisig
// without a key); (3) release:publish --dry-run plans without external side effects
// (no git tag, no gh).
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateKeypair, parseSecretBlob, signContent, verifyContent } from './minisign.mjs'
import { signArtifacts } from './sign.mjs'
// Cross-runtime twin: the binary's TS verifier. vitest transforms the .ts at runtime, so a
// .mjs test can import it and prove the Node signer + TS verifier agree on the format.
import { verifyArtifact, runVerify } from '../../server/src/verify.ts'
import { C3_MINISIGN_PUBLIC_KEY } from '../../server/src/release-pubkey.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

function signWith(content, kp, trustedComment = 'tc', prehash = true) {
  const { keyId, seed } = parseSecretBlob(kp.secretKeyB64)
  return signContent(content, { seed, keyId, trustedComment, prehash })
}

describe('minisign roundtrip', () => {
  const kp = generateKeypair({ comment: 'test' })
  const { keyId, seed } = parseSecretBlob(kp.secretKeyB64)
  const content = Buffer.from('artifact bytes '.repeat(500))

  it('verifies a prehashed (ED) signature', () => {
    const sig = signContent(content, { seed, keyId, trustedComment: 'tc', prehash: true })
    const r = verifyContent(content, sig, kp.publicKeyText)
    expect(r.ok).toBe(true)
    expect(r.trustedComment).toBe('tc')
  })

  it('verifies a legacy (Ed) signature', () => {
    const sig = signContent(content, { seed, keyId, trustedComment: 'tc', prehash: false })
    expect(verifyContent(content, sig, kp.publicKeyText).ok).toBe(true)
  })

  it('fails on tampered content', () => {
    const sig = signContent(content, { seed, keyId })
    expect(
      verifyContent(Buffer.concat([content, Buffer.from('x')]), sig, kp.publicKeyText).ok,
    ).toBe(false)
  })

  it('fails against a different public key', () => {
    const sig = signContent(content, { seed, keyId })
    const other = generateKeypair()
    const r = verifyContent(content, sig, other.publicKeyText)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/key id mismatch/)
  })

  it('fails on a tampered trusted comment', () => {
    const sig = signContent(content, { seed, keyId, trustedComment: 'real' })
    const forged = sig.replace('trusted comment: real', 'trusted comment: forged')
    expect(verifyContent(content, forged, kp.publicKeyText).ok).toBe(false)
  })
})

describe('signArtifacts', () => {
  function fixture() {
    const dir = mkdtempSync(resolve(tmpdir(), 'c3-sign-'))
    const a = { name: 'c3-v9.9.9-test-x64', path: resolve(dir, 'c3-v9.9.9-test-x64') }
    writeFileSync(a.path, Buffer.from('fake binary payload ' + 'z'.repeat(1000)))
    return { dir, a }
  }

  it('writes .sha256 + SHA256SUMS that match an independent digest, and a verifiable .minisig', () => {
    const { dir, a } = fixture()
    const kp = generateKeypair()
    try {
      const res = signArtifacts({
        artifacts: [a],
        outDir: dir,
        version: '9.9.9',
        secretKeyB64: kp.secretKeyB64,
      })
      expect(res.signed).toBe(true)

      const expectedHex = createHash('sha256').update(readFileSync(a.path)).digest('hex')
      const sha256Line = readFileSync(`${a.path}.sha256`, 'utf-8').trim()
      expect(sha256Line).toBe(`${expectedHex}  ${a.name}`)
      expect(readFileSync(resolve(dir, 'SHA256SUMS'), 'utf-8')).toBe(`${expectedHex}  ${a.name}\n`)

      const sig = readFileSync(`${a.path}.minisig`, 'utf-8')
      expect(verifyContent(readFileSync(a.path), sig, kp.publicKeyText).ok).toBe(true)

      // SHA256SUMS itself is signed.
      const sumsSig = readFileSync(resolve(dir, 'SHA256SUMS.minisig'), 'utf-8')
      expect(
        verifyContent(readFileSync(resolve(dir, 'SHA256SUMS')), sumsSig, kp.publicKeyText).ok,
      ).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('without a key, writes sha256 but skips .minisig', () => {
    const { dir, a } = fixture()
    try {
      const res = signArtifacts({ artifacts: [a], outDir: dir, version: '9.9.9' })
      expect(res.signed).toBe(false)
      expect(existsSync(`${a.path}.sha256`)).toBe(true)
      expect(existsSync(resolve(dir, 'SHA256SUMS'))).toBe(true)
      expect(existsSync(`${a.path}.minisig`)).toBe(false)
      expect(existsSync(resolve(dir, 'SHA256SUMS.minisig'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('c3 verify — TS verifier accepts the Node signer output (cross-runtime)', () => {
  const content = Buffer.from('c3 binary content '.repeat(300))

  it('accepts a genuine signature + matching sha256', () => {
    const kp = generateKeypair()
    const sha256 = createHash('sha256').update(content).digest('hex')
    const r = verifyArtifact({
      content,
      sigText: signWith(content, kp),
      sha256Line: `${sha256}  art`,
      publicKeyText: kp.publicKeyText,
    })
    expect(r.ok).toBe(true)
    expect(r.signatureChecked).toBe(true)
    expect(r.sha256Checked).toBe(true)
  })

  it('accepts a legacy (non-prehashed) signature', () => {
    const kp = generateKeypair()
    expect(
      verifyArtifact({
        content,
        sigText: signWith(content, kp, 'tc', false),
        publicKeyText: kp.publicKeyText,
      }).ok,
    ).toBe(true)
  })

  it('rejects tampered content', () => {
    const kp = generateKeypair()
    const r = verifyArtifact({
      content: Buffer.concat([content, Buffer.from('!')]),
      sigText: signWith(content, kp),
      publicKeyText: kp.publicKeyText,
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/signature does not verify/)
  })

  it('rejects a key-id mismatch', () => {
    const kp = generateKeypair()
    const r = verifyArtifact({
      content,
      sigText: signWith(content, kp),
      publicKeyText: generateKeypair().publicKeyText,
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/key id mismatch/)
  })

  it('rejects a sha256 mismatch and a missing signature', () => {
    const kp = generateKeypair()
    expect(
      verifyArtifact({
        content,
        sigText: signWith(content, kp),
        sha256Line: 'deadbeef  art',
        publicKeyText: kp.publicKeyText,
      }).reason,
    ).toMatch(/sha256 mismatch/)
    expect(verifyArtifact({ content, publicKeyText: kp.publicKeyText }).reason).toMatch(
      /no .minisig/,
    )
  })

  it('the committed embedded public key parses (and pairs with the dev secret if present)', () => {
    expect(
      verifyArtifact({ content: Buffer.from('x'), publicKeyText: C3_MINISIGN_PUBLIC_KEY }).reason,
    ).toMatch(/no .minisig/)
    let secret
    try {
      secret = readFileSync(resolve(repoRoot, 'dist', 'c3-minisign-secret.key'), 'utf-8').trim()
    } catch {
      secret = null
    }
    if (!secret) return // secret moved offline — embedded-key correctness covered by the live `c3 verify` run
    const { keyId, seed } = parseSecretBlob(secret)
    const c = Buffer.from('paired?')
    const sig = signContent(c, { seed, keyId, trustedComment: 'pair' })
    expect(
      verifyArtifact({ content: c, sigText: sig, publicKeyText: C3_MINISIGN_PUBLIC_KEY }).ok,
    ).toBe(true)
  })
})

describe('c3 verify — runVerify over sidecar files', () => {
  function artifactFixture() {
    const dir = mkdtempSync(resolve(tmpdir(), 'c3-verify-'))
    const path = resolve(dir, 'c3-v9.9.9-test-x64')
    const content = Buffer.from('payload ' + 'q'.repeat(2000))
    writeFileSync(path, content)
    const kp = generateKeypair()
    writeFileSync(
      `${path}.sha256`,
      `${createHash('sha256').update(content).digest('hex')}  c3-v9.9.9-test-x64\n`,
    )
    writeFileSync(`${path}.minisig`, signWith(content, kp))
    return { dir, path, kp }
  }

  it('returns 0 for a genuine artifact, 1 for a tampered one, 1 for a missing file', () => {
    const { dir, path, kp } = artifactFixture()
    try {
      expect(runVerify(path, kp.publicKeyText)).toBe(0)
      writeFileSync(path, Buffer.from('tampered'))
      expect(runVerify(path, kp.publicKeyText)).toBe(1)
      expect(runVerify('/nonexistent/c3-bogus', kp.publicKeyText)).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('release:publish --dry-run', () => {
  it('plans the publish without creating a tag or calling gh', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'c3-pub-'))
    const manifestPath = resolve(dir, 'manifest.json')
    writeFileSync(
      manifestPath,
      JSON.stringify({ version: '9.9.9', artifacts: [{ file: 'c3-v9.9.9-test-x64' }] }),
    )
    const tagsBefore = spawnSync('git', ['tag', '-l'], { cwd: repoRoot, encoding: 'utf-8' }).stdout
    try {
      const r = spawnSync(
        'node',
        [resolve(here, 'publish.mjs'), '--dry-run', `--manifest=${manifestPath}`],
        {
          cwd: repoRoot,
          encoding: 'utf-8',
        },
      )
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/--dry-run: nothing signed, no tag, no GitHub Release/)
      // No new tag was created as a side effect.
      const tagsAfter = spawnSync('git', ['tag', '-l'], { cwd: repoRoot, encoding: 'utf-8' }).stdout
      expect(tagsAfter).toBe(tagsBefore)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
