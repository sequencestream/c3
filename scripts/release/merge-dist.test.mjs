// Tests for merge-dist (release 6/7) — folding per-target build artifacts into one dist/.
// Proves: (1) per-target subdir manifests merge into a complete manifest, (2) packages
// flatten up into dist/, (3) SHA256SUMS is emitted from the manifest hashes, (4) the
// merged result passes postgate, (5) mixed-build (commit/version) manifests are rejected.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { mergeDist } from './merge-dist.mjs'
import { verifyDist } from './postgate.mjs'

const SCHEMA = 'c3-release-manifest/v1.3'
const COMMIT = 'abc1234'
const VERSION = '0.1.0'

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * Lay out one build job's artifact subdir carrying ARBITRARILY MANY artifacts.
 * The desktop channel makes this the general case: a single job emits a `.dmg`
 * and an `.app.tar.gz` for one target.
 */
function writeJobSubdir(root, { artifactName, artifacts }) {
  const dir = join(root, artifactName)
  mkdirSync(dir, { recursive: true })
  const entries = artifacts.map((a) => {
    const bytes = Buffer.from(`fake-bytes-${a.file}`)
    writeFileSync(join(dir, a.file), bytes)
    return { ...a, bytes: bytes.length, sha256: sha256(bytes) }
  })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        schema: SCHEMA,
        version: VERSION,
        commit: COMMIT,
        buildTime: '2026-06-05T00:00:00Z',
        artifacts: entries,
      },
      null,
      2,
    ) + '\n',
  )
  return entries
}

