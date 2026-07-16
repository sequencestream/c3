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
  launchSandbox,
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
  it('resolves the fixed allowances (execution root, workspace root ro, specs base)', () => {
    const paths = resolvePaths(workspaceRoot, worktree)
    expect(existsSync(paths.executionRoot)).toBe(true)
    // A worktree run keeps the distinct source workspace root (read-only).
    expect(paths.workspaceRoot).toBeDefined()
    expect(existsSync(paths.workspaceRoot!)).toBe(true)
    expect(paths.executionRoot).toBe(realpathSync(worktree))
    // specsBase was created under the stubbed c3 home by resolvePaths.
    expect(existsSync(paths.specsBase)).toBe(true)
    // The persistent per-workspace CODEX_HOME is created + canonicalized too, and
    // lives under the stubbed c3 home (outside the execution root) so it survives
    // per-run cleanup for codex `resume`.
    expect(existsSync(paths.codexHome)).toBe(true)
    expect(paths.codexHome.startsWith(realpathSync(stub.home))).toBe(true)
    expect(paths.extra).toEqual([])
  })

  it('merges workspace root into the single rw execution grant when they are the same path (current-branch)', () => {
    // A current-branch run's execution root IS the workspace: no separate ro
    // workspace-root entry, so arapuca never gets a conflicting ro/rw pair.
    const paths = resolvePaths(workspaceRoot, workspaceRoot)
    expect(paths.executionRoot).toBe(realpathSync(workspaceRoot))
    expect(paths.workspaceRoot).toBeUndefined()
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
  const savedCodexSandbox = process.env.CODEX_SANDBOX
  const savedAppSandbox = process.env.APP_SANDBOX_CONTAINER_ID

  afterEach(() => {
    process.env.PATH = savedPath
    if (savedCodexSandbox === undefined) delete process.env.CODEX_SANDBOX
    else process.env.CODEX_SANDBOX = savedCodexSandbox
    if (savedAppSandbox === undefined) delete process.env.APP_SANDBOX_CONTAINER_ID
    else process.env.APP_SANDBOX_CONTAINER_ID = savedAppSandbox
    resetArapucaProbeForTests()
  })

  it('reports arapuca-missing when the binary is not on PATH', () => {
    delete process.env.CODEX_SANDBOX
    delete process.env.APP_SANDBOX_CONTAINER_ID
    process.env.PATH = ''
    resetArapucaProbeForTests()
    const result = probeArapuca()
    // On a supported platform an empty PATH yields a missing-binary hard-fail.
    expect(result.ok ? 'ok' : result.uiCode).toBe('arapuca-missing')
  })

  it('reports ok when an executable arapuca is on PATH', () => {
    if (process.platform === 'win32') return // PATHEXT/.exe resolution differs
    delete process.env.CODEX_SANDBOX
    delete process.env.APP_SANDBOX_CONTAINER_ID
    const binDir = join(root, 'bin')
    mkdirSync(binDir)
    const bin = join(binDir, 'arapuca')
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', 'utf-8')
    chmodSync(bin, 0o755)
    process.env.PATH = binDir
    resetArapucaProbeForTests()
    expect(probeArapuca()).toEqual({ ok: true, path: bin })
    const sandbox = launchSandbox(workspaceRoot, worktree)
    try {
      expect(sandbox.tmpDir.startsWith(`${realpathSync(worktree)}/.c3-sb-`)).toBe(true)
      // The per-run temp dir holds only the wrapper — no codex home under it. The
      // persistent CODEX_HOME lives outside (under c3 home) and survives cleanup.
      expect(existsSync(join(sandbox.tmpDir, 'home', '.codex'))).toBe(false)
      expect(existsSync(sandbox.paths.codexHome)).toBe(true)
    } finally {
      sandbox.cleanup()
    }
    // Persistent home outlives the run's cleanup.
    expect(existsSync(sandbox.paths.codexHome)).toBe(true)
  })

  it('rejects a nested macOS sandbox before attempting to launch arapuca', () => {
    if (process.platform !== 'darwin') return
    process.env.CODEX_SANDBOX = 'seatbelt'
    resetArapucaProbeForTests()
    expect(probeArapuca()).toEqual({ ok: false, uiCode: 'nested-sandbox-unsupported' })
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
      expect(script).toContain(`${paths.executionRoot}:rw`)
      expect(script).toContain(`${paths.specsBase}:rw`)
      expect(script).toContain(`--cwd '${paths.executionRoot}'`)
      // CODEX_HOME points at the persistent per-workspace home (outside the temp
      // dir), mounted rw so codex thread rollouts survive for the next `resume`.
      expect(script).toContain(`--env 'CODEX_HOME=${paths.codexHome}'`)
      expect(script).toContain(`-v '${paths.codexHome}:rw'`)
      expect(script).toContain(`-- 'claude' "$@"`)
      // arapuca is env deny-by-default; claude's provider credential is forwarded
      // as `--env "KEY=$KEY"`, expanded from the wrapper env at run time (value
      // never written into the script). codex-only vars are not leaked into a
      // claude run.
      expect(script).toContain(`--env "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"`)
      expect(script).toContain(`--env "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"`)
      expect(script).toContain(`--env "ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN"`)
      expect(script).not.toContain('CODEX_API_KEY')
      // Network opened for provider calls (strict — the default — blocks it).
      expect(script).toContain('--seccomp baseline')
      // Claude's hardcoded /tmp/claude-<uid> runtime dir: created by the wrapper
      // and allowed via its canonical path.
      const uid = typeof process.getuid === 'function' ? process.getuid() : 0
      expect(script).toContain(`mkdir -p '/tmp/claude-${uid}'`)
      expect(script).toContain(`${realpathSync('/tmp')}/claude-${uid}:rw`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('forwards the codex relay credential by bare name and does not leak claude vars', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'c3-sb-wrap-'))
    try {
      const paths = resolvePaths(workspaceRoot, worktree)
      const script = readFileSync(createSandboxWrapper(paths, 'codex', tmp), 'utf-8')
      // `--env "KEY=$KEY"`: /bin/sh expands $CODEX_API_KEY from the wrapper env at
      // run time; the script text holds only the `$`-reference, never a value.
      expect(script).toContain(`--env "CODEX_API_KEY=$CODEX_API_KEY"`)
      // A codex run must not pull claude's provider credential into its sandbox.
      expect(script).not.toContain('ANTHROPIC_')
      expect(script).toContain(`-- 'codex' "$@"`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('emits a single rw grant for a current-branch run (workspace == execution root, no ro/rw conflict)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'c3-sb-wrap-'))
    try {
      const paths = resolvePaths(workspaceRoot, workspaceRoot)
      const canonRoot = realpathSync(workspaceRoot)
      const script = readFileSync(createSandboxWrapper(paths, 'claude', tmp), 'utf-8')
      // The source workspace is read-write (it is the execution root) …
      expect(script).toContain(`-v '${canonRoot}:rw'`)
      // … and there is no conflicting read-only grant for the same path.
      expect(script).not.toContain(`${canonRoot}:ro`)
      expect(script).toContain(`--cwd '${canonRoot}'`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
