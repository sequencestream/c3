import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VendorId } from '../adapters/types.js'
import {
  HOST_BINARIES,
  applyVendorCliChoices,
  cleanManagedHistory,
  lookupCommand,
  managedBinPath,
  parseVendorVersion,
  probeAll,
  readVendorCliStatus,
  resetProbeCache,
  resolveExecutable,
  satisfiesRange,
  selectNpmVersion,
  syncManagedVendorCli,
  vendorManifestPath,
} from './launcher.js'
import { getVendorCliVersions, saveSettings, setSettingsPath } from '../../config/index.js'
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

  it('selects Claude latest before stable when compatible', () => {
    expect(selectNpmVersion('claude', packument)).toEqual({ version: '1.3.0', sourceTag: 'latest' })
  })

  it('selects Codex platform dist-tag before latest', () => {
    expect(selectNpmVersion('codex', packument, 'darwin', 'arm64')).toEqual({
      version: '0.142.3',
      sourceTag: 'darwin-arm64',
    })
  })
})

describe('version parsing and range checks', () => {
  it('parses vendor-specific version output', () => {
    expect(parseVendorVersion('claude', 'Claude Code 1.2.3')).toBe('1.2.3')
    expect(parseVendorVersion('claude', '2.1.195 (Claude Code)')).toBe('2.1.195')
    expect(parseVendorVersion('claude', '0.4.7 (claude code)')).toBe('0.4.7')
    expect(parseVendorVersion('claude', 'claude 3.0.0')).toBe('3.0.0')
    expect(parseVendorVersion('codex', 'codex 0.142.3')).toBe('0.142.3')
    expect(parseVendorVersion('codex', 'codex-cli 0.142.4')).toBe('0.142.4')
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

// Write a vendorCliVersions pin through the real saveSettings path so the
// settings cache (which getVendorCliVersions reads) reflects the choice — the
// same path the save_settings handler takes. Direct file writes would bypass
// the in-memory cache and leave getVendorCliVersions reading stale data.
function pinVendorCliVersion(vendor: VendorId, version: string | undefined): void {
  const existing = getVendorCliVersions()
  const next = { ...existing }
  if (version) next[vendor] = version
  else delete next[vendor]
  saveSettings({
    agents: [
      {
        id: 'system',
        vendor: 'claude',
        configMode: 'system',
        displayName: 'System',
        config: { baseUrl: '', apiKey: '', model: '' },
      },
    ],
    defaultAgentId: 'system',
    toolAgentId: '',
    intentAgentId: '',
    specAgentId: '',
    automationAgentId: '',
    sandboxDefaultAgentId: '',
    sandboxToolAgentId: '',
    sandboxIntentAgentId: '',
    sandboxSpecAgentId: '',
    sandboxAutomationAgentId: '',
    vendorCliVersions: next,
  })
}

describe('resolveExecutable effective-version priority chain', () => {
  it('prefers the vendorCliVersions choice when installed and compatible', () => {
    fakeBin(managedBinPath('claude', '1.0.0', dir), 'claude 1.0.0')
    fakeBin(managedBinPath('claude', '1.3.0', dir), 'claude 1.3.0')
    pinVendorCliVersion('claude', '1.0.0')
    writeManifest({
      version: 1,
      vendors: {
        claude: {
          vendor: 'claude',
          source: 'managed',
          selectedVersion: '1.0.0',
          latestCompatibleVersion: '1.3.0',
          compatibleRange: HOST_BINARIES.claude.compatibleRange,
          path: managedBinPath('claude', '1.0.0', dir),
          versionHistory: [
            {
              version: '1.0.0',
              status: 'installed',
              installedPath: managedBinPath('claude', '1.0.0', dir),
            },
            {
              version: '1.3.0',
              status: 'installed',
              installedPath: managedBinPath('claude', '1.3.0', dir),
            },
          ],
        },
      },
    })

    const result = resolveExecutable('claude')

    expect(result.source).toBe('managed')
    expect(result.expectedVersion).toBe('1.0.0')
    expect(result.path).toBe(managedBinPath('claude', '1.0.0', dir))
  })

  it('degrades to latestCompatibleVersion when the choice is missing and records lastError', () => {
    // Choice 1.0.0 dir does NOT exist (uninstalled); latest 1.3.0 is installed.
    fakeBin(managedBinPath('claude', '1.3.0', dir), 'claude 1.3.0')
    pinVendorCliVersion('claude', '1.0.0')
    writeManifest({
      version: 1,
      vendors: {
        claude: {
          vendor: 'claude',
          source: 'managed',
          selectedVersion: '1.0.0',
          latestCompatibleVersion: '1.3.0',
          compatibleRange: HOST_BINARIES.claude.compatibleRange,
          versionHistory: [{ version: '1.3.0', status: 'installed' }],
        },
      },
    })

    const result = resolveExecutable('claude')

    expect(result.source).toBe('managed')
    expect(result.expectedVersion).toBe('1.3.0')
    // lastError surfaces the degradation reason via the manifest status read.
    expect(readVendorCliStatus('claude').lastError).toContain('active 1.0.0')
    // The user's vendorCliVersions choice must NOT be rewritten.
    expect(getVendorCliVersions().claude).toBe('1.0.0')
  })

  it('auto-follows latestCompatibleVersion when no choice is set', () => {
    fakeBin(managedBinPath('claude', '1.3.0', dir), 'claude 1.3.0')
    pinVendorCliVersion('claude', undefined)
    writeManifest({
      version: 1,
      vendors: {
        claude: {
          vendor: 'claude',
          source: 'managed',
          latestCompatibleVersion: '1.3.0',
          compatibleRange: HOST_BINARIES.claude.compatibleRange,
          versionHistory: [{ version: '1.3.0', status: 'installed' }],
        },
      },
    })

    const result = resolveExecutable('claude')

    expect(result.source).toBe('managed')
    expect(result.expectedVersion).toBe('1.3.0')
  })
})

describe('syncManagedVendorCli download-target decoupling', () => {
  it('downloads the latest compatible version even when vendorCliVersions pins a history version', async () => {
    // Pin an installed history version as the effective choice.
    fakeBin(managedBinPath('claude', '1.0.0', dir), 'claude 1.0.0')
    pinVendorCliVersion('claude', '1.0.0')
    writeManifest({
      version: 1,
      vendors: {
        claude: {
          vendor: 'claude',
          source: 'managed',
          selectedVersion: '1.0.0',
          compatibleRange: HOST_BINARIES.claude.compatibleRange,
          path: managedBinPath('claude', '1.0.0', dir),
          versionHistory: [{ version: '1.0.0', status: 'installed' }],
        },
      },
    })
    // The latest 1.3.0 already downloaded (so sync takes the already-present path).
    fakeBin(managedBinPath('claude', '1.3.0', dir), 'claude 1.3.0')
    const packument = {
      'dist-tags': { latest: '1.3.0' },
      versions: {
        '1.0.0': { version: '1.0.0', dist: { tarball: 't', integrity: 'i' } },
        '1.3.0': { version: '1.3.0', dist: { tarball: 't', integrity: 'i' } },
      },
    }
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => packument }) as Response)

    await syncManagedVendorCli('claude', { fetch: fetchMock as unknown as typeof fetch })

    const status = readVendorCliStatus('claude')
    // Download target tracked the latest, NOT the pin.
    expect(status.downloadTargetVersion).toBe('1.3.0')
    // The user's effective choice is preserved (not overwritten to latest).
    expect(status.activeVersion).toBe('1.0.0')
    // The latest entered the installed history (selectable next time).
    expect(status.installedVersions.map((v) => v.version)).toContain('1.3.0')
  })
})

describe('applyVendorCliChoices (save_settings manifest sync)', () => {
  it('sets selectedVersion to an installed+compatible choice and clears lastError', () => {
    fakeBin(managedBinPath('claude', '1.2.0', dir), 'claude 1.2.0')
    writeManifest({
      version: 1,
      vendors: {
        claude: {
          vendor: 'claude',
          source: 'managed',
          latestCompatibleVersion: '1.3.0',
          lastError: 'prior error',
          compatibleRange: HOST_BINARIES.claude.compatibleRange,
          versionHistory: [{ version: '1.2.0', status: 'installed' }],
        },
      },
    })

    applyVendorCliChoices({ claude: '1.2.0' })

    const status = readVendorCliStatus('claude')
    expect(status.activeVersion).toBe('1.2.0')
    expect(status.lastError).toBeUndefined()
  })

  it('keeps an uninstalled choice and records lastError (does not clear)', () => {
    writeManifest({
      version: 1,
      vendors: {
        claude: {
          vendor: 'claude',
          source: 'managed',
          latestCompatibleVersion: '1.3.0',
          compatibleRange: HOST_BINARIES.claude.compatibleRange,
          versionHistory: [],
        },
      },
    })

    applyVendorCliChoices({ claude: '9.9.9' })

    const status = readVendorCliStatus('claude')
    expect(status.activeVersion).toBe('9.9.9')
    expect(status.lastError).toContain('9.9.9')
  })

  it('auto-follows latestCompatibleVersion when choice is empty', () => {
    writeManifest({
      version: 1,
      vendors: {
        claude: {
          vendor: 'claude',
          source: 'managed',
          selectedVersion: '1.0.0',
          latestCompatibleVersion: '1.3.0',
          compatibleRange: HOST_BINARIES.claude.compatibleRange,
          versionHistory: [],
        },
      },
    })

    applyVendorCliChoices({})

    expect(readVendorCliStatus('claude').activeVersion).toBe('1.3.0')
  })

  it('refreshes the probe cache so the next resolve reflects the new choice', () => {
    fakeBin(managedBinPath('claude', '1.2.0', dir), 'claude 1.2.0')
    fakeBin(managedBinPath('claude', '1.3.0', dir), 'claude 1.3.0')
    writeManifest({
      version: 1,
      vendors: {
        claude: {
          vendor: 'claude',
          source: 'managed',
          latestCompatibleVersion: '1.3.0',
          compatibleRange: HOST_BINARIES.claude.compatibleRange,
          versionHistory: [
            { version: '1.2.0', status: 'installed' },
            { version: '1.3.0', status: 'installed' },
          ],
        },
      },
    })
    // Prime the cache with the auto choice (1.3.0).
    pinVendorCliVersion('claude', '1.3.0')
    expect(resolveExecutable('claude').expectedVersion).toBe('1.3.0')

    // Simulate the save_settings flow: write the new choice to settings, then
    // applyVendorCliChoices (which resets the probe cache). The next resolve
    // must reflect 1.2.0, not the cached 1.3.0.
    pinVendorCliVersion('claude', '1.2.0')
    applyVendorCliChoices({ claude: '1.2.0' })
    expect(resolveExecutable('claude').expectedVersion).toBe('1.2.0')
  })
})

describe('cleanManagedHistory protects the effective choice', () => {
  it('does not delete the selectedVersion directory even when over the history limit', () => {
    const sel = managedBinPath('claude', '1.0.0', dir)
    fakeBin(sel, 'claude 1.0.0')
    pinVendorCliVersion('claude', '1.0.0')
    // Build a history past the limit; the selected 1.0.0 sits beyond HISTORY_LIMIT.
    const history = []
    for (let i = 0; i < 25; i++) history.push({ version: `0.0.${i}`, status: 'installed' })
    history.push({ version: '1.0.0', status: 'installed', installedPath: sel })
    writeManifest({
      version: 1,
      vendors: {
        claude: {
          vendor: 'claude',
          source: 'managed',
          selectedVersion: '1.0.0',
          compatibleRange: HOST_BINARIES.claude.compatibleRange,
          versionHistory: history,
        },
      },
    })

    cleanManagedHistory('claude')

    // The selected version dir survives.
    expect(existsSync(managedBinPath('claude', '1.0.0', dir))).toBe(true)
  })
})
