import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareVersions,
  decideAction,
  hostTarget,
  isSelfUpdatable,
  normalizeVersion,
  packageNameFor,
  replacePosix,
  replaceWindows,
  restartGuidance,
  runUpgrade,
  selectAssets,
  UPGRADE_EXIT,
  UpgradeError,
  type ReleaseAsset,
  type UpgradeIo,
} from './upgrade.js'
// Cross-consistency anchors + signing helpers from the release scripts. These are
// plain .mjs (no inline types); minimal `.d.mts` siblings declare the exports used
// here so the assertions stay typed and cannot silently drift from the binary copy.
import { packageName as scriptsPackageName } from '../../scripts/release/artifact-name.mjs'
import { hostTarget as scriptsHostTarget } from '../../scripts/release/targets.mjs'
import { generateKeypair, signContent } from '../../scripts/release/minisign.mjs'

// ── Pure: version comparison ────────────────────────────────────────────────

describe('compareVersions', () => {
  it('treats equal versions as 0 and normalizes a leading v', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
  })
  it('orders by numeric core', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBeGreaterThan(0)
    expect(compareVersions('1.2.3', '1.3.0')).toBeLessThan(0)
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0)
  })
  it('ranks a prerelease below the same core release', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.1')).toBeGreaterThan(0)
  })
  it('treats the dev marker as a prerelease below a real release', () => {
    expect(compareVersions('0.0.0-dev', '0.2.0')).toBeLessThan(0)
  })
})

describe('normalizeVersion', () => {
  it('strips a single leading v only', () => {
    expect(normalizeVersion('v1.2.3')).toBe('1.2.3')
    expect(normalizeVersion('1.2.3')).toBe('1.2.3')
  })
})

// ── Pure: platform mapping + cross-consistency with scripts/release ──────────

