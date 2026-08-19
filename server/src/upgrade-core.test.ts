import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import {
  UPGRADE_EXIT,
  UpgradeError,
  compareVersions,
  decideAction,
  downloadStreamed,
  normalizeVersion,
  parseManifest,
  parseSha256Line,
  selectDesktopArtifact,
  sha256Hex,
  verifyDoubleChecksum,
  verifySha256,
  type ReleaseManifest,
} from './upgrade-core.js'

const hex = (data: string) => createHash('sha256').update(data).digest('hex')

function makeManifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  return {
    schema: 'c3-release-manifest/v1.3',
    version: '0.2.0',
    artifacts: [
      {
        target: 'macos-arm64',
        platform: 'macos',
        arch: 'arm64',
        channel: 'desktop',
        kind: 'dmg',
        file: 'c3-desktop-v0.2.0-macos-arm64.dmg',
        bytes: 1234,
        sha256: hex('dmg'),
      },
      {
        target: 'linux-x64',
        platform: 'linux',
        arch: 'x64',
        channel: 'desktop',
        kind: 'deb',
        file: 'c3-desktop-v0.2.0-linux-x64.deb',
        bytes: 5678,
        sha256: hex('deb'),
      },
    ],
    ...overrides,
  }
}

// ── Pure: version facts ─────────────────────────────────────────────────────

describe('compareVersions / decideAction (shared kernel)', () => {
  it('treats equal versions as 0 and normalizes a leading v', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
  })
  it('orders by numeric core and ranks prereleases below the same core', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
  })
  it('never downgrades, and force only permits a same-version reinstall', () => {
    expect(decideAction({ current: '0.2.0', latest: '0.1.0' })).toBe('up-to-date')
    expect(decideAction({ current: '0.2.0', latest: '0.2.0', force: true })).toBe('reinstall')
    expect(decideAction({ current: '0.1.0', latest: '0.2.0' })).toBe('update')
  })
  it('normalizes a leading v only', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3')
    expect(normalizeVersion('1.2.3')).toBe('1.2.3')
  })
})

// ── Manifest parsing ────────────────────────────────────────────────────────

describe('parseManifest', () => {
  it('parses a valid v1.3 manifest', () => {
    const parsed = parseManifest(makeManifest())
    expect(parsed.schema).toBe('c3-release-manifest/v1.3')
    expect(parsed.artifacts).toHaveLength(2)
    expect(parsed.artifacts[0].file).toBe('c3-desktop-v0.2.0-macos-arm64.dmg')
  })

  it('rejects an unknown schema family', () => {
    try {
      parseManifest({ ...makeManifest(), schema: 'something-else/v9' })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(UpgradeError)
      expect((e as UpgradeError).code).toBe(UPGRADE_EXIT.verifyFailed)
    }
  })

  it('rejects a missing version', () => {
    try {
      parseManifest({ ...makeManifest(), version: '' })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as UpgradeError).code).toBe(UPGRADE_EXIT.verifyFailed)
    }
  })

  it('rejects an artifact missing the integrity trio (file/bytes/sha256)', () => {
    const bad = makeManifest()
    bad.artifacts = [{ ...bad.artifacts[0], sha256: 'not-a-hash' }]
    try {
      parseManifest(bad)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as UpgradeError).code).toBe(UPGRADE_EXIT.verifyFailed)
    }
  })
})

// ── Desktop channel selection ───────────────────────────────────────────────

describe('selectDesktopArtifact', () => {
  const opts = { platform: 'macos', arch: 'arm64', version: '0.2.0' }

  it('selects the single desktop artifact for the platform/arch', () => {
    const picked = selectDesktopArtifact(makeManifest(), opts)
    expect(picked.file).toBe('c3-desktop-v0.2.0-macos-arm64.dmg')
  })

  it('picks the publish-preferred kind when several candidates exist', () => {
    const manifest = makeManifest()
    manifest.artifacts.push({
      target: 'macos-arm64',
      platform: 'macos',
      arch: 'arm64',
      channel: 'desktop',
      kind: 'app',
      file: 'c3-desktop-v0.2.0-macos-arm64.app.tar.gz',
      bytes: 999,
      sha256: hex('app'),
    })
    manifest.artifacts[1] = { ...manifest.artifacts[1], preferred: true }
    // After push, indexes shift: re-add preferred on the first dmg entry.
    manifest.artifacts[0] = { ...manifest.artifacts[0], preferred: true }
    const picked = selectDesktopArtifact(manifest, opts)
    expect(picked.kind).toBe('dmg')
    expect(picked.preferred).toBe(true)
  })

  it('rejects when the manifest version does not match the target release', () => {
    try {
      selectDesktopArtifact(makeManifest({ version: '0.9.9' }), opts)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as UpgradeError).code).toBe(UPGRADE_EXIT.noArtifact)
    }
  })

  it('rejects a zero-candidate platform (no desktop build for it)', () => {
    try {
      selectDesktopArtifact(makeManifest(), { platform: 'windows', arch: 'x64', version: '0.2.0' })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as UpgradeError).code).toBe(UPGRADE_EXIT.noArtifact)
    }
  })

  it('refuses to guess when several candidates exist without a unique preferred', () => {
    const manifest = makeManifest()
    manifest.artifacts.push({
      target: 'macos-arm64',
      platform: 'macos',
      arch: 'arm64',
      channel: 'desktop',
      kind: 'app',
      file: 'c3-desktop-v0.2.0-macos-arm64.app.tar.gz',
      bytes: 999,
      sha256: hex('app'),
    })
    try {
      selectDesktopArtifact(manifest, opts)
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as UpgradeError).code).toBe(UPGRADE_EXIT.noArtifact)
    }
  })

  it('never falls back to a CLI-channel artifact', () => {
    const manifest = makeManifest()
    manifest.artifacts.push({
      target: 'macos-arm64',
      platform: 'macos',
      arch: 'arm64',
      channel: 'cli',
      file: 'c3-cli-v0.2.0-macos-arm64.tar.gz',
      bytes: 777,
      sha256: hex('cli'),
    })
    const picked = selectDesktopArtifact(manifest, opts)
    expect(picked.channel).toBe('desktop')
  })
})

