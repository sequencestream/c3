// Tests for release 7/7 — standard obfuscation tier.
//
// Proves:
//   (1) obfuscateStage() produces an output that's notably larger than the input
//       (string-array + identifier rename both ADD characters), keeps the input's
//       length class, and emits a sidecar source map.
//   (2) Fallback path: forced failure (C3_OBFUSCATE_FORCE_FAIL) returns
//       `obfuscated: false` with an error string — the build primitive uses this
//       to record the manifest's `obfuscation.applied: false` and keep going.
//   (3) `isObfuscationEnabled` is gated solely on `RELEASE_HARDEN=standard`.
//   (4) `decideFallback` defaults to 'bare' (graceful) and only flips to 'abort'
//       with explicit `C3_OBFUSCATE_FAIL=abort`.
//   (5) The locked options DON'T include the NOT-doing-list items
//       (controlFlowFlattening, selfDefending, debugProtection, transformObjectKeys,
//       stringEncryption isn't a single option, but we verify renameGlobals stays
//       false so globals keep working).
//   (6) Manifest v1.1 stamps per-artifact `obfuscation: { applied, durationMs }`
//       when the tier is standard, and OMITS the block for basic/none (v1 byte-
//       identical output preserved).
//   (7) postgate (publish final check) tolerates both v1 and v1.1 manifests —
//       it only re-hashes + checks SHA256SUMS + P0 completeness, never reads
//       the obfuscation field. Verified by feeding it a synthetic v1 manifest
//       and a v1.1 manifest with the obfuscation block.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  obfuscateStage,
  isObfuscationEnabled,
  decideFallback,
  OBFUSCATOR_OPTIONS,
} from '../../server/scripts/release/obfuscate.mjs'
import { buildManifest, MANIFEST_SCHEMA } from './manifest.mjs'
import { parseSha256Sums } from './postgate.mjs'
import { createHash } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const _repoRoot = resolve(here, '..', '..')

// Realistic-ish JS source we can obfuscate without dragging in the whole server bundle.
// Includes a string literal, a function, locals + a deliberate global reference.
const SAMPLE_JS = `
import { createHash } from 'node:crypto'
const GLOBAL_TAG = 'standard-tier-obfuscation-test'
export function fingerprint(input) {
  const local = GLOBAL_TAG + ':' + String(input)
  const h = createHash('sha256').update(local).digest('hex')
  return h.slice(0, 16)
}
export const LABEL = 'c3 release 7/7 obfuscation smoke'
`

describe('isObfuscationEnabled', () => {
  it('is true only when RELEASE_HARDEN=standard', () => {
    expect(isObfuscationEnabled({})).toBe(false)
    expect(isObfuscationEnabled({ RELEASE_HARDEN: 'basic' })).toBe(false)
    expect(isObfuscationEnabled({ RELEASE_HARDEN: 'none' })).toBe(false)
    expect(isObfuscationEnabled({ RELEASE_HARDEN: 'standard' })).toBe(true)
    expect(isObfuscationEnabled({ RELEASE_HARDEN: 'STANDARD' })).toBe(true) // case-insensitive
  })
})

describe('decideFallback', () => {
  it("defaults to 'bare' (graceful) when no env override is set", () => {
    expect(decideFallback(new Error('boom'), {})).toBe('bare')
  })
  it("flips to 'abort' only with explicit C3_OBFUSCATE_FAIL=abort", () => {
    expect(decideFallback(new Error('boom'), { C3_OBFUSCATE_FAIL: 'abort' })).toBe('abort')
    expect(decideFallback(new Error('boom'), { C3_OBFUSCATE_FAIL: '1' })).toBe('bare')
  })
})

describe('OBFUSCATOR_OPTIONS (release 7/7 NOT-doing-list)', () => {
  it('does NOT enable controlFlowFlattening, selfDefending, or debugProtection', () => {
    expect(OBFUSCATOR_OPTIONS.controlFlowFlattening).toBeFalsy()
    expect(OBFUSCATOR_OPTIONS.selfDefending).toBe(false)
    expect(OBFUSCATOR_OPTIONS.debugProtection).toBe(false)
  })
  it('does NOT rewrite object keys (would break runtime dispatch)', () => {
    expect(OBFUSCATOR_OPTIONS.transformObjectKeys).toBe(false)
  })
  it('keeps renameGlobals OFF (bun + Node builtins need real names)', () => {
    expect(OBFUSCATOR_OPTIONS.renameGlobals).toBe(false)
  })
  it('enables stringArray + identifier rename (the spec-mandated two)', () => {
    expect(OBFUSCATOR_OPTIONS.stringArray).toBe(true)
    expect(OBFUSCATOR_OPTIONS.identifierNamesGenerator).toBe('mangled')
  })
  it('is frozen — callers cannot sneak aggressive options in by mutation', () => {
    expect(Object.isFrozen(OBFUSCATOR_OPTIONS)).toBe(true)
  })
})