describe('hostTarget / packageNameFor', () => {
  const matrix: Array<[NodeJS.Platform, string]> = [
    ['darwin', 'arm64'],
    ['darwin', 'x64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
    ['win32', 'x64'],
  ]

  it.each(matrix)('maps %s/%s to the scripts/release target name', (platform, arch) => {
    const mine = hostTarget(platform, arch)
    expect(mine).toBe(scriptsHostTarget(platform, arch))
  })

  it.each(matrix)('builds the same package name as scripts/release for %s/%s', (platform, arch) => {
    const target = hostTarget(platform, arch)
    expect(packageNameFor('0.3.0', target)).toBe(scriptsPackageName('0.3.0', target))
  })

  it('uses .zip for windows and .tar.gz elsewhere', () => {
    expect(packageNameFor('1.0.0', 'windows-x64')).toBe('c3-v1.0.0-windows-x64.zip')
    expect(packageNameFor('1.0.0', 'macos-arm64')).toBe('c3-v1.0.0-macos-arm64.tar.gz')
  })
})

// ── Pure: asset selection ───────────────────────────────────────────────────

describe('selectAssets', () => {
  const assets: ReleaseAsset[] = [
    { name: 'c3-v1.0.0-macos-arm64.tar.gz', url: 'u/pkg' },
    { name: 'c3-v1.0.0-macos-arm64.tar.gz.minisig', url: 'u/sig' },
    { name: 'c3-v1.0.0-macos-arm64.tar.gz.sha256', url: 'u/sha' },
    { name: 'c3-v1.0.0-linux-x64.tar.gz', url: 'u/other' },
  ]

  it('selects the package and its sidecars by target', () => {
    const sel = selectAssets(assets, 'c3-v1.0.0-macos-arm64.tar.gz')
    expect(sel.pkgUrl).toBe('u/pkg')
    expect(sel.minisigUrl).toBe('u/sig')
    expect(sel.sha256Url).toBe('u/sha')
  })

  it('throws noArtifact when no package matches this platform (e.g. linux-arm64)', () => {
    try {
      selectAssets(assets, 'c3-v1.0.0-linux-arm64.tar.gz')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(UpgradeError)
      expect((e as UpgradeError).code).toBe(UPGRADE_EXIT.noArtifact)
    }
  })

  it('tolerates a missing .minisig at selection (rejected later by the trust gate)', () => {
    const sel = selectAssets(
      [{ name: 'c3-v1.0.0-macos-arm64.tar.gz', url: 'u/pkg' }],
      'c3-v1.0.0-macos-arm64.tar.gz',
    )
    expect(sel.minisigUrl).toBeUndefined()
  })
})

// ── Pure: decision + dev gate ───────────────────────────────────────────────

describe('decideAction', () => {
  it('returns update when latest is newer', () => {
    expect(decideAction({ current: '1.0.0', latest: '1.1.0' })).toBe('update')
  })
  it('returns up-to-date when equal without force', () => {
    expect(decideAction({ current: '1.0.0', latest: '1.0.0' })).toBe('up-to-date')
  })
  it('returns reinstall when equal with force', () => {
    expect(decideAction({ current: '1.0.0', latest: '1.0.0', force: true })).toBe('reinstall')
  })
  it('never downgrades, even with force', () => {
    expect(decideAction({ current: '2.0.0', latest: '1.0.0', force: true })).toBe('up-to-date')
  })
})

describe('isSelfUpdatable', () => {
  it('refuses the dev version', () => {
    expect(isSelfUpdatable('/usr/local/bin/c3', '0.0.0-dev').ok).toBe(false)
  })
  it('refuses an interpreter execPath', () => {
    expect(isSelfUpdatable('/usr/bin/node', '1.0.0').ok).toBe(false)
    expect(isSelfUpdatable('/opt/homebrew/bin/bun', '1.0.0').ok).toBe(false)
  })
  it('allows a compiled standalone binary', () => {
    expect(isSelfUpdatable('/usr/local/bin/c3', '1.0.0').ok).toBe(true)
  })
})

describe('restartGuidance', () => {
  it('points at c3 restart for a service', () => {
    const lines = restartGuidance({ service: true, daemonPid: null })
    expect(lines.join('\n')).toContain('c3 restart')
    expect(lines.join('\n')).toContain('OS service')
  })
  it('points at c3 restart for a daemon', () => {
    const lines = restartGuidance({ service: false, daemonPid: 4242 })
    expect(lines.join('\n')).toContain('c3 restart')
    expect(lines.join('\n')).toContain('4242')
  })
  it('tells a foreground session to rerun manually', () => {
    const lines = restartGuidance({ service: false, daemonPid: null })
    expect(lines.join('\n')).toContain('re-run c3')
    expect(lines.join('\n')).not.toContain('c3 restart')
  })
})

// ── Replace strategies (real fs in a temp dir) ──────────────────────────────

function realIo(overrides: Partial<UpgradeIo> = {}): UpgradeIo {
  const fs = {
    mkdtemp: (p: string) => mkdtempSync(join(tmpdir(), p)),
    writeFile: (path: string, data: Buffer) => writeFileSync(path, data),
    readFile: (path: string) => readFileSync(path),
    exists: (path: string) => {
      try {
        readFileSync(path)
        return true
      } catch {
        return false
      }
    },
    chmod: () => {},
    rename: (from: string, to: string) => {
      // emulate fs.renameSync via copy+unlink-free real rename
      const data = readFileSync(from)
      writeFileSync(to, data)
      rmSync(from, { force: true })
    },
    remove: (path: string) => rmSync(path, { recursive: true, force: true }),
    unpack: () => {},
    selfCheckVersion: () => 'ok',
  }
  return { ...fs, ...overrides }
}

describe('replacePosix', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'c3-replace-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('atomically replaces the target with the new binary bytes', () => {
    const target = join(dir, 'c3')
    const src = join(dir, 'new-c3')
    writeFileSync(target, Buffer.from('OLD'))
    writeFileSync(src, Buffer.from('NEW-v2'))
    replacePosix(realIo(), src, target)
    expect(readFileSync(target, 'utf-8')).toBe('NEW-v2')
  })

  it('keeps the original and surfaces replaceFailed when the self-check fails', () => {
    const target = join(dir, 'c3')
    const src = join(dir, 'new-c3')
    writeFileSync(target, Buffer.from('OLD'))
    writeFileSync(src, Buffer.from('NEW'))
    const io = realIo({
      selfCheckVersion: () => {
        throw new UpgradeError('boom', UPGRADE_EXIT.replaceFailed)
      },
    })
    expect(() => replacePosix(io, src, target)).toThrow(UpgradeError)
    expect(readFileSync(target, 'utf-8')).toBe('OLD') // original intact
  })
})

