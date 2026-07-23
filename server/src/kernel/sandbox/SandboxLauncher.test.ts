/**
 * SandboxLauncher — Unit Tests (arapuca process-level isolation)
 *
 * Covers:
 * - resolvePaths: fixed allowances, extraMounts ro/rw, reserved-path overlap,
 *   denylist, non-existent skip
 * - probeArapuca: missing binary → hard-fail; present binary → ok
 * - createSandboxWrapper: writes an executable `arapuca run -v … -- <cli>` script,
 *   plus the two host-capability flags — `--allow-proxy-env` (host proxy vars
 *   present) and `--allow-keychain` (a subscription/`system`-mode agent)
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

// The distribution manager is stubbed so probe tests drive the "is a c3-managed
// arapuca installed?" answer directly and NO test can reach the network. Its own
// download/verify/activate behaviour is covered in `arapuca-dist.test.ts`.
const dist = vi.hoisted(() => ({
  /** What `resolveManagedArapuca` currently reports (null ⇒ not installed). */
  managed: null as string | null,
  /** How many times a background install was requested. */
  ensureCalls: 0,
  /** The probe-cache invalidator the launcher handed to the background task. */
  onInstalled: undefined as (() => void) | undefined,
}))
vi.mock('./arapuca-dist.js', () => ({
  resolveManagedArapuca: () => dist.managed,
  ensureManagedArapuca: (opts?: { onInstalled?: () => void }) => {
    dist.ensureCalls++
    dist.onInstalled = opts?.onInstalled
  },
}))

import {
  resolvePaths,
  probeArapuca,
  launchSandbox,
  createSandboxWrapper,
  resetArapucaProbeForTests,
  binaryCandidates,
  SandboxLaunchError,
} from './SandboxLauncher.js'

// ─── Fixtures ────────────────────────────────────────────────────────────────

let root: string
let workspaceRoot: string
let worktree: string

/** The proxy env names whose presence turns on `--allow-proxy-env`. */
const PROXY_ENV_NAMES = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const

/** Snapshot of the host proxy env, restored after each test. */
let proxyEnvBackup: Record<string, string | undefined> = {}

/** Wrapper opts for a custom (API-key) agent — the default in most cases. */
const CUSTOM = { allowKeychain: false }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'c3-sb-test-'))
  stub.home = join(root, '.c3')
  workspaceRoot = join(root, 'project')
  worktree = join(root, 'worktree')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(worktree, { recursive: true })
  dist.managed = null
  dist.ensureCalls = 0
  dist.onInstalled = undefined
  resetArapucaProbeForTests()
  // Proxy passthrough reads the HOST env: clear it so a developer machine behind a
  // corporate proxy does not change these assertions. Each proxy test sets its own.
  proxyEnvBackup = {}
  for (const name of PROXY_ENV_NAMES) {
    proxyEnvBackup[name] = process.env[name]
    delete process.env[name]
  }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  resetArapucaProbeForTests()
  for (const name of PROXY_ENV_NAMES) {
    if (proxyEnvBackup[name] === undefined) delete process.env[name]
    else process.env[name] = proxyEnvBackup[name]
  }
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
    // The claude config dir (a sandbox claude run's CLAUDE_CONFIG_DIR) is resolved
    // + ensured too, so a claude run has a canonical rw data root to mount.
    expect(existsSync(paths.claudeConfigDir)).toBe(true)
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

// ─── binaryCandidates (host PATH name resolution) ────────────────────────────

