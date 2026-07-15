/**
 * SandboxLauncher — Unit Tests (arapuca process-level isolation)
 *
 * Covers:
 * - resolvePaths: fixed allowances, extraMounts ro/rw, reserved-path overlap,
 *   denylist, non-existent skip
 * - probeArapuca: missing binary → hard-fail; present binary → ok
 * - createSandboxWrapper: writes an executable `arapuca run -v … -- <cli>` script
 *
 * @module
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  existsSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'

// c3HomeDir drives getSpecsBase — point it at a real temp dir so resolvePaths
// can create + canonicalize the specs root. `vi.hoisted` keeps the mutable
// holder available inside the hoisted mock factory.
const stub = vi.hoisted(() => ({ home: '' }))
vi.mock('../../kernel/config/index.js', () => ({
  getProjectSandbox: vi.fn(() => undefined),
  c3HomeDir: vi.fn(() => stub.home),
}))

import {
  resolvePaths,
  probeArapuca,
  createSandboxWrapper,
  resetArapucaProbeForTests,
  SandboxLaunchError,
} from './SandboxLauncher.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

let root: string
let workspaceRoot: string
let worktree: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'c3-sb-test-'))
  stub.home = join(root, '.c3')
  workspaceRoot = join(root, 'project')
  worktree = join(root, 'worktree')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(worktree, { recursive: true })
  resetArapucaProbeForTests()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  resetArapucaProbeForTests()
})

// ─── resolvePaths ────────────────────────────────────────────────────────────

describe('resolvePaths', () => {
  it('resolves the fixed allowances (workspace root, worktree, specs base)', () => {
    const paths = resolvePaths(workspaceRoot, worktree)
    expect(existsSync(paths.workspaceRoot)).toBe(true)
    expect(existsSync(paths.worktree)).toBe(true)
    // specsBase was created under the stubbed c3 home by resolvePaths.
    expect(existsSync(paths.specsBase)).toBe(true)
    expect(paths.extra).toEqual([])
  })

  it('defaults extraMounts to read-only, preserving an explicit rw', () => {
    const ro = join(root, 'cache')
    const rw = join(root, 'build')
    mkdirSync(ro)
    mkdirSync(rw)
    const paths = resolvePaths(workspaceRoot, worktree, [
      { path: ro },
      { path: rw, readonly: false },
    ])
    // resolvePaths canonicalizes (e.g. macOS /var → /private/var).
    expect(paths.extra).toEqual([
      { path: realpathSync(ro), readonly: true },
      { path: realpathSync(rw), readonly: false },
    ])
  })

  it('throws on an extraMount that overlaps a reserved path', () => {
    const inside = join(worktree, 'sub')
    mkdirSync(inside)
    expect(() => resolvePaths(workspaceRoot, worktree, [{ path: inside }])).toThrow(
      SandboxLaunchError,
    )
  })

  it('throws when an extraMount equals the worktree', () => {
    expect(() => resolvePaths(workspaceRoot, worktree, [{ path: worktree }])).toThrow(
      SandboxLaunchError,
    )
  })

  it('throws on an extraMount inside a denied directory (/etc)', () => {
    expect(() => resolvePaths(workspaceRoot, worktree, [{ path: '/etc' }])).toThrow(
      SandboxLaunchError,
    )
  })

  it('skips (does not throw) a non-existent extraMount', () => {
    const missing = join(root, 'nope')
    const paths = resolvePaths(workspaceRoot, worktree, [{ path: missing }])
    expect(paths.extra).toEqual([])
  })
})

// ─── probeArapuca ────────────────────────────────────────────────────────────

describe('probeArapuca', () => {
  const savedPath = process.env.PATH

  afterEach(() => {
    process.env.PATH = savedPath
    resetArapucaProbeForTests()
  })

  it('reports arapuca-missing when the binary is not on PATH', () => {
    process.env.PATH = ''
    resetArapucaProbeForTests()
    const result = probeArapuca()
    // On a supported platform an empty PATH yields a missing-binary hard-fail.
    expect(result.ok ? 'ok' : result.uiCode).toBe('arapuca-missing')
  })

  it('reports ok when an executable arapuca is on PATH', () => {
    if (process.platform === 'win32') return // PATHEXT/.exe resolution differs
    const binDir = join(root, 'bin')
    mkdirSync(binDir)
    const bin = join(binDir, 'arapuca')
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', 'utf-8')
    chmodSync(bin, 0o755)
    process.env.PATH = binDir
    resetArapucaProbeForTests()
    expect(probeArapuca()).toEqual({ ok: true, path: bin })
  })
})

// ─── createSandboxWrapper ────────────────────────────────────────────────────

describe('createSandboxWrapper', () => {
  it('writes an executable arapuca wrapper with ro/rw mount flags and the entry command', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'c3-sb-wrap-'))
    try {
      const paths = resolvePaths(workspaceRoot, worktree)
      const scriptPath = createSandboxWrapper(paths, 'claude', tmp)
      expect(existsSync(scriptPath)).toBe(true)
      expect(statSync(scriptPath).mode & 0o111).toBeGreaterThan(0)
      const script = readFileSync(scriptPath, 'utf-8')
      expect(script).toContain('exec arapuca run')
      expect(script).toContain(`${paths.workspaceRoot}:ro`)
      expect(script).toContain(`${paths.worktree}:rw`)
      expect(script).toContain(`${paths.specsBase}:rw`)
      expect(script).toContain(`-- 'claude' "$@"`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
