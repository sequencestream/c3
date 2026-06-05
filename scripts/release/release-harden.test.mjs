// Tests for release 2/7 — version injection + manifest + harden tier framework.
// Proves: (1) version-info resolves version/commit/baseline + define mapping,
// (2) manifest sha256 matches an independent digest and fields are complete,
// (3) the orchestrator threads the harden tier and plans the manifest per tier,
// (4) the harden tier vocabulary is validated.
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeVersionInfo, versionDefines, baselineVersion } from './version-info.mjs'
import { buildManifest, sha256File, MANIFEST_SCHEMA } from './manifest.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const orchestrator = resolve(here, 'release-build.mjs')

function dryRun(args = [], env = {}) {
  return spawnSync('node', [orchestrator, '--dry-run', ...args], {
    encoding: 'utf-8',
    cwd: repoRoot,
    env: { ...process.env, ...env },
  })
}

describe('version-info', () => {
  it('resolves a non-empty version + 7-char commit + ISO build time', () => {
    const info = computeVersionInfo()
    expect(info.version).toBeTruthy()
    expect(info.commit).toMatch(/^([0-9a-f]{7}|unknown)$/)
    expect(Number.isNaN(Date.parse(info.buildTime))).toBe(false)
  })

  it('uses the package.json version as the fallback baseline', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf-8'))
    expect(computeVersionInfo().baseline).toBe(pkg.version)
    expect(baselineVersion()).toBe(pkg.version)
  })

  it('honors an injected build time verbatim', () => {
    const t = '2026-06-05T00:00:00.000Z'
    expect(computeVersionInfo({ buildTime: t }).buildTime).toBe(t)
  })

  it('maps version info to JSON-string define constants', () => {
    const info = { version: '1.2.3', commit: 'abc1234', buildTime: 'T' }
    const d = versionDefines(info)
    expect(JSON.parse(d.__C3_VERSION__)).toBe('1.2.3')
    expect(JSON.parse(d.__C3_COMMIT__)).toBe('abc1234')
    expect(JSON.parse(d.__C3_BUILD_TIME__)).toBe('T')
  })
})

describe('manifest', () => {
  it('sha256File matches an independent crypto digest', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'c3-manifest-'))
    const f = resolve(dir, 'artifact.bin')
    const bytes = Buffer.from('hello c3 release manifest')
    writeFileSync(f, bytes)
    const expected = createHash('sha256').update(bytes).digest('hex')
    expect(sha256File(f)).toBe(expected)
  })

  it('builds a complete manifest whose sha256/bytes match the real files', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'c3-manifest-'))
    // Release 8/7: the manifest's `file` is the PACKAGE name, not the raw
    // binary. `binary` / `binarySha256` describe the in-package binary.
    const a = resolve(dir, 'c3-v0.9.0-macos-arm64.tar.gz')
    const b = resolve(dir, 'c3-v0.9.0-linux-x64.tar.gz')
    writeFileSync(a, 'AAAA')
    writeFileSync(b, 'BBBBBB')
    const versionInfo = { version: '0.9.0', commit: 'deadbee', buildTime: 'T0' }
    const m = buildManifest({
      versionInfo,
      harden: 'basic',
      artifacts: [
        { target: 'macos-arm64', file: a, binary: 'c3', binarySha256: 'a'.repeat(64) },
        { target: 'linux-x64', file: b, binary: 'c3', binarySha256: 'b'.repeat(64) },
      ],
    })
    expect(m.schema).toBe(MANIFEST_SCHEMA)
    expect(m).toMatchObject({
      version: '0.9.0',
      commit: 'deadbee',
      buildTime: 'T0',
      harden: 'basic',
    })
    expect(m.artifacts).toHaveLength(2)
    for (const [art, file] of [
      [m.artifacts[0], a],
      [m.artifacts[1], b],
    ]) {
      expect(art.file).toBe(basename(file))
      expect(art.binary).toBe('c3')
      expect(art.binarySha256).toMatch(/^[0-9a-f]{64}$/)
      expect(art.bytes).toBe(readFileSync(file).length)
      expect(art.sha256).toBe(createHash('sha256').update(readFileSync(file)).digest('hex'))
    }
  })

  it('records the requested harden tier verbatim (standard is a placeholder)', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'c3-manifest-'))
    // Release 8/7: package filename (.zip on Windows) is the manifest's `file`.
    const f = resolve(dir, 'c3-v1.0.0-windows-x64.zip')
    writeFileSync(f, 'x')
    const m = buildManifest({
      versionInfo: { version: '1', commit: 'c', buildTime: 't' },
      harden: 'standard',
      artifacts: [
        { target: 'windows-x64', file: f, binary: 'c3.exe', binarySha256: '0'.repeat(64) },
      ],
    })
    expect(m.harden).toBe('standard')
    expect(m.artifacts[0].file).toBe('c3-v1.0.0-windows-x64.zip')
    expect(m.artifacts[0].binary).toBe('c3.exe')
  })
})

describe('orchestrator harden plumbing', () => {
  it('defaults to harden=basic and plans to write the manifest', () => {
    const { stdout, status } = dryRun([], { RELEASE_HARDEN: '' })
    expect(status).toBe(0)
    expect(stdout).toMatch(/harden\s+basic/)
    expect(stdout).toMatch(/manifest\s+write →/)
  })

  it('prints the injected version + commit in the plan', () => {
    const { stdout } = dryRun()
    expect(stdout).toMatch(/version\s+\S+ \(commit [0-9a-f]{7}\)/)
  })

  it('RELEASE_HARDEN=none skips the manifest', () => {
    const { stdout } = dryRun([], { RELEASE_HARDEN: 'none' })
    expect(stdout).toMatch(/harden\s+none/)
    expect(stdout).toMatch(/manifest\s+skipped/)
  })

  it('--harden flag overrides the env', () => {
    const { stdout } = dryRun(['--harden=none'], { RELEASE_HARDEN: 'basic' })
    expect(stdout).toMatch(/harden\s+none/)
  })

  it('rejects an unknown harden tier with a non-zero exit', () => {
    const { status, stderr } = dryRun(['--harden=fortknox'])
    expect(status).not.toBe(0)
    expect(stderr).toMatch(/unknown harden tier/)
  })
})