// ── Double checksum verification ───────────────────────────────────────────

describe('verifyDoubleChecksum', () => {
  it('accepts when the manifest sha256 and the .sha256 sidecar both match', () => {
    const data = Buffer.from('payload')
    const expected = hex('payload')
    expect(() =>
      verifyDoubleChecksum({
        data,
        manifestSha256: expected,
        sidecarLine: `${expected}  c3-desktop.pkg`,
      }),
    ).not.toThrow()
  })

  it('fails when the manifest sha256 does not match', () => {
    try {
      verifyDoubleChecksum({
        data: Buffer.from('payload'),
        manifestSha256: hex('other'),
        sidecarLine: `${hex('payload')}  pkg`,
      })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as UpgradeError).code).toBe(UPGRADE_EXIT.verifyFailed)
    }
  })

  it('fails closed when the .sha256 sidecar is missing or malformed', () => {
    try {
      verifyDoubleChecksum({
        data: Buffer.from('payload'),
        manifestSha256: hex('payload'),
        sidecarLine: null,
      })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as UpgradeError).code).toBe(UPGRADE_EXIT.verifyFailed)
    }
  })

  it('fails when the .sha256 sidecar disagrees with the manifest', () => {
    try {
      verifyDoubleChecksum({
        data: Buffer.from('payload'),
        manifestSha256: hex('payload'),
        sidecarLine: `${hex('tampered')}  pkg`,
      })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as UpgradeError).code).toBe(UPGRADE_EXIT.verifyFailed)
    }
  })
})

// ── sha256 helpers ──────────────────────────────────────────────────────────

describe('sha256 helpers', () => {
  it('computes the same digest as node:crypto', () => {
    expect(sha256Hex(Buffer.from('abc'))).toBe(createHash('sha256').update('abc').digest('hex'))
  })
  it('parses the leading hex token of a sidecar line', () => {
    expect(parseSha256Line(`${hex('x')}  file`)).toBe(hex('x'))
    expect(parseSha256Line('not a hash')).toBeNull()
    expect(parseSha256Line('')).toBeNull()
  })
  it('compares hex case-insensitively', () => {
    expect(verifySha256('ABC', 'abc')).toBe(true)
  })
})

// ── Streamed download ───────────────────────────────────────────────────────

describe('downloadStreamed', () => {
  const body = Buffer.from('c3-package-bytes'.repeat(32))
  const expectedSha = createHash('sha256').update(body).digest('hex')

  function ok(): Response {
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: { 'content-length': String(body.length) },
    })
  }

  function sink() {
    const chunks: Buffer[] = []
    const progress: Array<[number, number]> = []
    return {
      chunks,
      progress,
      write: (c: Uint8Array) => {
        chunks.push(Buffer.from(c))
      },
      onProgress: (received: number, total: number) => {
        progress.push([received, total])
      },
    }
  }

  it('hands every byte to the sink and hashes exactly what it wrote', async () => {
    const s = sink()
    const result = await downloadStreamed('https://x/pkg', async () => ok(), {}, s)
    expect(Buffer.concat(s.chunks).equals(body)).toBe(true)
    expect(result.sha256).toBe(expectedSha)
    expect(result.receivedBytes).toBe(body.length)
    expect(result.totalBytes).toBe(body.length)
    expect(s.progress.at(-1)).toEqual([body.length, body.length])
  })

  it('falls back to the received size when the server omits content-length', async () => {
    const s = sink()
    const noLength = async () => new Response(new Uint8Array(body), { status: 200 })
    const result = await downloadStreamed('https://x/pkg', noLength, {}, s)
    // A caller cannot compute a percentage from a total it was never told, so the
    // in-flight total stays 0 and only the final figure is filled in.
    expect(s.progress.every(([, total]) => total === 0)).toBe(true)
    expect(result.totalBytes).toBe(body.length)
  })

  it('throws so a cancelled transfer can never look like a complete one', async () => {
    const s = sink()
    await expect(
      downloadStreamed('https://x/pkg', async () => ok(), {}, { ...s, shouldAbort: () => true }),
    ).rejects.toThrow(/cancelled/)
  })

  it('maps a non-2xx and a transport error to the network code', async () => {
    const s = sink()
    for (const fetchImpl of [
      async () => new Response(null, { status: 502 }),
      async () => {
        throw new Error('ECONNRESET')
      },
    ]) {
      try {
        await downloadStreamed('https://x/pkg', fetchImpl as typeof fetch, {}, s)
        throw new Error('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(UpgradeError)
        expect((e as UpgradeError).code).toBe(UPGRADE_EXIT.network)
      }
    }
  })

  it('surfaces a sink write failure as an interrupted download, not a success', async () => {
    const failing = {
      write: vi.fn(() => {
        throw new Error('ENOSPC')
      }),
    }
    await expect(downloadStreamed('https://x/pkg', async () => ok(), {}, failing)).rejects.toThrow(
      /ENOSPC/,
    )
  })
})
