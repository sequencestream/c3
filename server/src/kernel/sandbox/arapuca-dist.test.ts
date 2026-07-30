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
  ARAPUCA_INSTALL_RETRY_INTERVAL_MS,
  ARAPUCA_VERSION,
  ArapucaInstallError,
  artifactForHost,
  enableArapucaAutoInstall,
  ensureManagedArapuca,
  installArapuca,
  pendingArapucaInstallForTests,
  resetArapucaDistForTests,
  resolveManagedArapuca,
  shouldAttemptArapucaInstall,
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

/** The persisted attempt stamp (epoch ms), or null when there is no usable one. */
const attemptStamp = (): number | null => {
  try {
    const raw = readFileSync(join(root, 'install-state.json'), 'utf-8')
    const at = (JSON.parse(raw) as { lastInstallAttemptAt?: string }).lastInstallAttemptAt
    return at ? Date.parse(at) : null
  } catch {
    return null
  }
}

/** Write a raw cooldown state file (valid or deliberately corrupt). */
const writeAttemptState = (body: string): void => {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'install-state.json'), body)
}

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

// ─── 24h install-attempt cooldown ────────────────────────────────────────────

describe('shouldAttemptArapucaInstall', () => {
  const T0 = Date.parse('2026-07-30T00:00:00.000Z')

  it('allows an attempt when nothing was ever recorded', () => {
    expect(shouldAttemptArapucaInstall(root, T0)).toBe(true)
  })

  it('suppresses an attempt inside the window and allows it once the window closes', () => {
    writeAttemptState(`{"version":1,"lastInstallAttemptAt":"${new Date(T0).toISOString()}"}`)
    expect(shouldAttemptArapucaInstall(root, T0)).toBe(false)
    expect(shouldAttemptArapucaInstall(root, T0 + ARAPUCA_INSTALL_RETRY_INTERVAL_MS - 1)).toBe(
      false,
    )
    // The boundary itself is inclusive — exactly 24h old is retryable.
    expect(shouldAttemptArapucaInstall(root, T0 + ARAPUCA_INSTALL_RETRY_INTERVAL_MS)).toBe(true)
    expect(shouldAttemptArapucaInstall(root, T0 + 5 * ARAPUCA_INSTALL_RETRY_INTERVAL_MS)).toBe(true)
  })

  it('treats a corrupt or unusable record as "no record" rather than a permanent block', () => {
    for (const body of [
      'not json at all',
      '{"version":1}',
      '{"version":1,"lastInstallAttemptAt":"never"}',
      // A bare number would `Date.parse` as the year 2042 if it were trusted.
      '{"version":1,"lastInstallAttemptAt":42}',
    ]) {
      writeAttemptState(body)
      expect(shouldAttemptArapucaInstall(root, T0), body).toBe(true)
    }
  })
})

