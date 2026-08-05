import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DESKTOP_TARGETS,
  bundleVersion,
  desktopBundles,
  desktopPackageName,
  isDesktopHostTarget,
  rustTriple,
  sidecarStageName,
  tauriBundleFlags,
} from './desktop-artifacts.mjs'
import { findBundleArtifact, stageSidecarBinary, verifySidecarVersion } from './desktop.mjs'
import { buildManifest, carryForwardArtifacts, CHANNEL_DESKTOP, splitTarget } from './manifest.mjs'
import { binaryPathFor, cliChannel } from './smoke.mjs'
import { requiredChannel } from './postgate.mjs'
import { KNOWN_TARGETS } from './targets.mjs'

describe('rustTriple', () => {
  it('maps every desktop target to its Rust triple', () => {
    expect(rustTriple('macos-arm64')).toBe('aarch64-apple-darwin')
    expect(rustTriple('windows-x64')).toBe('x86_64-pc-windows-msvc')
    expect(rustTriple('linux-x64')).toBe('x86_64-unknown-linux-gnu')
  })

  it('throws rather than inventing a triple for an unknown target', () => {
    expect(() => rustTriple('freebsd-x64')).toThrowError(/no Rust target triple/)
  })

  it('only names targets the CLI build primitive also knows', () => {
    // The sidecar is compiled by the SAME build-target.mjs the CLI channel uses;
    // a desktop target with no CLI target would have nothing to embed.
    for (const t of DESKTOP_TARGETS) expect(KNOWN_TARGETS).toContain(t)
  })
})

describe('sidecarStageName', () => {
  it('uses the Tauri externalBin convention (basename + triple)', () => {
    expect(sidecarStageName('macos-arm64')).toBe('c3-aarch64-apple-darwin')
    expect(sidecarStageName('linux-x64')).toBe('c3-x86_64-unknown-linux-gnu')
  })

  it('keeps the .exe suffix on Windows', () => {
    expect(sidecarStageName('windows-x64')).toBe('c3-x86_64-pc-windows-msvc.exe')
  })
})

describe('desktopPackageName', () => {
  it('is prefixed c3-desktop- so UI and CLI downloads never look alike', () => {
    const [dmg] = desktopBundles('macos-arm64')
    expect(desktopPackageName('0.9.6', 'macos-arm64', dmg)).toBe(
      'c3-desktop-v0.9.6-macos-arm64.dmg',
    )
  })

  it('does not double the leading v', () => {
    const [dmg] = desktopBundles('macos-arm64')
    expect(desktopPackageName('v0.9.6', 'macos-arm64', dmg)).toBe(
      'c3-desktop-v0.9.6-macos-arm64.dmg',
    )
  })

  it('archives the directory-shaped .app into a tarball name', () => {
    const app = desktopBundles('macos-arm64').find((b) => b.kind === 'app')
    expect(desktopPackageName('0.9.6', 'macos-arm64', app)).toBe(
      'c3-desktop-v0.9.6-macos-arm64.app.tar.gz',
    )
  })

  it('covers every declared bundle of every target', () => {
    for (const target of DESKTOP_TARGETS) {
      for (const bundle of desktopBundles(target)) {
        expect(desktopPackageName('1.0.0', target, bundle)).toMatch(
          /^c3-desktop-v1\.0\.0-[a-z0-9-]+\./,
        )
      }
    }
  })
})

describe('desktopBundles / tauriBundleFlags', () => {
  it('ships the formats the spec names for each platform', () => {
    expect(desktopBundles('macos-arm64').map((b) => b.kind)).toEqual(['dmg', 'app'])
    expect(desktopBundles('windows-x64').map((b) => b.kind)).toEqual(['msi', 'nsis'])
    expect(desktopBundles('linux-x64').map((b) => b.kind)).toEqual(['deb', 'appimage'])
  })

  it('passes those same formats to tauri build', () => {
    expect(tauriBundleFlags('linux-x64')).toEqual(['deb', 'appimage'])
  })

  it('throws for a target with no bundle plan', () => {
    expect(() => desktopBundles('macos-x64')).toThrowError(/no bundle plan/)
  })
})