describe('replaceWindows', () => {
  it('renames the running exe to .old BEFORE writing the new one, then places the new exe', () => {
    const calls: string[] = []
    const store = new Map<string, Buffer>([
      ['C:\\c3.exe', Buffer.from('OLD')],
      ['src', Buffer.from('NEW-v2')],
    ])
    const io: UpgradeIo = {
      mkdtemp: () => 'tmp',
      writeFile: (path, data) => {
        // a running exe cannot be overwritten in place — fail if .old swap was skipped
        if (path === 'C:\\c3.exe' && store.has('C:\\c3.exe')) {
          throw new Error('EBUSY: cannot overwrite a running exe')
        }
        calls.push(`write ${path}`)
        store.set(path, data)
      },
      readFile: (path) => {
        const b = store.get(path)
        if (!b) throw new Error(`ENOENT ${path}`)
        return b
      },
      exists: (path) => store.has(path),
      chmod: () => {},
      rename: (from, to) => {
        calls.push(`rename ${from} -> ${to}`)
        const b = store.get(from)
        if (!b) throw new Error(`ENOENT ${from}`)
        store.set(to, b)
        store.delete(from)
      },
      remove: (path) => {
        store.delete(path)
      },
      unpack: () => {},
      selfCheckVersion: () => 'ok',
    }
    replaceWindows(io, 'src', 'C:\\c3.exe')
    // rename target -> .old happened first, then write of the new exe
    expect(calls[0]).toBe('rename C:\\c3.exe -> C:\\c3.exe.old')
    expect(calls).toContain('write C:\\c3.exe')
    expect(store.get('C:\\c3.exe')?.toString()).toBe('NEW-v2')
    expect(store.get('C:\\c3.exe.old')?.toString()).toBe('OLD') // placeholder kept for next-run cleanup
  })

  it('restores the original exe when the new one fails its self-check', () => {
    const store = new Map<string, Buffer>([
      ['C:\\c3.exe', Buffer.from('OLD')],
      ['src', Buffer.from('NEW')],
    ])
    const io: UpgradeIo = {
      mkdtemp: () => 'tmp',
      writeFile: (path, data) => store.set(path, data),
      readFile: (path) => {
        const b = store.get(path)
        if (!b) throw new Error(`ENOENT ${path}`)
        return b
      },
      exists: (path) => store.has(path),
      chmod: () => {},
      rename: (from, to) => {
        const b = store.get(from)
        if (!b) throw new Error(`ENOENT ${from}`)
        store.set(to, b)
        store.delete(from)
      },
      remove: (path) => store.delete(path),
      unpack: () => {},
      selfCheckVersion: () => {
        throw new UpgradeError('bad exe', UPGRADE_EXIT.replaceFailed)
      },
    }
    expect(() => replaceWindows(io, 'src', 'C:\\c3.exe')).toThrow(UpgradeError)
    expect(store.get('C:\\c3.exe')?.toString()).toBe('OLD') // restored
  })
})

// ── Orchestrator: runUpgrade with injected fetch / io ───────────────────────

interface FakeResponse {
  ok: boolean
  status: number
  headers: { get(k: string): string | null }
  json(): Promise<unknown>
  arrayBuffer(): Promise<ArrayBuffer>
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
  }
}