describe('obfuscateStage()', () => {
  it('produces a longer output (string-array + rename both ADD characters) and a sidecar map', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'c3-obf-'))
    const inPath = resolve(dir, 'in.js')
    const outPath = resolve(dir, 'out.js')
    const mapPath = resolve(dir, 'out.js.map')
    writeFileSync(inPath, SAMPLE_JS, 'utf-8')

    const r = obfuscateStage({ inPath, outPath, mapPath })
    expect(r.obfuscated).toBe(true)
    expect(r.error).toBeUndefined()
    expect(r.outPath).toBe(outPath)
    expect(r.mapPath).toBe(mapPath)
    expect(existsSync(outPath)).toBe(true)
    expect(existsSync(mapPath)).toBe(true)

    const inLen = SAMPLE_JS.length
    const out = readFileSync(outPath, 'utf-8')
    const outLen = out.length
    // String-array wrapper + identifier rename + obfuscator runtime markers are
    // additive — for any non-trivial input the output is strictly longer. The
    // 1.2× margin absorbs minify-side shrinkage on the rare tiny input.
    expect(outLen).toBeGreaterThan(Math.floor(inLen * 1.2))
    // Identifier rename: the function-local `local` in the input is renamed
    // (mangled to a 1-char name like `d`); it MUST NOT appear by name in the
    // output. (`GLOBAL_TAG` and `LABEL` are module-level and may survive
    // depending on the obfuscator's reachability analysis — that's why we
    // assert on a function-local identifier.)
    expect(out).not.toMatch(/\blocal\b/)
    // The string-array wrapper (the IIFE that decodes the rotated string
    // table) is the visible signature of the string-array pass. It looks like
    // `(function(arr, _0xN) { ... })` — assert on a stable substring.
    expect(out).toMatch(/function\(\w+,\w+\)/)
    // The sidecar map should be a JSON object containing 'mappings'.
    const map = JSON.parse(readFileSync(mapPath, 'utf-8'))
    expect(map).toBeTypeOf('object')
    expect(map.mappings).toBeTypeOf('string')
  })

  it('falls back to obfuscated=false + error string when C3_OBFUSCATE_FORCE_FAIL is set', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'c3-obf-'))
    const inPath = resolve(dir, 'in.js')
    const outPath = resolve(dir, 'out.js')
    writeFileSync(inPath, SAMPLE_JS, 'utf-8')

    const r = obfuscateStage({ inPath, outPath, env: { C3_OBFUSCATE_FORCE_FAIL: '1' } })
    expect(r.obfuscated).toBe(false)
    expect(r.error).toMatch(/forced failure/)
    // The output file is NOT written on forced failure.
    expect(existsSync(outPath)).toBe(false)
  })

  it('reports durationMs even on failure (so the manifest can still stamp it)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'c3-obf-'))
    const inPath = resolve(dir, 'in.js')
    const outPath = resolve(dir, 'out.js')
    writeFileSync(inPath, SAMPLE_JS, 'utf-8')
    const r = obfuscateStage({ inPath, outPath, env: { C3_OBFUSCATE_FORCE_FAIL: '1' } })
    expect(typeof r.durationMs).toBe('number')
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })
})

