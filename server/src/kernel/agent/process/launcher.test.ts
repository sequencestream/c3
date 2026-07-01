import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HOST_BINARIES,
  lookupCommand,
  managedBinPath,
  parseVendorVersion,
  probeAll,
  resetProbeCache,
  resolveExecutable,
  satisfiesRange,
  selectNpmVersion,
  syncManagedVendorCli,
  vendorManifestPath,
} from './launcher.js'
import { setSettingsPath } from '../../config/index.js'
import { writeAtomic } from '../../config/store.js'

let dir = ''
const savedPath = process.env.PATH

function fakeBin(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `#!/bin/sh\necho "${text}"\n`, 'utf-8')
  chmodSync(path, 0o755)
}

function writeManifest(data: unknown): void {
  const path = vendorManifestPath(dir)
  mkdirSync(dirname(path), { recursive: true })
  writeAtomic(path, data)
}

beforeEach(() => {
  dir = join(tmpdir(), `c3-launcher-${process.pid}-${Date.now()}-${Math.random()}`)
  mkdirSync(dir, { recursive: true })
  setSettingsPath(join(dir, 'settings.json'))
  resetProbeCache()
  delete process.env.CLAUDE_PATH
  delete process.env.CODEX_PATH
})

afterEach(() => {
  process.env.PATH = savedPath
  delete process.env.CLAUDE_PATH
  delete process.env.CODEX_PATH
  resetProbeCache()
  rmSync(dir, { recursive: true, force: true })
})

describe('lookupCommand', () => {
  it('uses `where <binary>` on Windows (no `sh` there)', () => {
    expect(lookupCommand('codex', 'win32')).toEqual(['where', ['codex']])
  })

  it('uses portable `sh -c command -v <binary>` on POSIX', () => {
    expect(lookupCommand('claude', 'darwin')).toEqual(['sh', ['-c', 'command -v claude']])
  })
})

describe('vendor executable resolution', () => {
  it('honors a valid env override before managed CLI', () => {
    const override = join(dir, 'custom', 'claude')
    fakeBin(override, 'claude 1.2.3')
    fakeBin(managedBinPath('claude', '2.0.0', dir), 'claude 2.0.0')
    process.env.CLAUDE_PATH = override

    const result = resolveExecutable('claude')

    expect(result.source).toBe('env-override')
    expect(result.path).toBe(override)
    expect(result.version).toBe('1.2.3')
  })

  it('does not silently fall back when an env override is invalid', () => {
    process.env.CODEX_PATH = join(dir, 'missing-codex')
    fakeBin(managedBinPath('codex', '2.0.0', dir), 'codex 2.0.0')

    const result = resolveExecutable('codex')

    expect(result.source).toBe('override-invalid')
    expect(result.path).toBeNull()
    expect(result.error).toContain('CODEX_PATH invalid')
  })

  it('uses an installed managed CLI in a service-like empty PATH environment', () => {
    const path = managedBinPath('codex', '0.142.3', dir)
    fakeBin(path, 'codex 0.142.3')
    writeManifest({
      version: 1,
      vendors: {
        codex: {
          vendor: 'codex',
          source: 'managed',
          selectedVersion: '0.142.3',
          compatibleRange: HOST_BINARIES.codex.compatibleRange,
          path,
          versionHistory: [],
        },
      },
    })
    process.env.PATH = ''

    const result = resolveExecutable('codex')

    expect(result.source).toBe('managed')
    expect(result.path).toBe(path)
  })

  it('falls back to host PATH only after managed is unusable', () => {
    writeManifest({
      version: 1,
      vendors: {
        claude: {
          vendor: 'claude',
          source: 'managed',
          selectedVersion: '9.9.9',
          compatibleRange: HOST_BINARIES.claude.compatibleRange,
          path: managedBinPath('claude', '9.9.9', dir),
          versionHistory: [],
        },
      },
    })
    const hostDir = join(dir, 'host')
    fakeBin(join(hostDir, 'claude'), 'claude 1.0.0')
    process.env.PATH = `${hostDir}:/bin`

    const result = resolveExecutable('claude')

    expect(result.source).toBe('host-path-fallback')
    expect(result.managedError).toContain('managed claude 9.9.9 unusable')
  })
})