describe('binaryCandidates', () => {
  it('uses the bare name on POSIX', () => {
    expect(binaryCandidates('arapuca', 'darwin', '.COM;.EXE')).toEqual(['arapuca'])
    expect(binaryCandidates('arapuca', 'linux', undefined)).toEqual(['arapuca'])
  })

  it('tries arapuca.exe first on Windows — a host install is arapuca.exe, not arapuca', () => {
    const names = binaryCandidates('arapuca', 'win32', undefined)
    expect(names[0]).toBe('arapuca.com')
    expect(names).toContain('arapuca.exe')
    // The bare name stays reachable as the last resort.
    expect(names[names.length - 1]).toBe('arapuca')
  })

  it('honours PATHEXT on Windows, ignoring a blank value', () => {
    expect(binaryCandidates('arapuca', 'win32', '.EXE;.CMD')).toEqual([
      'arapuca.exe',
      'arapuca.cmd',
      'arapuca',
    ])
    // Blank/whitespace PATHEXT falls back to the built-in default rather than
    // degrading to the bare name (which Windows would never find).
    expect(binaryCandidates('arapuca', 'win32', '  ')).toContain('arapuca.exe')
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

  /** Write an executable stub named `arapuca` into `dir` and return its path. */
  function stubBinary(dir: string, name = 'arapuca'): string {
    mkdirSync(dir, { recursive: true })
    const bin = join(dir, name)
    writeFileSync(bin, '#!/bin/sh\nexit 0\n', 'utf-8')
    chmodSync(bin, 0o755)
    return bin
  }

  it('reports arapuca-missing — immediately, without waiting for a download — when neither source has a binary', () => {
    delete process.env.CODEX_SANDBOX
    delete process.env.APP_SANDBOX_CONTAINER_ID
    process.env.PATH = ''
    resetArapucaProbeForTests()
    const result = probeArapuca()
    // No managed install, nothing on PATH: a hard-fail settled on the spot. The
    // background install was requested but is explicitly NOT waited for.
    expect(result.ok ? 'ok' : result.uiCode).toBe('arapuca-missing')
    expect(dist.ensureCalls).toBe(1)
  })

  it('prefers the c3-managed install over the host PATH and does not start a download', () => {
    if (process.platform === 'win32') return
    delete process.env.CODEX_SANDBOX
    delete process.env.APP_SANDBOX_CONTAINER_ID
    const hostBin = stubBinary(join(root, 'bin'))
    const managedBin = stubBinary(join(root, 'managed'))
    process.env.PATH = join(root, 'bin')
    dist.managed = managedBin
    resetArapucaProbeForTests()
    expect(probeArapuca()).toEqual({ ok: true, path: managedBin, source: 'managed' })
    expect(probeArapuca().ok && probeArapuca().ok).toBe(true)
    expect(managedBin).not.toBe(hostBin)
    // An intact managed install needs no repair task.
    expect(dist.ensureCalls).toBe(0)
    // The wrapper execs the managed binary by absolute path, not a bare name.
    const sandbox = launchSandbox(workspaceRoot, worktree)
    try {
      expect(sandbox.paths.arapucaBin).toBe(managedBin)
      const script = readFileSync(
        createSandboxWrapper(sandbox.paths, 'claude', sandbox.tmpDir, { allowKeychain: false }),
        'utf-8',
      )
      expect(script).toContain(`exec '${managedBin}' run`)
    } finally {
      sandbox.cleanup()
    }
  })

  it('falls back to the host PATH while the managed install is missing, and starts it once', () => {
    if (process.platform === 'win32') return
    delete process.env.CODEX_SANDBOX
    delete process.env.APP_SANDBOX_CONTAINER_ID
    const hostBin = stubBinary(join(root, 'bin'))
    process.env.PATH = join(root, 'bin')
    resetArapucaProbeForTests()
    expect(probeArapuca()).toEqual({ ok: true, path: hostBin, source: 'host-path' })
    // Concurrent probes reuse the cached result — one repair task, not three.
    probeArapuca()
    probeArapuca()
    expect(dist.ensureCalls).toBe(1)
  })

  it('keeps the PATH result when the background install fails, and can retry later', () => {
    if (process.platform === 'win32') return
    delete process.env.CODEX_SANDBOX
    delete process.env.APP_SANDBOX_CONTAINER_ID
    const hostBin = stubBinary(join(root, 'bin'))
    process.env.PATH = join(root, 'bin')
    resetArapucaProbeForTests()
    expect(probeArapuca()).toEqual({ ok: true, path: hostBin, source: 'host-path' })
    // A rejected install never calls back, so the cache keeps the PATH choice —
    // and the failure surfaces as neither an exception nor a changed result.
    expect(dist.onInstalled).toBeTypeOf('function')
    expect(probeArapuca()).toEqual({ ok: true, path: hostBin, source: 'host-path' })
    // A fresh probe (new cache) is free to try the install again.
    resetArapucaProbeForTests()
    probeArapuca()
    expect(dist.ensureCalls).toBe(2)
  })

  it('switches to the managed binary on the next probe once the background install lands', () => {
    if (process.platform === 'win32') return
    delete process.env.CODEX_SANDBOX
    delete process.env.APP_SANDBOX_CONTAINER_ID
    const hostBin = stubBinary(join(root, 'bin'))
    process.env.PATH = join(root, 'bin')
    resetArapucaProbeForTests()
    expect(probeArapuca().ok && probeArapuca()).toMatchObject({ source: 'host-path' })
    // A run launched NOW keeps the host binary for its whole lifetime …
    const sandbox = launchSandbox(workspaceRoot, worktree)
    try {
      expect(sandbox.paths.arapucaBin).toBe(hostBin)
      // … then the background install completes and invalidates the cache.
      const managedBin = stubBinary(join(root, 'managed'))
      dist.managed = managedBin
      dist.onInstalled!()
      // The already-launched run is unaffected …
      expect(sandbox.paths.arapucaBin).toBe(hostBin)
      // … while the next probe (and every run after it) upgrades.
      expect(probeArapuca()).toEqual({ ok: true, path: managedBin, source: 'managed' })
    } finally {
      sandbox.cleanup()
    }
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
    expect(probeArapuca()).toEqual({ ok: true, path: bin, source: 'host-path' })
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
      const scriptPath = createSandboxWrapper(paths, 'claude', tmp, CUSTOM)
      expect(existsSync(scriptPath)).toBe(true)
      expect(statSync(scriptPath).mode & 0o111).toBeGreaterThan(0)
      const script = readFileSync(scriptPath, 'utf-8')
      expect(script).toContain(`exec 'arapuca' run`)
      expect(script).toContain(`${paths.workspaceRoot}:ro`)
      expect(script).toContain(`${paths.executionRoot}:rw`)
      expect(script).toContain(`${paths.specsBase}:rw`)
      expect(script).toContain(`--cwd '${paths.executionRoot}'`)
      // A claude run exports CLAUDE_CONFIG_DIR (the host claude config dir, so its
      // transcript is host-readable) and mounts it rw; it must NOT carry codex's
      // CODEX_HOME nor mount the codex home.
      expect(script).toContain(`--env 'CLAUDE_CONFIG_DIR=${paths.claudeConfigDir}'`)
      expect(script).toContain(`-v '${paths.claudeConfigDir}:rw'`)
      expect(script).not.toContain('CODEX_HOME')
      expect(script).not.toContain(`-v '${paths.codexHome}:rw'`)
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
      const script = readFileSync(createSandboxWrapper(paths, 'codex', tmp, CUSTOM), 'utf-8')
      // `--env "KEY=$KEY"`: /bin/sh expands $CODEX_API_KEY from the wrapper env at
      // run time; the script text holds only the `$`-reference, never a value.
      expect(script).toContain(`--env "CODEX_API_KEY=$CODEX_API_KEY"`)
      // A codex run must not pull claude's provider credential into its sandbox.
      expect(script).not.toContain('ANTHROPIC_')
      expect(script).toContain(`-- 'codex' "$@"`)
      // A codex run exports CODEX_HOME (persistent per-workspace home, rollouts
      // survive for `resume`) + mounts it rw, and carries NONE of claude's data
      // root, config-dir env, or /tmp runtime dir.
      expect(script).toContain(`--env 'CODEX_HOME=${paths.codexHome}'`)
      expect(script).toContain(`-v '${paths.codexHome}:rw'`)
      expect(script).not.toContain('CLAUDE_CONFIG_DIR')
      expect(script).not.toContain('claude-')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('emits a single rw grant for a current-branch run (workspace == execution root, no ro/rw conflict)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'c3-sb-wrap-'))
    try {
      const paths = resolvePaths(workspaceRoot, workspaceRoot)
      const canonRoot = realpathSync(workspaceRoot)
      const script = readFileSync(createSandboxWrapper(paths, 'claude', tmp, CUSTOM), 'utf-8')
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

// ─── createSandboxWrapper: host proxy passthrough ────────────────────────────

describe('createSandboxWrapper — proxy passthrough', () => {
  /** Build a wrapper script for `vendor`, returning its text. */
  function wrapperScript(vendor: string, allowKeychain = false): string {
    const tmp = mkdtempSync(join(tmpdir(), 'c3-sb-wrap-'))
    try {
      const paths = resolvePaths(workspaceRoot, worktree)
      return readFileSync(createSandboxWrapper(paths, vendor, tmp, { allowKeychain }), 'utf-8')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  it('omits --allow-proxy-env when the host carries no proxy variables', () => {
    // beforeEach already cleared all eight names.
    expect(wrapperScript('claude')).not.toContain('--allow-proxy-env')
    expect(wrapperScript('codex')).not.toContain('--allow-proxy-env')
  })

  it('appends --allow-proxy-env exactly once for an uppercase host proxy variable (both vendors)', () => {
    process.env.HTTPS_PROXY = 'http://proxy.corp:3128'
    for (const vendor of ['claude', 'codex']) {
      const script = wrapperScript(vendor)
      expect(script.match(/--allow-proxy-env/g)).toHaveLength(1)
      // The flag belongs to arapuca, not to the vendor CLI: it must appear before
      // the `-- <cli>` separator.
      expect(script.indexOf('--allow-proxy-env')).toBeLessThan(script.indexOf(`-- '${vendor}'`))
    }
  })

  it('appends --allow-proxy-env for a lowercase host proxy variable', () => {
    process.env.all_proxy = 'socks5://127.0.0.1:1080'
    const script = wrapperScript('codex')
    expect(script.match(/--allow-proxy-env/g)).toHaveLength(1)
  })

  it('still appends the flag only once when several proxy variables are set', () => {
    process.env.HTTP_PROXY = 'http://proxy.corp:3128'
    process.env.http_proxy = 'http://proxy.corp:3128'
    process.env.NO_PROXY = 'localhost'
    expect(wrapperScript('claude').match(/--allow-proxy-env/g)).toHaveLength(1)
  })

  it('treats an empty proxy value as absent (grants nothing, so widens nothing)', () => {
    process.env.NO_PROXY = ''
    expect(wrapperScript('claude')).not.toContain('--allow-proxy-env')
  })
})

// ─── createSandboxWrapper: subscription (keychain) passthrough ───────────────

describe('createSandboxWrapper — keychain passthrough', () => {
  function wrapperScript(vendor: string, allowKeychain: boolean): string {
    const tmp = mkdtempSync(join(tmpdir(), 'c3-sb-wrap-'))
    try {
      const paths = resolvePaths(workspaceRoot, worktree)
      return readFileSync(createSandboxWrapper(paths, vendor, tmp, { allowKeychain }), 'utf-8')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }

  it('omits --allow-keychain for a custom (API-key) agent, keeping its env-injected credential', () => {
    const script = wrapperScript('claude', false)
    expect(script).not.toContain('--allow-keychain')
    // The custom agent's credential path is unchanged.
    expect(script).toContain(`--env "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"`)
  })

  it('appends --allow-keychain once for a system-mode agent, before the -- separator', () => {
    for (const vendor of ['claude', 'codex']) {
      const script = wrapperScript(vendor, true)
      expect(script.match(/--allow-keychain/g)).toHaveLength(1)
      expect(script.indexOf('--allow-keychain')).toBeLessThan(script.indexOf(`-- '${vendor}'`))
    }
  })

  it('keeps the vendor isolation, data root and network model intact in system mode', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'c3-sb-wrap-'))
    try {
      const paths = resolvePaths(workspaceRoot, worktree)
      const script = readFileSync(
        createSandboxWrapper(paths, 'codex', tmp, { allowKeychain: true }),
        'utf-8',
      )
      expect(script).toContain('--seccomp baseline')
      expect(script).toContain(`--env 'CODEX_HOME=${paths.codexHome}'`)
      expect(script).toContain(`-v '${paths.codexHome}:rw'`)
      expect(script).toContain(`-v '${paths.executionRoot}:rw'`)
      expect(script).toContain(`-v '${paths.workspaceRoot}:ro'`)
      expect(script).toContain(`-v '${paths.specsBase}:rw'`)
      // Vendor credential isolation is unaffected by the keychain flag.
      expect(script).toContain(`--env "CODEX_API_KEY=$CODEX_API_KEY"`)
      expect(script).not.toContain('ANTHROPIC_')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