/** Run `fn` with the postgate's env knobs set, restoring whatever was there. */
function withEnv(vars, fn) {
  const prev = {}
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/** Lay out one per-target artifact subdir: dist/<artifact>/{package, manifest.json}. */
function writeTargetSubdir(root, { artifactName, target, pkgFile }) {
  const dir = join(root, artifactName)
  mkdirSync(dir, { recursive: true })
  const bytes = Buffer.from(`fake-${target}-package-bytes`)
  const pkgPath = join(dir, pkgFile)
  writeFileSync(pkgPath, bytes)
  const hash = sha256(bytes)
  const manifest = {
    schema: SCHEMA,
    version: VERSION,
    commit: COMMIT,
    buildTime: '2026-06-05T00:00:00Z',
    artifacts: [{ target, file: pkgFile, bytes: bytes.length, sha256: hash, binary: 'c3' }],
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return { hash, pkgFile }
}

describe('merge-dist', () => {
  let root
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'c3-merge-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('merges per-target manifests + flattens packages + writes SHA256SUMS', () => {
    const p0 = [
      { artifactName: 'c3-linux-x64', target: 'linux-x64', pkgFile: 'c3-v0.1.0-linux-x64.tar.gz' },
      {
        artifactName: 'c3-macos-arm64',
        target: 'macos-arm64',
        pkgFile: 'c3-v0.1.0-macos-arm64.tar.gz',
      },
      {
        artifactName: 'c3-windows-x64',
        target: 'windows-x64',
        pkgFile: 'c3-v0.1.0-windows-x64.zip',
      },
    ]
    const written = p0.map((t) => writeTargetSubdir(root, t))

    const { manifestPath, sumsPath, targets } = mergeDist({ distDir: root })

    expect(targets.sort()).toEqual(['linux-x64', 'macos-arm64', 'windows-x64'])

    // Merged manifest has all three targets.
    const merged = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    expect(merged.artifacts.map((a) => a.target).sort()).toEqual([
      'linux-x64',
      'macos-arm64',
      'windows-x64',
    ])
    expect(merged.commit).toBe(COMMIT)
    expect(merged.version).toBe(VERSION)

    // Packages flattened up into dist/.
    for (const t of p0) expect(existsSync(join(root, t.pkgFile))).toBe(true)

    // SHA256SUMS lists every package with its hash.
    const sums = readFileSync(sumsPath, 'utf-8')
    for (const w of written) expect(sums).toContain(`${w.hash}  ${w.pkgFile}`)
  })

  it('produces a dist that passes postgate (manifest ↔ SHA256SUMS ↔ on-disk)', () => {
    ;[
      { artifactName: 'c3-linux-x64', target: 'linux-x64', pkgFile: 'c3-v0.1.0-linux-x64.tar.gz' },
      {
        artifactName: 'c3-macos-arm64',
        target: 'macos-arm64',
        pkgFile: 'c3-v0.1.0-macos-arm64.tar.gz',
      },
    ].forEach((t) => writeTargetSubdir(root, t))

    const { manifestPath } = mergeDist({ distDir: root })
    // Full P0 present → postgate must pass.
    expect(() => verifyDist({ manifestPath })).not.toThrow()
  })

  it('rejects manifests from different commits (mixed builds)', () => {
    writeTargetSubdir(root, {
      artifactName: 'c3-linux-x64',
      target: 'linux-x64',
      pkgFile: 'c3-v0.1.0-linux-x64.tar.gz',
    })
    // Hand-write a second subdir with a divergent commit.
    const dir = join(root, 'c3-macos-arm64')
    mkdirSync(dir, { recursive: true })
    const bytes = Buffer.from('other')
    writeFileSync(join(dir, 'c3-v0.1.0-macos-arm64.tar.gz'), bytes)
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        schema: SCHEMA,
        version: VERSION,
        commit: 'deadbee',
        buildTime: '2026-06-05T00:00:00Z',
        artifacts: [
          {
            target: 'macos-arm64',
            file: 'c3-v0.1.0-macos-arm64.tar.gz',
            bytes: bytes.length,
            sha256: sha256(bytes),
          },
        ],
      }),
    )

    expect(() => mergeDist({ distDir: root })).toThrow(/mismatch|mixed builds/)
  })

  it('throws when there is nothing to merge', () => {
    expect(() => mergeDist({ distDir: root })).toThrow(/nothing to merge/)
  })

  // ── Desktop channel ────────────────────────────────────────────────────────
  // One target now legitimately carries several artifacts across two channels.
  // These cover the dedup key: keying by `target` would silently drop all but one.

  it('keeps every artifact when one target ships in both channels', () => {
    writeJobSubdir(root, {
      artifactName: 'c3-macos-arm64',
      artifacts: [
        {
          target: 'macos-arm64',
          platform: 'macos',
          arch: 'arm64',
          channel: 'cli',
          file: 'c3-v0.1.0-macos-arm64.tar.gz',
          binary: 'c3',
        },
      ],
    })
    writeJobSubdir(root, {
      artifactName: 'c3-desktop-macos-arm64',
      artifacts: [
        {
          target: 'macos-arm64',
          platform: 'macos',
          arch: 'arm64',
          channel: 'desktop',
          kind: 'dmg',
          file: 'c3-desktop-v0.1.0-macos-arm64.dmg',
        },
        {
          target: 'macos-arm64',
          platform: 'macos',
          arch: 'arm64',
          channel: 'desktop',
          kind: 'app',
          file: 'c3-desktop-v0.1.0-macos-arm64.app.tar.gz',
        },
      ],
    })

    const { manifestPath, sumsPath } = mergeDist({ distDir: root })
    const merged = JSON.parse(readFileSync(manifestPath, 'utf-8'))

    expect(merged.artifacts).toHaveLength(3)
    expect(merged.artifacts.map((a) => a.file).sort()).toEqual([
      'c3-desktop-v0.1.0-macos-arm64.app.tar.gz',
      'c3-desktop-v0.1.0-macos-arm64.dmg',
      'c3-v0.1.0-macos-arm64.tar.gz',
    ])
    // Both channels survive for the SAME target.
    expect(merged.artifacts.filter((a) => a.channel === 'cli')).toHaveLength(1)
    expect(merged.artifacts.filter((a) => a.channel === 'desktop')).toHaveLength(2)

    // Every artifact flattened up into dist/ and made it into SHA256SUMS.
    const sums = readFileSync(sumsPath, 'utf-8')
    for (const a of merged.artifacts) {
      expect(existsSync(join(root, a.file))).toBe(true)
      expect(sums).toContain(`${a.sha256}  ${a.file}`)
    }
  })

  it('gates completeness per channel, not per target', () => {
    // A desktop-only dist: the desktop gate is satisfied, the CLI gate is not —
    // otherwise a dist full of .dmg files would read as "macos-arm64 shipped".
    writeJobSubdir(root, {
      artifactName: 'c3-desktop-macos-arm64',
      artifacts: [
        {
          target: 'macos-arm64',
          channel: 'desktop',
          kind: 'dmg',
          preferred: true,
          file: 'c3-desktop-v0.1.0-macos-arm64.dmg',
        },
      ],
    })
    const { manifestPath } = mergeDist({ distDir: root })

    withEnv({ C3_REQUIRED_TARGETS: 'macos-arm64', C3_REQUIRED_CHANNEL: 'desktop' }, () =>
      expect(() => verifyDist({ manifestPath })).not.toThrow(),
    )
    withEnv({ C3_REQUIRED_TARGETS: 'macos-arm64', C3_REQUIRED_CHANNEL: 'cli' }, () =>
      expect(() => verifyDist({ manifestPath })).toThrow(/required cli target\(s\) missing/),
    )
  })

  it('still rejects two different builds of the same artifact file', () => {
    writeJobSubdir(root, {
      artifactName: 'c3-desktop-a',
      artifacts: [
        {
          target: 'linux-x64',
          channel: 'desktop',
          kind: 'deb',
          file: 'c3-desktop-v0.1.0-linux-x64.deb',
        },
      ],
    })
    // Same filename, different bytes → the dedup key must catch the conflict.
    const dir = join(root, 'c3-desktop-b')
    mkdirSync(dir, { recursive: true })
    const bytes = Buffer.from('a different build entirely')
    writeFileSync(join(dir, 'c3-desktop-v0.1.0-linux-x64.deb'), bytes)
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        schema: SCHEMA,
        version: VERSION,
        commit: COMMIT,
        buildTime: '2026-06-05T00:00:00Z',
        artifacts: [
          {
            target: 'linux-x64',
            channel: 'desktop',
            kind: 'deb',
            file: 'c3-desktop-v0.1.0-linux-x64.deb',
            bytes: bytes.length,
            sha256: sha256(bytes),
          },
        ],
      }),
    )

    expect(() => mergeDist({ distDir: root })).toThrow(/conflicting artifact/)
  })
})
