/**
 * arapuca Distribution Manager — Unit Tests
 *
 * Covers the three install paths the design hinges on:
 * - success: verified download → atomic `current` switch → resolvable binary
 * - failure: network/extract/activate errors leave NOTHING activated, retryable
 * - checksum mismatch: never extracted, never activated, existing install intact
 *
 * plus the trust rules of `resolveManagedArapuca` (dangling / escaping /
 * wrong-version `current` are all "absent") and the single-flight background
 * task (one download per process, no unhandled rejection).
 *
 * Everything runs against a temp managed root with an injected downloader — no
 * network, no real archive.
 *
 * @module
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'

// Anchor the managed root inside the test's temp dir — `ensureManagedArapuca`
// resolves it from c3 home, and no test may touch the real `~/.c3`.
const stub = vi.hoisted(() => ({ home: '' }))
vi.mock('../config/index.js', () => ({ c3HomeDir: () => stub.home }))

import {
  managedRootDir,
  ARAPUCA_VERSION,
  ArapucaInstallError,
  artifactForHost,
  enableArapucaAutoInstall,
  ensureManagedArapuca,
  installArapuca,
  pendingArapucaInstallForTests,
  resetArapucaDistForTests,
  resolveManagedArapuca,
  type ArapucaArtifact,
} from './arapuca-dist.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** Fake archive payload — the "downloaded bytes" the fake extractor unpacks. */
const PAYLOAD = '#!/bin/sh\necho arapuca-fake\n'
const PAYLOAD_SHA = createHash('sha256').update(Buffer.from(PAYLOAD)).digest('hex')

/** Temp c3 home; `root` is the managed arapuca root beneath it. */
let c3Home: string
let root: string
let art: ArapucaArtifact

/** A downloader that writes the fixed payload (no network). */
const okDownload = async (_url: string, dest: string) => {
  writeFileSync(dest, PAYLOAD)
}

/**
 * A fake extractor mirroring the upstream archive layout
 * (`arapuca-<version>/arapuca`), writing the payload as the binary.
 */
const okExtract = (archive: string, destDir: string) => {
  const inner = join(destDir, `arapuca-${ARAPUCA_VERSION}`)
  mkdirSync(inner, { recursive: true })
  writeFileSync(join(inner, 'arapuca'), readFileSync(archive))
}

beforeEach(() => {
  c3Home = mkdtempSync(join(tmpdir(), 'c3-arap-dist-'))
  stub.home = c3Home
  mkdirSync(managedRootDir(), { recursive: true })
  // Canonical (macOS temp dirs live behind the `/var` → `/private/var` firmlink),
  // so installer output and resolver output are directly comparable.
  root = realpathSync(managedRootDir())
  art = {
    version: ARAPUCA_VERSION,
    url: 'https://example.invalid/arapuca.tar.gz',
    sha256: PAYLOAD_SHA,
    binaryRelPath: join(`arapuca-${ARAPUCA_VERSION}`, 'arapuca'),
  }
  resetArapucaDistForTests()
})

afterEach(() => {
  rmSync(c3Home, { recursive: true, force: true })
  resetArapucaDistForTests()
  vi.restoreAllMocks()
})

// ─── Artifact table ──────────────────────────────────────────────────────────