describe('bundleVersion', () => {
  it('passes a plain semver through', () => {
    expect(bundleVersion('0.9.6')).toBe('0.9.6')
    expect(bundleVersion('v1.2.3')).toBe('1.2.3')
  })

  it('narrows a git-describe version to the three parts MSI accepts', () => {
    // `git describe` after a tag looks like this, and MSI rejects it outright.
    expect(bundleVersion('0.9.6-12-gabc1234')).toBe('0.9.6')
  })

  it('throws when no semver can be derived', () => {
    expect(() => bundleVersion('nightly')).toThrowError(/cannot derive a bundle version/)
  })
})

describe('isDesktopHostTarget', () => {
  it('recognises the host triple, and only that one', () => {
    expect(isDesktopHostTarget('macos-arm64', 'darwin', 'arm64')).toBe(true)
    expect(isDesktopHostTarget('windows-x64', 'win32', 'x64')).toBe(true)
    expect(isDesktopHostTarget('linux-x64', 'linux', 'x64')).toBe(true)
    // Tauri has no cross-platform bundling — a foreign target must not look buildable.
    expect(isDesktopHostTarget('linux-x64', 'darwin', 'arm64')).toBe(false)
    expect(isDesktopHostTarget('macos-arm64', 'darwin', 'x64')).toBe(false)
  })
})