function bytesResponse(buf: Buffer, status = 200): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => ({}),
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  }
}

/** A signed release fixture: a fake package signed by a fresh test keypair. */
function signedRelease(version: string, target: string) {
  const kp = generateKeypair({ comment: 'test' })
  const pkgName = packageNameFor(version, target)
  const pkgBytes = Buffer.from(`fake-archive-${version}-${target}`)
  const sigText = signContent(pkgBytes, {
    seed: kp.seed,
    keyId: kp.keyId,
    trustedComment: `c3 release v${version} ${target}`,
    untrustedComment: `signed test`,
  })
  const sha256Line = `${createHash('sha256').update(pkgBytes).digest('hex')}  ${pkgName}\n`
  return { kp, pkgName, pkgBytes, sigText, sha256Line, target, version }
}

function releaseJson(version: string, pkgName: string) {
  return {
    tag_name: `v${version}`,
    assets: [
      { name: pkgName, browser_download_url: 'https://dl/pkg' },
      { name: `${pkgName}.minisig`, browser_download_url: 'https://dl/sig' },
      { name: `${pkgName}.sha256`, browser_download_url: 'https://dl/sha' },
    ],
  }
}

describe('runUpgrade --check', () => {
  it('returns updateAvailable (10) when a newer release exists and does not download', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('releases/latest'))
        return jsonResponse(releaseJson('2.0.0', 'c3-v2.0.0-macos-arm64.tar.gz'))
      throw new Error(`unexpected download in --check: ${url}`)
    })
    const log = vi.fn()
    const code = await runUpgrade(
      { check: true },
      {
        version: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        fetch: fetchFn as never,
        log,
        errlog: vi.fn(),
      },
    )
    expect(code).toBe(UPGRADE_EXIT.updateAvailable)
    expect(fetchFn).toHaveBeenCalledTimes(1) // queried only, no asset downloads
  })

  it('returns ok (0) when already up to date', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(releaseJson('1.0.0', 'c3-v1.0.0-macos-arm64.tar.gz')),
    )
    const code = await runUpgrade(
      { check: true },
      {
        version: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        fetch: fetchFn as never,
        log: vi.fn(),
        errlog: vi.fn(),
      },
    )
    expect(code).toBe(UPGRADE_EXIT.ok)
  })

  it('returns network error on a non-2xx API response', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({}, 503))
    const code = await runUpgrade(
      { check: true },
      { version: '1.0.0', fetch: fetchFn as never, log: vi.fn(), errlog: vi.fn() },
    )
    expect(code).toBe(UPGRADE_EXIT.network)
  })

  it('returns network error when fetch rejects (offline)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ENOTFOUND')
    })
    const code = await runUpgrade(
      { check: true },
      { version: '1.0.0', fetch: fetchFn as never, log: vi.fn(), errlog: vi.fn() },
    )
    expect(code).toBe(UPGRADE_EXIT.network)
  })
})

describe('runUpgrade (dev / source refusal)', () => {
  it('refuses to self-update under the dev version and never queries the network', async () => {
    const fetchFn = vi.fn()
    const errlog = vi.fn()
    const code = await runUpgrade(
      {},
      {
        version: '0.0.0-dev',
        execPath: '/repo/server/dist/cli.cjs',
        fetch: fetchFn as never,
        log: vi.fn(),
        errlog,
      },
    )
    expect(code).toBe(UPGRADE_EXIT.devRefused)
    expect(fetchFn).not.toHaveBeenCalled()
    expect(errlog.mock.calls.flat().join('\n')).toContain('git/pnpm')
  })

  it('refuses under an interpreter execPath', async () => {
    const code = await runUpgrade(
      {},
      {
        version: '1.0.0',
        execPath: '/usr/bin/node',
        fetch: vi.fn() as never,
        log: vi.fn(),
        errlog: vi.fn(),
      },
    )
    expect(code).toBe(UPGRADE_EXIT.devRefused)
  })
})