describe('artifactForHost', () => {
  it('maps every platform c3 ships an arapuca build for', () => {
    for (const [platform, arch] of [
      ['darwin', 'arm64'],
      ['darwin', 'x64'],
      ['linux', 'x64'],
      ['linux', 'arm64'],
      ['win32', 'x64'],
    ] as const) {
      const a = artifactForHost(platform, arch)
      expect(a, `${platform}-${arch}`).not.toBeNull()
      expect(a!.version).toBe(ARAPUCA_VERSION)
      // A checksum is mandatory — an unpinned artifact must never be installable.
      expect(a!.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(a!.url).toContain(`v${ARAPUCA_VERSION}`)
    }
  })

  it('returns null for an unmapped platform (no near-match guessing)', () => {
    expect(artifactForHost('freebsd', 'x64')).toBeNull()
    expect(artifactForHost('linux', 'ppc64')).toBeNull()
  })
})

// ─── installArapuca: success ─────────────────────────────────────────────────

describe('installArapuca — verified success', () => {
  it('installs into <version>/ and switches current only after full verification', async () => {
    const bin = await installArapuca({
      root,
      artifact: art,
      download: okDownload,
      extract: okExtract,
    })
    expect(bin).toBe(join(root, ARAPUCA_VERSION, art.binaryRelPath))
    expect(existsSync(bin)).toBe(true)
    // `current` now resolves to the pinned version dir…
    expect(resolveManagedArapuca({ root, artifact: art })).toBe(bin)
    // …and no staging leftovers remain in the managed root.
    expect(readdirSync(root).filter((n) => n.startsWith('.install-'))).toEqual([])
    expect(readdirSync(root).filter((n) => n.startsWith('.current-'))).toEqual([])
  })

  it('is repeatable — a second install re-activates without corrupting the first', async () => {
    await installArapuca({ root, artifact: art, download: okDownload, extract: okExtract })
    const bin = await installArapuca({
      root,
      artifact: art,
      download: okDownload,
      extract: okExtract,
    })
    expect(resolveManagedArapuca({ root, artifact: art })).toBe(bin)
    expect(readFileSync(bin, 'utf-8')).toBe(PAYLOAD)
  })
})

// ─── installArapuca: failure ─────────────────────────────────────────────────

describe('installArapuca — failure paths', () => {
  it('does not activate anything when the download fails, and stays retryable', async () => {
    const failing = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(
      installArapuca({ root, artifact: art, download: failing, extract: okExtract }),
    ).rejects.toMatchObject({ reason: 'download-failed' })
    expect(resolveManagedArapuca({ root, artifact: art })).toBeNull()
    expect(existsSync(join(root, 'current'))).toBe(false)
    expect(readdirSync(root).filter((n) => n.startsWith('.install-'))).toEqual([])
    // A later attempt with a working downloader succeeds — no poisoned state.
    const bin = await installArapuca({
      root,
      artifact: art,
      download: okDownload,
      extract: okExtract,
    })
    expect(resolveManagedArapuca({ root, artifact: art })).toBe(bin)
  })

  it('does not activate when the archive lacks the expected executable', async () => {
    const emptyExtract = (_a: string, dest: string) => {
      mkdirSync(join(dest, 'unexpected-layout'), { recursive: true })
    }
    await expect(
      installArapuca({ root, artifact: art, download: okDownload, extract: emptyExtract }),
    ).rejects.toMatchObject({ reason: 'extract-failed' })
    expect(resolveManagedArapuca({ root, artifact: art })).toBeNull()
  })

  it('keeps the previously activated version when a later install fails', async () => {
    const good = await installArapuca({
      root,
      artifact: art,
      download: okDownload,
      extract: okExtract,
    })
    const failing = async () => {
      throw new Error('network down')
    }
    await expect(
      installArapuca({ root, artifact: art, download: failing, extract: okExtract }),
    ).rejects.toBeInstanceOf(ArapucaInstallError)
    // The old association is untouched and still usable.
    expect(resolveManagedArapuca({ root, artifact: art })).toBe(good)
  })
})

// ─── installArapuca: checksum ────────────────────────────────────────────────

describe('installArapuca — checksum mismatch', () => {
  it('never extracts and never activates a tampered archive', async () => {
    const extract = vi.fn(okExtract)
    const tampered: ArapucaArtifact = { ...art, sha256: 'f'.repeat(64) }
    await expect(
      installArapuca({ root, artifact: tampered, download: okDownload, extract }),
    ).rejects.toMatchObject({ reason: 'checksum-mismatch' })
    // The extractor was never reached — a forged tree can never exist on disk.
    expect(extract).not.toHaveBeenCalled()
    expect(existsSync(join(root, ARAPUCA_VERSION))).toBe(false)
    expect(resolveManagedArapuca({ root, artifact: art })).toBeNull()
  })

  it('does not disturb an existing valid install', async () => {
    const good = await installArapuca({
      root,
      artifact: art,
      download: okDownload,
      extract: okExtract,
    })
    const tampered: ArapucaArtifact = { ...art, sha256: '0'.repeat(64) }
    await expect(
      installArapuca({ root, artifact: tampered, download: okDownload, extract: okExtract }),
    ).rejects.toMatchObject({ reason: 'checksum-mismatch' })
    expect(resolveManagedArapuca({ root, artifact: art })).toBe(good)
    expect(readFileSync(good, 'utf-8')).toBe(PAYLOAD)
  })
})

// ─── resolveManagedArapuca: trust rules ──────────────────────────────────────

describe('resolveManagedArapuca — trust rules', () => {
  it('returns null when nothing is installed', () => {
    expect(resolveManagedArapuca({ root, artifact: art })).toBeNull()
  })

  it('treats a dangling current as absent', async () => {
    await installArapuca({ root, artifact: art, download: okDownload, extract: okExtract })
    rmSync(join(root, ARAPUCA_VERSION), { recursive: true, force: true })
    expect(resolveManagedArapuca({ root, artifact: art })).toBeNull()
  })

  it('refuses a current escaping the managed root', () => {
    if (process.platform === 'win32') return // junction semantics differ
    const outside = mkdtempSync(join(tmpdir(), 'c3-arap-outside-'))
    try {
      const inner = join(outside, `arapuca-${ARAPUCA_VERSION}`)
      mkdirSync(inner, { recursive: true })
      writeFileSync(join(inner, 'arapuca'), PAYLOAD, { mode: 0o755 })
      mkdirSync(root, { recursive: true })
      symlinkSync(outside, join(root, 'current'), 'dir')
      expect(resolveManagedArapuca({ root, artifact: art })).toBeNull()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses a current pointing at a version other than the pinned one', async () => {
    if (process.platform === 'win32') return
    await installArapuca({ root, artifact: art, download: okDownload, extract: okExtract })
    // Simulate a stale association written by an older c3 build.
    const stale = join(root, '0.0.1')
    mkdirSync(join(stale, `arapuca-${ARAPUCA_VERSION}`), { recursive: true })
    writeFileSync(join(stale, art.binaryRelPath), PAYLOAD, { mode: 0o755 })
    rmSync(join(root, 'current'), { force: true })
    symlinkSync('0.0.1', join(root, 'current'), 'dir')
    expect(resolveManagedArapuca({ root, artifact: art })).toBeNull()
  })

  it('returns null when c3 ships no artifact for the host', () => {
    expect(resolveManagedArapuca({ root, artifact: null })).toBeNull()
  })
})

// ─── ensureManagedArapuca: background single-flight ──────────────────────────

describe('ensureManagedArapuca', () => {
  it('stays inert until the composition root enables auto-install', () => {
    ensureManagedArapuca()
    expect(pendingArapucaInstallForTests()).toBeNull()
  })

  it('starts at most one install for concurrent callers and never rejects', async () => {
    // Unmapped host (no artifact) has nothing to install — the contract under
    // test doesn't apply there.
    if (!artifactForHost()) return
    // The managed root is the stubbed temp c3 home; installArapuca runs for
    // real with an injected failing transport — deterministic and offline.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    enableArapucaAutoInstall()
    const onInstalled = vi.fn()
    const download = vi.fn(async () => {
      throw new Error('offline')
    })
    ensureManagedArapuca({ onInstalled, download })
    const first = pendingArapucaInstallForTests()
    ensureManagedArapuca({ onInstalled, download })
    ensureManagedArapuca({ onInstalled, download })
    // All three callers share ONE task.
    expect(pendingArapucaInstallForTests()).toBe(first)
    if (first) {
      // Resolves (never rejects) — a failed install must not become an
      // unhandled rejection nor propagate into the probe.
      await expect(first).resolves.toBeUndefined()
    }
    // One task ⇒ one download attempt, not three.
    expect(download).toHaveBeenCalledTimes(1)
    expect(onInstalled).not.toHaveBeenCalled()
    expect(warn.mock.calls.join(' ')).toContain('falling back to host PATH')
    // The slot is cleared, so a later probe in this process can retry.
    expect(pendingArapucaInstallForTests()).toBeNull()
  })

  it('does not activate or notify when the fetched bytes fail the pinned checksum', async () => {
    if (!artifactForHost()) return
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    enableArapucaAutoInstall()
    const onInstalled = vi.fn()
    const extract = vi.fn(okExtract)
    // Bytes that are NOT the pinned artifact — the checksum gate must stop them
    // before extraction, and the caller must never be told a version landed.
    ensureManagedArapuca({
      onInstalled,
      extract,
      download: async (_url, dest) => {
        writeFileSync(dest, 'not-the-pinned-artifact')
      },
    })
    await pendingArapucaInstallForTests()
    expect(extract).not.toHaveBeenCalled()
    expect(onInstalled).not.toHaveBeenCalled()
    expect(resolveManagedArapuca()).toBeNull()
    expect(warn.mock.calls.join(' ')).toContain('checksum-mismatch')
  })
})
