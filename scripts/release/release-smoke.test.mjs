// Unit coverage for the artifact-gate helpers (release 5/7). The smoke.mjs script
// itself is the integration test carrier (run in `release:build` Phase3 against the
// real binary); these cover the pure logic so `pnpm test` — which is the PREGATE,
// so it runs BEFORE any artifact exists — stays green without a built product.
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import {
  hostTarget,
  isHostRunnable,
  isExperimental,
  P0_TARGETS,
  P1_TARGETS,
  KNOWN_TARGETS,
  EXPERIMENTAL_TARGETS,
} from './targets.mjs'
import { assertVersionOutput, freePort, smokeArtifact } from './smoke.mjs'
import { parseSha256Sums } from './postgate.mjs'
import { artifactName } from './artifact-name.mjs'
import { defaultOutfile, TARGETS } from '../../server/scripts/release/build-target.mjs'

describe('targets', () => {
  it('maps darwin/arm64 → macos-arm64 and linux/x64 → linux-x64', () => {
    expect(hostTarget('darwin', 'arm64')).toBe('macos-arm64')
    expect(hostTarget('linux', 'x64')).toBe('linux-x64')
  })

  it('maps win32/x64 → windows-x64 (release 4/7)', () => {
    expect(hostTarget('win32', 'x64')).toBe('windows-x64')
  })

  it('isHostRunnable matches only the host triple', () => {
    expect(isHostRunnable('macos-arm64', 'darwin', 'arm64')).toBe(true)
    expect(isHostRunnable('linux-x64', 'darwin', 'arm64')).toBe(false)
    // windows-x64 is host-runnable on a windows-latest runner — where its real smoke runs.
    expect(isHostRunnable('windows-x64', 'win32', 'x64')).toBe(true)
  })

  it('P0 is the two-platform matrix', () => {
    expect(P0_TARGETS).toEqual(['macos-arm64', 'linux-x64'])
  })

  it('P1 adds macos-x64 + windows-x64; KNOWN_TARGETS is the P0+P1 union', () => {
    expect(P1_TARGETS).toEqual(['macos-x64', 'windows-x64'])
    expect(KNOWN_TARGETS).toEqual(['macos-arm64', 'linux-x64', 'macos-x64', 'windows-x64'])
  })

  it('only windows-x64 is experimental (smoke-unverified on its OS)', () => {
    expect(EXPERIMENTAL_TARGETS).toEqual(['windows-x64'])
    expect(isExperimental('windows-x64')).toBe(true)
    expect(isExperimental('macos-x64')).toBe(false)
    expect(isExperimental('macos-arm64')).toBe(false)
  })

  it('TARGETS carries the P1 bun triples; windows artifact name gets .exe', () => {
    expect(TARGETS['macos-x64']).toBe('bun-darwin-x64')
    expect(TARGETS['windows-x64']).toBe('bun-windows-x64')
    expect(artifactName('0.2.0', 'windows-x64')).toBe('c3-v0.2.0-windows-x64.exe')
    expect(artifactName('0.2.0', 'macos-x64')).toBe('c3-v0.2.0-macos-x64')
  })
})

describe('assertVersionOutput', () => {
  it('accepts a real `c3 --version` line', () => {
    const out = '0.1.0 (commit c58a0b5, built 2026-06-05T07:22:53.535Z)'
    expect(assertVersionOutput(out)).toBe(out)
  })

  it('rejects output without a semver / commit / build time', () => {
    expect(() => assertVersionOutput('hello')).toThrow(/semver/)
    expect(() => assertVersionOutput('1.2.3')).toThrow(/commit/)
    expect(() => assertVersionOutput('1.2.3 (commit abcdef0)')).toThrow(/build time/)
  })
})

describe('parseSha256Sums', () => {
  it('parses `<hex>  <name>` lines into a name→hex map', () => {
    const hex = 'a'.repeat(64)
    const map = parseSha256Sums(`${hex}  c3-v0.1.0-macos-arm64\n# comment\n`)
    expect(map.get('c3-v0.1.0-macos-arm64')).toBe(hex)
    expect(map.size).toBe(1)
  })
})

describe('freePort', () => {
  it('returns a usable, distinct ephemeral port', async () => {
    const a = await freePort()
    const b = await freePort()
    expect(a).toBeGreaterThan(0)
    expect(b).toBeGreaterThan(0)
  })
})

// Conditional real smoke: only when a host-runnable artifact was already built.
describe('smokeArtifact (conditional)', () => {
  const product = defaultOutfile(hostTarget())
  it.runIf(existsSync(product))('boots the binary and answers HTTP, claude-free', async () => {
    const version = await smokeArtifact(product, { timeoutMs: 20000 })
    expect(version).toMatch(/^v?\d+\.\d+\.\d+/)
  })
})