describe('runUpgrade (verification gate)', () => {
  it('rejects and never replaces when the signature does not verify', async () => {
    const fx = signedRelease('2.0.0', 'macos-arm64')
    // Tamper: serve a DIFFERENT public key than the one that signed it.
    const wrongKey = generateKeypair({ comment: 'attacker' }).publicKeyText
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('releases/latest')) return jsonResponse(releaseJson('2.0.0', fx.pkgName))
      if (url.endsWith('/sig')) return bytesResponse(Buffer.from(fx.sigText))
      if (url.endsWith('/sha')) return bytesResponse(Buffer.from(fx.sha256Line))
      return bytesResponse(fx.pkgBytes)
    })
    const replaceSpy = vi.fn()
    const io = realIo({
      mkdtemp: () => mkdtempSync(join(tmpdir(), 'c3-verify-')),
      rename: replaceSpy,
      unpack: () => {
        throw new Error('unpack must not run after a failed verify')
      },
    })
    const code = await runUpgrade(
      {},
      {
        version: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        execPath: '/usr/local/bin/c3',
        publicKeyText: wrongKey,
        fetch: fetchFn as never,
        io,
        log: vi.fn(),
        errlog: vi.fn(),
      },
    )
    expect(code).toBe(UPGRADE_EXIT.verifyFailed)
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('rejects when the .minisig sidecar is absent (no signature)', async () => {
    const fx = signedRelease('2.0.0', 'macos-arm64')
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes('releases/latest')) {
        return jsonResponse({
          tag_name: 'v2.0.0',
          assets: [{ name: fx.pkgName, browser_download_url: 'https://dl/pkg' }], // no .minisig
        })
      }
      return bytesResponse(fx.pkgBytes)
    })
    const code = await runUpgrade(
      {},
      {
        version: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        execPath: '/usr/local/bin/c3',
        publicKeyText: fx.kp.publicKeyText,
        fetch: fetchFn as never,
        io: realIo({ mkdtemp: () => mkdtempSync(join(tmpdir(), 'c3-nosig-')) }),
        log: vi.fn(),
        errlog: vi.fn(),
      },
    )
    expect(code).toBe(UPGRADE_EXIT.verifyFailed)
  })
})

