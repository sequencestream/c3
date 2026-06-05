/**
 * Unit coverage for the ProcessLauncher host-binary probe (ADR-0012).
 *
 * `lookupCommand` is the pure platform seam — testable without spawning. The
 * `resolve` path-override + caching behavior is testable by stubbing the env var
 * (no real `claude`/`codex`/`opencode` need be installed on the test host).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { HOST_BINARIES, lookupCommand, probeAll, resetProbeCache, resolve } from './launcher.js'

afterEach(() => {
  resetProbeCache()
  delete process.env.CLAUDE_PATH
  delete process.env.CODEX_PATH
  delete process.env.OPENCODE_PATH
})

describe('lookupCommand', () => {
  it('uses `where <binary>` on Windows (no `sh` there)', () => {
    expect(lookupCommand('codex', 'win32')).toEqual(['where', ['codex']])
  })

  it('uses portable `sh -c command -v <binary>` on POSIX', () => {
    expect(lookupCommand('claude', 'darwin')).toEqual(['sh', ['-c', 'command -v claude']])
    expect(lookupCommand('opencode', 'linux')).toEqual(['sh', ['-c', 'command -v opencode']])
  })
})

describe('HOST_BINARIES', () => {
  it('lists all three vendors with a non-empty install hint and a *_PATH override', () => {
    for (const vendor of ['claude', 'codex', 'opencode'] as const) {
      const spec = HOST_BINARIES[vendor]
      expect(spec.binary).toBe(vendor)
      expect(spec.pathEnv).toBe(`${vendor.toUpperCase()}_PATH`)
      expect(spec.installHint.length).toBeGreaterThan(0)
    }
  })
})

describe('resolve', () => {
  it('honors the *_PATH env override without probing PATH', () => {
    process.env.CODEX_PATH = '/opt/custom/codex'
    expect(resolve('codex')).toBe('/opt/custom/codex')
  })

  it('caches the override (env mutation after first resolve does not leak through)', () => {
    process.env.OPENCODE_PATH = '/first/opencode'
    expect(resolve('opencode')).toBe('/first/opencode')
    process.env.OPENCODE_PATH = '/second/opencode'
    // Cached from the first call — no re-read.
    expect(resolve('opencode')).toBe('/first/opencode')
  })

  it('returns null when the PATH probe finds nothing (no override, binary absent)', () => {
    // Deterministic miss regardless of what the test host has installed: point PATH
    // at `/bin` (which has `sh` so the probe command itself runs, but none of the
    // vendor CLIs), so `command -v` exits non-zero → null. Restored in afterEach via
    // the env cleanup; we save/restore PATH explicitly here.
    const savedPath = process.env.PATH
    process.env.PATH = '/bin'
    try {
      expect(resolve('claude')).toBeNull()
    } finally {
      process.env.PATH = savedPath
    }
  })
})

describe('probeAll', () => {
  it('covers every known vendor and carries each install hint', () => {
    const probes = probeAll()
    expect(probes.map((p) => p.vendor).sort()).toEqual(['claude', 'codex', 'opencode'])
    for (const p of probes) {
      expect(p.installHint).toBe(HOST_BINARIES[p.vendor].installHint)
    }
  })
})