describe('findBundleArtifact', () => {
  let dir
  const mk = () => {
    dir = mkdtempSync(join(tmpdir(), 'c3-desktop-bundle-'))
    return dir
  }

  it('discovers the artifact by extension rather than predicting Tauri’s filename', () => {
    const root = mk()
    mkdirSync(join(root, 'dmg'), { recursive: true })
    writeFileSync(join(root, 'dmg', 'c3_0.9.6_aarch64.dmg'), 'x')
    const found = findBundleArtifact(root, { kind: 'dmg', dir: 'dmg', ext: '.dmg' })
    expect(found).toBe(join(root, 'dmg', 'c3_0.9.6_aarch64.dmg'))
    rmSync(root, { recursive: true, force: true })
  })

  it('returns null when the bundling step produced nothing', () => {
    const root = mk()
    mkdirSync(join(root, 'msi'), { recursive: true })
    expect(findBundleArtifact(root, { kind: 'msi', dir: 'msi', ext: '.msi' })).toBeNull()
    expect(findBundleArtifact(root, { kind: 'deb', dir: 'deb', ext: '.deb' })).toBeNull()
    rmSync(root, { recursive: true, force: true })
  })

  it('prefers the newest candidate when a stale build is left behind', () => {
    const root = mk()
    mkdirSync(join(root, 'deb'), { recursive: true })
    const stale = join(root, 'deb', 'c3_0.9.5_amd64.deb')
    const fresh = join(root, 'deb', 'c3_0.9.6_amd64.deb')
    writeFileSync(stale, 'old')
    writeFileSync(fresh, 'new')
    const past = new Date(Date.now() - 60_000)
    utimesSync(stale, past, past)
    expect(findBundleArtifact(root, { kind: 'deb', dir: 'deb', ext: '.deb' })).toBe(fresh)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('stageSidecarBinary', () => {
  it('copies the compiled binary under the exact name Tauri looks for', () => {
    const dir = mkdtempSync(join(tmpdir(), 'c3-desktop-stage-'))
    const src = join(dir, 'c3')
    writeFileSync(src, 'binary')
    const dest = join(dir, 'binaries')
    const out = stageSidecarBinary({ target: 'macos-arm64', binaryPath: src, destDir: dest })
    expect(out).toBe(join(dest, 'c3-aarch64-apple-darwin'))
    rmSync(dir, { recursive: true, force: true })
  })

  it('fails loudly when the sidecar was never compiled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'c3-desktop-stage-'))
    expect(() =>
      stageSidecarBinary({
        target: 'macos-arm64',
        binaryPath: join(dir, 'nope'),
        destDir: join(dir, 'binaries'),
      }),
    ).toThrowError(/sidecar binary missing/)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('verifySidecarVersion', () => {
  it('skips targets this host cannot execute', () => {
    const foreign = DESKTOP_TARGETS.find((t) => !isDesktopHostTarget(t))
    const res = verifySidecarVersion({
      target: foreign,
      binaryPath: '/nonexistent',
      expected: '9.9.9',
    })
    expect(res.checked).toBe(false)
  })
})

describe('manifest desktop channel', () => {
  const versionInfo = { version: '0.9.6', commit: 'abc1234', buildTime: '2026-08-05T00:00:00Z' }

  it('splits the target into explicit platform and arch', () => {
    expect(splitTarget('macos-arm64')).toEqual({ platform: 'macos', arch: 'arm64' })
    expect(splitTarget('windows-x64')).toEqual({ platform: 'windows', arch: 'x64' })
  })

  it('records platform, arch, kind and channel for a desktop artifact', () => {
    const m = buildManifest({
      versionInfo,
      artifacts: [
        {
          target: 'macos-arm64',
          file: '/dist/c3-desktop-v0.9.6-macos-arm64.dmg',
          kind: 'dmg',
          channel: CHANNEL_DESKTOP,
          bytes: 10,
          sha256: 'a'.repeat(64),
        },
      ],
    })
    expect(m.artifacts[0]).toMatchObject({
      target: 'macos-arm64',
      platform: 'macos',
      arch: 'arm64',
      channel: 'desktop',
      kind: 'dmg',
      file: 'c3-desktop-v0.9.6-macos-arm64.dmg',
    })
  })

  it('defaults an unlabelled artifact to the cli channel', () => {
    const m = buildManifest({
      versionInfo,
      artifacts: [
        {
          target: 'linux-x64',
          file: '/dist/c3-v0.9.6-linux-x64.tar.gz',
          bytes: 10,
          sha256: 'b'.repeat(64),
        },
      ],
    })
    expect(m.artifacts[0].channel).toBe('cli')
  })

  it('lets both channels describe the same target without colliding', () => {
    const m = buildManifest({
      versionInfo,
      artifacts: [
        {
          target: 'macos-arm64',
          file: '/dist/c3-v0.9.6-macos-arm64.tar.gz',
          bytes: 1,
          sha256: 'c'.repeat(64),
        },
        {
          target: 'macos-arm64',
          file: '/dist/c3-desktop-v0.9.6-macos-arm64.dmg',
          kind: 'dmg',
          channel: CHANNEL_DESKTOP,
          bytes: 2,
          sha256: 'd'.repeat(64),
        },
      ],
    })
    expect(m.artifacts).toHaveLength(2)
    expect(new Set(m.artifacts.map((a) => a.channel))).toEqual(new Set(['cli', 'desktop']))
  })
})

describe('carryForwardArtifacts — two channels, one manifest file', () => {
  const versionInfo = { version: '0.9.6', commit: 'abc1234', buildTime: '2026-08-05T00:00:00Z' }
  let dir

  const writeManifestWith = (artifacts, info = versionInfo) => {
    dir = mkdtempSync(join(tmpdir(), 'c3-carry-'))
    const path = join(dir, 'manifest.json')
    writeFileSync(
      path,
      JSON.stringify({ schema: 'c3-release-manifest/v1.3', ...info, artifacts }, null, 2),
    )
    return path
  }
  const cliEntry = {
    target: 'macos-arm64',
    channel: 'cli',
    file: 'c3-v0.9.6-macos-arm64.tar.gz',
    sha256: 'a'.repeat(64),
  }
  const dmgEntry = {
    target: 'macos-arm64',
    channel: 'desktop',
    kind: 'dmg',
    file: 'c3-desktop-v0.9.6-macos-arm64.dmg',
    sha256: 'b'.repeat(64),
  }

  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('carries the other channel forward so the write order stops mattering', () => {
    // `release:desktop` already wrote its installers; `release:build` now writes the
    // CLI package. Without carry-forward the .dmg vanishes from the manifest — and
    // therefore from SHA256SUMS — while still sitting on disk.
    const path = writeManifestWith([dmgEntry])
    const carried = carryForwardArtifacts(path, versionInfo, [cliEntry.file])
    expect(carried.map((a) => a.file)).toEqual([dmgEntry.file])
  })

  it('does not duplicate an entry the caller is rewriting itself', () => {
    const path = writeManifestWith([cliEntry, dmgEntry])
    const carried = carryForwardArtifacts(path, versionInfo, [dmgEntry.file])
    expect(carried.map((a) => a.file)).toEqual([cliEntry.file])
  })

  it('accepts absolute paths for the produced files', () => {
    const path = writeManifestWith([cliEntry, dmgEntry])
    const carried = carryForwardArtifacts(path, versionInfo, [`/abs/dist/${dmgEntry.file}`])
    expect(carried.map((a) => a.file)).toEqual([cliEntry.file])
  })

  it('discards a manifest left over from a different build', () => {
    // Mixing artifacts from two commits is exactly what the release gates exist
    // to prevent — a stale manifest must be dropped whole, not merged.
    const path = writeManifestWith([dmgEntry], { ...versionInfo, commit: 'deadbee' })
    expect(carryForwardArtifacts(path, versionInfo, [cliEntry.file])).toEqual([])
    const other = writeManifestWith([dmgEntry], { ...versionInfo, version: '0.9.5' })
    expect(carryForwardArtifacts(other, versionInfo, [cliEntry.file])).toEqual([])
  })

  it('treats a missing or corrupt manifest as nothing to carry', () => {
    dir = mkdtempSync(join(tmpdir(), 'c3-carry-'))
    expect(carryForwardArtifacts(join(dir, 'nope.json'), versionInfo, [])).toEqual([])
    const bad = join(dir, 'manifest.json')
    writeFileSync(bad, '{not json')
    expect(carryForwardArtifacts(bad, versionInfo, [])).toEqual([])
  })
})

describe('binaryPathFor — the smoke gate needs the binary, not the package', () => {
  it('resolves the per-target binary rather than the archive named in the manifest', () => {
    // `artifacts[].file` has been the PACKAGE since manifest v1.2; feeding that to
    // the gate makes it try to execute a .tar.gz.
    expect(
      binaryPathFor('/dist', { target: 'macos-arm64', file: 'c3-v1-macos-arm64.tar.gz' }),
    ).toBe(join('/dist', 'macos-arm64', 'c3'))
  })

  it('keeps the .exe suffix on Windows', () => {
    expect(binaryPathFor('/dist', { target: 'windows-x64', file: 'c3-v1-windows-x64.zip' })).toBe(
      join('/dist', 'windows-x64', 'c3.exe'),
    )
  })
})

describe('cliChannel — the smoke gate only boots executables', () => {
  it('accepts CLI packages, including pre-channel entries', () => {
    expect(cliChannel({ file: 'c3-v0.9.6-macos-arm64.tar.gz', channel: 'cli' })).toBe(true)
    expect(cliChannel({ file: 'c3-v0.9.6-macos-arm64.tar.gz' })).toBe(true)
  })

  it('rejects desktop installers', () => {
    // Booting a .dmg / .msi and HTTP-probing it would fail on a perfectly good
    // artifact; the desktop equivalent is the install smoke, not this gate.
    for (const kind of ['dmg', 'app', 'msi', 'nsis', 'deb', 'appimage']) {
      expect(cliChannel({ file: `c3-desktop-v0.9.6-x.${kind}`, channel: 'desktop', kind })).toBe(
        false,
      )
    }
  })
})

describe('requiredChannel', () => {
  it('defaults to the cli channel so existing jobs keep their meaning', () => {
    expect(requiredChannel({})).toBe('cli')
    expect(requiredChannel({ C3_REQUIRED_CHANNEL: '' })).toBe('cli')
  })

  it('honours an explicit desktop gate', () => {
    expect(requiredChannel({ C3_REQUIRED_CHANNEL: 'desktop' })).toBe('desktop')
  })
})