describe('runUpgrade (unpack + success)', () => {
  function fetchFor(fx: ReturnType<typeof signedRelease>) {
    return vi.fn(async (url: string) => {
      if (url.includes('releases/latest')) return jsonResponse(releaseJson(fx.version, fx.pkgName))
      if (url.endsWith('/sig')) return bytesResponse(Buffer.from(fx.sigText))
      if (url.endsWith('/sha')) return bytesResponse(Buffer.from(fx.sha256Line))
      return bytesResponse(fx.pkgBytes)
    })
  }

  it('fails (unpackFailed) and keeps the binary when the inner binary name is wrong', async () => {
    const fx = signedRelease('2.0.0', 'macos-arm64')
    const installDir = mkdtempSync(join(tmpdir(), 'c3-install-'))
    const execPath = join(installDir, 'c3')
    writeFileSync(execPath, Buffer.from('OLD'))
    const io = realIo({
      mkdtemp: () => mkdtempSync(join(tmpdir(), 'c3-up-')),
      unpack: (_archive, destDir) => {
        // unpack the wrong-named binary
        writeFileSync(join(destDir, 'not-c3'), Buffer.from('NEW'))
      },
    })
    const code = await runUpgrade(
      {},
      {
        version: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        execPath,
        home: installDir,
        publicKeyText: fx.kp.publicKeyText,
        fetch: fetchFor(fx) as never,
        io,
        log: vi.fn(),
        errlog: vi.fn(),
      },
    )
    expect(code).toBe(UPGRADE_EXIT.unpackFailed)
    expect(readFileSync(execPath, 'utf-8')).toBe('OLD')
    rmSync(installDir, { recursive: true, force: true })
  })

  it('downloads, verifies, unpacks and atomically replaces the binary on success', async () => {
    const fx = signedRelease('2.0.0', 'macos-arm64')
    const installDir = mkdtempSync(join(tmpdir(), 'c3-install-'))
    const execPath = join(installDir, 'c3')
    writeFileSync(execPath, Buffer.from('OLD-v1'))
    const io = realIo({
      mkdtemp: () => mkdtempSync(join(tmpdir(), 'c3-up-')),
      rename: (from, to) => {
        const data = readFileSync(from)
        writeFileSync(to, data)
        rmSync(from, { force: true })
      },
      unpack: (_archive, destDir) => {
        writeFileSync(join(destDir, 'c3'), Buffer.from('NEW-v2-binary'))
      },
      selfCheckVersion: () => 'c3 2.0.0',
    })
    const log = vi.fn()
    const code = await runUpgrade(
      {},
      {
        version: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        execPath,
        home: installDir, // empty c3 home → no service/daemon detected → foreground hint
        publicKeyText: fx.kp.publicKeyText,
        fetch: fetchFor(fx) as never,
        io,
        log,
        errlog: vi.fn(),
      },
    )
    expect(code).toBe(UPGRADE_EXIT.ok)
    expect(readFileSync(execPath, 'utf-8')).toBe('NEW-v2-binary')
    expect(log.mock.calls.flat().join('\n')).toContain('installed 2.0.0')
    rmSync(installDir, { recursive: true, force: true })
  })

  it('--force reinstalls the same version', async () => {
    const fx = signedRelease('1.0.0', 'macos-arm64')
    const installDir = mkdtempSync(join(tmpdir(), 'c3-install-'))
    const execPath = join(installDir, 'c3')
    writeFileSync(execPath, Buffer.from('OLD'))
    const io = realIo({
      mkdtemp: () => mkdtempSync(join(tmpdir(), 'c3-up-')),
      rename: (from, to) => {
        writeFileSync(to, readFileSync(from))
        rmSync(from, { force: true })
      },
      unpack: (_a, destDir) => writeFileSync(join(destDir, 'c3'), Buffer.from('REINSTALLED')),
    })
    const code = await runUpgrade(
      { force: true },
      {
        version: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        execPath,
        home: installDir,
        publicKeyText: fx.kp.publicKeyText,
        fetch: fetchFor(fx) as never,
        io,
        log: vi.fn(),
        errlog: vi.fn(),
      },
    )
    expect(code).toBe(UPGRADE_EXIT.ok)
    expect(readFileSync(execPath, 'utf-8')).toBe('REINSTALLED')
    rmSync(installDir, { recursive: true, force: true })
  })

  it('without --force, the same version is a no-op (no download)', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(releaseJson('1.0.0', 'c3-v1.0.0-macos-arm64.tar.gz')),
    )
    const code = await runUpgrade(
      {},
      {
        version: '1.0.0',
        platform: 'darwin',
        arch: 'arm64',
        execPath: '/usr/local/bin/c3',
        fetch: fetchFn as never,
        log: vi.fn(),
        errlog: vi.fn(),
      },
    )
    expect(code).toBe(UPGRADE_EXIT.ok)
    expect(fetchFn).toHaveBeenCalledTimes(1) // only the version query
  })

  it('fails noArtifact when this platform has no published package', async () => {
    const fetchFn = vi.fn(async () =>
      jsonResponse(releaseJson('2.0.0', 'c3-v2.0.0-macos-arm64.tar.gz')),
    )
    const code = await runUpgrade(
      {},
      {
        version: '1.0.0',
        platform: 'linux',
        arch: 'arm64', // linux-arm64 is unpublished
        execPath: '/usr/local/bin/c3',
        fetch: fetchFn as never,
        log: vi.fn(),
        errlog: vi.fn(),
      },
    )
    expect(code).toBe(UPGRADE_EXIT.noArtifact)
  })
})