describe('ensureManagedArapuca — install cooldown', () => {
  const T0 = Date.parse('2026-07-30T00:00:00.000Z')

  /** Silence the module's own logging and hand back the spies for assertions. */
  const quiet = () => ({
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  })

  it('stamps the attempt before downloading, on the success path', async () => {
    quiet()
    enableArapucaAutoInstall()
    const onInstalled = vi.fn()
    const download = vi.fn(async (_url: string, dest: string) => {
      // The stamp is already on disk while the bytes are still moving, so a
      // crash mid-download cannot escape the cooldown.
      expect(attemptStamp()).toBe(T0)
      writeFileSync(dest, PAYLOAD)
    })
    // The fixture artifact makes a REAL success reachable offline (the pinned
    // host artifact's checksum could never match the fake payload).
    ensureManagedArapuca({
      artifact: art,
      onInstalled,
      download,
      extract: okExtract,
      now: () => T0,
    })
    await pendingArapucaInstallForTests()
    expect(download).toHaveBeenCalledTimes(1)
    expect(onInstalled).toHaveBeenCalledTimes(1)
    expect(resolveManagedArapuca({ root, artifact: art })).not.toBeNull()
    // Success does not re-stamp: the baseline stays the task's start time.
    expect(attemptStamp()).toBe(T0)
    // …and the fresh window suppresses the next attempt.
    ensureManagedArapuca({ artifact: art, download, extract: okExtract, now: () => T0 + 60_000 })
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('stamps the attempt on the failure path too', async () => {
    quiet()
    enableArapucaAutoInstall()
    const download = vi.fn(async () => {
      throw new Error('offline')
    })
    ensureManagedArapuca({ artifact: art, download, now: () => T0 })
    await pendingArapucaInstallForTests()
    expect(download).toHaveBeenCalledTimes(1)
    expect(resolveManagedArapuca()).toBeNull()
    expect(attemptStamp()).toBe(T0)
  })

  it('skips the install — silently — while the window is open', async () => {
    const { log, warn } = quiet()
    enableArapucaAutoInstall()
    const download = vi.fn(async () => {
      throw new Error('offline')
    })
    ensureManagedArapuca({ artifact: art, download, now: () => T0 })
    await pendingArapucaInstallForTests()
    log.mockClear()
    warn.mockClear()
    // A later probe, still inside the window: no task, no download, no log noise.
    ensureManagedArapuca({ artifact: art, download, now: () => T0 + 60_000 })
    ensureManagedArapuca({
      artifact: art,
      download,
      now: () => T0 + ARAPUCA_INSTALL_RETRY_INTERVAL_MS - 1,
    })
    expect(pendingArapucaInstallForTests()).toBeNull()
    expect(download).toHaveBeenCalledTimes(1)
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    // …and the skip did not move the baseline forward.
    expect(attemptStamp()).toBe(T0)
  })

  it('retries once the window has closed, and re-arms the cooldown', async () => {
    quiet()
    enableArapucaAutoInstall()
    const download = vi.fn(async () => {
      throw new Error('offline')
    })
    ensureManagedArapuca({ artifact: art, download, now: () => T0 })
    await pendingArapucaInstallForTests()
    const T1 = T0 + ARAPUCA_INSTALL_RETRY_INTERVAL_MS
    ensureManagedArapuca({ artifact: art, download, now: () => T1 })
    await pendingArapucaInstallForTests()
    expect(download).toHaveBeenCalledTimes(2)
    expect(attemptStamp()).toBe(T1)
    // The second attempt started its own 24h window.
    ensureManagedArapuca({ artifact: art, download, now: () => T1 + 60_000 })
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('holds the cooldown across a process restart', async () => {
    quiet()
    enableArapucaAutoInstall()
    const download = vi.fn(async () => {
      throw new Error('offline')
    })
    ensureManagedArapuca({ artifact: art, download, now: () => T0 })
    await pendingArapucaInstallForTests()
    // Drop ALL in-memory state — the same starting point a fresh process has.
    resetArapucaDistForTests()
    enableArapucaAutoInstall()
    ensureManagedArapuca({ artifact: art, download, now: () => T0 + 12 * 60 * 60 * 1000 })
    expect(pendingArapucaInstallForTests()).toBeNull()
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('stamps once for concurrent callers sharing the single-flight task', async () => {
    quiet()
    enableArapucaAutoInstall()
    const download = vi.fn(async () => {
      throw new Error('offline')
    })
    ensureManagedArapuca({ artifact: art, download, now: () => T0 })
    // Callers that arrive while the task runs are absorbed by the single-flight
    // slot and must not push the baseline forward with their own clock.
    ensureManagedArapuca({ artifact: art, download, now: () => T0 + 1_000 })
    ensureManagedArapuca({ artifact: art, download, now: () => T0 + 2_000 })
    await pendingArapucaInstallForTests()
    expect(download).toHaveBeenCalledTimes(1)
    expect(attemptStamp()).toBe(T0)
  })

  it('warns but still installs when the attempt stamp cannot be persisted', async () => {
    if (process.platform === 'win32') return // rename-over-directory semantics differ
    const { warn } = quiet()
    enableArapucaAutoInstall()
    // A directory where the state file belongs: the atomic write's final rename
    // fails, and reading it back yields nothing usable.
    mkdirSync(join(root, 'install-state.json', 'blocker'), { recursive: true })
    const download = vi.fn(okDownload)
    ensureManagedArapuca({ artifact: art, download, extract: okExtract, now: () => T0 })
    await pendingArapucaInstallForTests()
    // The run is never blocked: the install proceeded and the binary landed.
    expect(download).toHaveBeenCalledTimes(1)
    expect(resolveManagedArapuca({ root, artifact: art })).not.toBeNull()
    expect(warn.mock.calls.join(' ')).toContain('24h retry cooldown')
    // Cooldown is genuinely lost (not silently faked) — a later probe retries.
    expect(shouldAttemptArapucaInstall(root, T0 + 60_000)).toBe(true)
  })
})