describe('npm package selection', () => {
  const packument = {
    'dist-tags': { stable: '1.2.0', latest: '1.3.0', 'darwin-arm64': '0.142.3' },
    versions: {
      '1.1.0': { version: '1.1.0', dist: { tarball: 't', integrity: 'i' } },
      '1.2.0': { version: '1.2.0', dist: { tarball: 't', integrity: 'i' } },
      '1.3.0': { version: '1.3.0', dist: { tarball: 't', integrity: 'i' } },
      '0.142.3': { version: '0.142.3', dist: { tarball: 't', integrity: 'i' } },
    },
  }

  it('selects Claude stable before latest when compatible', () => {
    expect(selectNpmVersion('claude', packument)).toEqual({ version: '1.2.0', sourceTag: 'stable' })
  })

  it('selects Codex platform dist-tag before latest', () => {
    expect(selectNpmVersion('codex', packument, undefined, 'darwin', 'arm64')).toEqual({
      version: '0.142.3',
      sourceTag: 'darwin-arm64',
    })
  })

  it('rejects a manual version outside the compatibility range', () => {
    expect(() => selectNpmVersion('codex', packument, '1000.0.0')).toThrow(/outside/)
  })
})

describe('version parsing and range checks', () => {
  it('parses vendor-specific version output', () => {
    expect(parseVendorVersion('claude', 'Claude Code 1.2.3')).toBe('1.2.3')
    expect(parseVendorVersion('codex', 'codex 0.142.3')).toBe('0.142.3')
    expect(parseVendorVersion('codex', 'random 0.142.3')).toBeNull()
  })

  it('checks simple compatible ranges', () => {
    expect(satisfiesRange('1.2.3', '>=1.0.0 <2.0.0')).toBe(true)
    expect(satisfiesRange('2.0.0', '>=1.0.0 <2.0.0')).toBe(false)
  })
})

describe('syncManagedVendorCli failure recovery', () => {
  it('installs a verified npm package into the managed vendor directory', async () => {
    const tarball = Buffer.from('fake tarball')
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
    const packument = {
      'dist-tags': { stable: '1.2.3' },
      versions: {
        '1.2.3': {
          version: '1.2.3',
          dist: { tarball: 'https://registry.example/claude.tgz', integrity },
        },
      },
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => packument })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () =>
          tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength),
      })

    const result = await syncManagedVendorCli('claude', {
      fetch: fetchMock as unknown as typeof fetch,
      unpack: (_archive, dest) => {
        const pkg = join(dest, 'package')
        mkdirSync(pkg, { recursive: true })
        writeFileSync(join(pkg, 'package.json'), '{"bin":{"claude":"cli/claude"}}', 'utf-8')
        fakeBin(join(pkg, 'cli', 'claude'), 'claude 1.2.3')
      },
    })

    expect(result.source).toBe('managed')
    expect(result.path).toBe(managedBinPath('claude', '1.2.3', dir))
    expect(result.version).toBe('1.2.3')
  })

  it('keeps an old selected managed version when the remote sync fails', async () => {
    const old = managedBinPath('claude', '1.0.0', dir)
    fakeBin(old, 'claude 1.0.0')
    writeManifest({
      version: 1,
      vendors: {
        claude: {
          vendor: 'claude',
          source: 'managed',
          selectedVersion: '1.0.0',
          compatibleRange: HOST_BINARIES.claude.compatibleRange,
          path: old,
          versionHistory: [],
        },
      },
    })
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503 }) as Response)

    const result = await syncManagedVendorCli('claude', { fetch: fetchMock })

    expect(result.source).toBe('managed')
    expect(result.path).toBe(old)
    expect(result.managedError).toContain('packument fetch failed')
  })
})

describe('probeAll', () => {
  it('covers every known vendor and carries each source', () => {
    const probes = probeAll()
    expect(probes.map((p) => p.vendor).sort()).toEqual(['claude', 'codex'])
    for (const p of probes) expect(p.source).toBeTruthy()
  })
})