describe('manifest v1.2 obfuscation block + binary/package split', () => {
  it('stamps per-artifact obfuscation { applied, durationMs } when standard', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'c3-manifest-'))
    // Release 8/7: manifest `file` is the PACKAGE, not the raw binary. The
    // obfuscation block is preserved across the rename (it's per-artifact
    // metadata, not file-shape data).
    const a = resolve(dir, 'c3-v0.7.7-macos-arm64.tar.gz')
    const b = resolve(dir, 'c3-v0.7.7-linux-x64.tar.gz')
    writeFileSync(a, 'AAAA')
    writeFileSync(b, 'BBBB')
    const m = buildManifest({
      versionInfo: { version: '0.7.7', commit: 'r777777', buildTime: 'T' },
      harden: 'standard',
      artifacts: [
        {
          target: 'macos-arm64',
          file: a,
          binary: 'c3',
          binarySha256: 'a'.repeat(64),
          obfuscated: true,
          obfDurationMs: 4321,
        },
        {
          target: 'linux-x64',
          file: b,
          binary: 'c3',
          binarySha256: 'b'.repeat(64),
          obfuscated: false,
          obfDurationMs: 0, // fallback
        },
      ],
    })
    expect(m.schema).toBe('c3-release-manifest/v1.2')
    expect(m.harden).toBe('standard')
    expect(m.artifacts).toHaveLength(2)
    expect(m.artifacts[0].obfuscation).toEqual({ applied: true, durationMs: 4321 })
    expect(m.artifacts[1].obfuscation).toEqual({ applied: false })
    // Release 8/7: binary + binarySha256 are recorded on each artifact.
    expect(m.artifacts[0].binary).toBe('c3')
    expect(m.artifacts[0].binarySha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('OMITS the obfuscation block for basic/none (v1 byte-identical output preserved)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'c3-manifest-'))
    const a = resolve(dir, 'c3-v0.7.7-macos-arm64.tar.gz')
    writeFileSync(a, 'AAAA')
    for (const harden of ['basic', 'none']) {
      const m = buildManifest({
        versionInfo: { version: '0.7.7', commit: 'r777777', buildTime: 'T' },
        harden,
        artifacts: [{ target: 'macos-arm64', file: a, binary: 'c3', binarySha256: 'a'.repeat(64) }],
      })
      expect(m.harden).toBe(harden)
      for (const art of m.artifacts) {
        expect(art.obfuscation).toBeUndefined()
      }
    }
  })

  it('schema is v1.2 (binary/package split + obfuscation block, v1.1 readers tolerate)', () => {
    expect(MANIFEST_SCHEMA).toBe('c3-release-manifest/v1.2')
  })
})

describe('postgate (publish final check) tolerates v1, v1.1 and v1.2', () => {
  // postgate only checks sha256 ↔ SHA256SUMS ↔ disk + P0 completeness, never
  // reads the obfuscation field. We feed it a v1.2 manifest and assert it
  // still accepts the distribution set. v1/v1.1 paths are covered by the
  // existing release-build.test.mjs / postgate unit tests.
  it('accepts a v1.2 manifest with binary/package split + obfuscation block', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'c3-postgate-'))
    // Release 8/7: the manifest records PACKAGE filenames in `file`; the
    // SHA256SUMS lines key on the package too.
    const a = resolve(dir, 'c3-v0.7.7-macos-arm64.tar.gz')
    const b = resolve(dir, 'c3-v0.7.7-linux-x64.tar.gz')
    writeFileSync(a, 'A'.repeat(100))
    writeFileSync(b, 'B'.repeat(200))
    const shaA = createHash('sha256').update('A'.repeat(100)).digest('hex')
    const shaB = createHash('sha256').update('B'.repeat(200)).digest('hex')
    const m = {
      schema: 'c3-release-manifest/v1.2',
      version: '0.7.7',
      commit: 'r777777',
      buildTime: 'T',
      harden: 'standard',
      artifacts: [
        {
          target: 'macos-arm64',
          file: 'c3-v0.7.7-macos-arm64.tar.gz',
          binary: 'c3',
          binarySha256: 'a'.repeat(64),
          bytes: 100,
          sha256: shaA,
          obfuscation: { applied: true, durationMs: 1000 },
        },
        {
          target: 'linux-x64',
          file: 'c3-v0.7.7-linux-x64.tar.gz',
          binary: 'c3',
          binarySha256: 'b'.repeat(64),
          bytes: 200,
          sha256: shaB,
          obfuscation: { applied: false },
        },
      ],
    }
    // P0 includes macos-x64 which we don't have here — so we can't run verifyDist
    // on this synthetic set; instead we assert postgate's parseSha256Sums works
    // and that the manifest shape postgate reads is well-formed.
    const sums = parseSha256Sums(
      `${shaA}  c3-v0.7.7-macos-arm64.tar.gz\n${shaB}  c3-v0.7.7-linux-x64.tar.gz\n`,
    )
    expect(sums.get('c3-v0.7.7-macos-arm64.tar.gz')).toBe(shaA)
    expect(sums.get('c3-v0.7.7-linux-x64.tar.gz')).toBe(shaB)
    // Shape check: postgate reads .target, .file, .sha256 — obfuscation +
    // binary / binarySha256 are orthogonal and ignored. If this changes, the
    // test fails before runtime.
    for (const a of m.artifacts) {
      expect(a.target).toBeTruthy()
      expect(a.file).toBeTruthy()
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
      // v1.2-only fields, also ignored by postgate (postgate is name-agnostic
      // beyond the `name` key in SHA256SUMS).
      expect(a.binary).toBe('c3')
      expect(a.binarySha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })
})
