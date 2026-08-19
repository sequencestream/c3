import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applySelfUpdate,
  cancelSelfUpdate,
  configureRelaunch,
  configureSelfUpdate,
  currentSelfUpdateState,
  resetSelfUpdateForTests,
  restoreStagedOnBoot,
  selfUpdateCapability,
  startSelfUpdate,
  type RelaunchHooks,
  type SelfUpdateRuntime,
} from './self-update.js'
import { readStagedRecord, stagingDir, writeApplyFailure, writeStagedRecord } from './staging.js'
import { DEFAULT_REPO } from '../../upgrade-core.js'
import { defaultUpgradeIo, type UpgradeIo } from '../../upgrade.js'

// ── Fixtures ────────────────────────────────────────────────────────────────

let home: string

function facts(over: Partial<SelfUpdateRuntime> = {}): SelfUpdateRuntime {
  return {
    version: '1.0.0',
    execPath: '/usr/local/bin/c3',
    env: {},
    platform: 'darwin',
    arch: 'arm64',
    home: () => home,
    // An isolated OS home too, so a real launchd plist on the dev machine cannot
    // make these tests take the service branch.
    osHome: join(home, 'os-home'),
    canWriteDir: () => true,
    ...over,
  }
}

/** A release fixture: a fake package plus the sha256 sidecar that matches it. */
function release(version: string) {
  const pkgName = `c3-cli-v${version}-macos-arm64.tar.gz`
  const pkgBytes = Buffer.from(`PKG:${version}`.repeat(64))
  const sha256Line = `${createHash('sha256').update(pkgBytes).digest('hex')}  ${pkgName}\n`
  return { version, pkgName, pkgBytes, sha256Line }
}

function bytesResponse(body: Buffer): Response {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: { 'content-length': String(body.length) },
  })
}

function tagRedirect(version: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: `https://github.com/${DEFAULT_REPO}/releases/tag/v${version}` },
  })
}

/** A fetch that serves the redirect tag, the package and its sidecar. */
function serve(fx: ReturnType<typeof release>, overrides: Record<string, () => Response> = {}) {
  return vi.fn(async (url: string) => {
    for (const [suffix, make] of Object.entries(overrides)) {
      if (url.endsWith(suffix)) return make()
    }
    if (url === `https://github.com/${DEFAULT_REPO}/releases/latest`) return tagRedirect(fx.version)
    if (url.endsWith('.sha256')) return bytesResponse(Buffer.from(fx.sha256Line))
    return bytesResponse(fx.pkgBytes)
  }) as unknown as typeof fetch
}

/** The real IO except `unpack`, which drops a fake inner binary into the dir. */
function stagingIo(over: Partial<UpgradeIo> = {}): UpgradeIo {
  return {
    ...defaultUpgradeIo(),
    unpack: (_archive, destDir) => writeFileSync(join(destDir, 'c3'), 'NEW-BINARY'),
    selfCheckVersion: () => 'ok',
    ...over,
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-selfupdate-'))
  resetSelfUpdateForTests()
})

afterEach(() => {
  resetSelfUpdateForTests()
  rmSync(home, { recursive: true, force: true })
})

// ── Capability ──────────────────────────────────────────────────────────────

describe('selfUpdateCapability', () => {
  it('allows a writable, compiled, unmanaged binary', () => {
    expect(selfUpdateCapability(facts())).toEqual({ capable: true })
  })

  it('refuses a desktop-managed sidecar even when everything else is fine', () => {
    expect(selfUpdateCapability(facts({ env: { C3_MANAGED_BY: 'desktop' } }))).toEqual({
      capable: false,
      reason: 'desktop-managed',
    })
  })

  it('refuses a dev version and an interpreter run', () => {
    expect(selfUpdateCapability(facts({ version: '0.0.0-dev' })).capable).toBe(false)
    expect(selfUpdateCapability(facts({ execPath: '/usr/bin/node' }))).toEqual({
      capable: false,
      reason: 'dev-runtime',
    })
  })

  it('refuses a package-manager prefix so it cannot fight brew', () => {
    for (const p of [
      '/opt/homebrew/Cellar/c3/1.0.0/bin/c3',
      '/usr/local/Cellar/c3/1.0.0/bin/c3',
      '/home/linuxbrew/.linuxbrew/bin/c3',
    ]) {
      expect(selfUpdateCapability(facts({ execPath: p }))).toEqual({
        capable: false,
        reason: 'package-manager',
      })
    }
  })

  it('refuses an unwritable install directory', () => {
    expect(selfUpdateCapability(facts({ canWriteDir: () => false }))).toEqual({
      capable: false,
      reason: 'not-writable',
    })
  })
})

// ── Download / staging ──────────────────────────────────────────────────────

describe('startSelfUpdate', () => {
  it('downloads, verifies, unpacks and lands in ready without touching the binary', async () => {
    const fx = release('2.0.0')
    const onChange = vi.fn()
    configureSelfUpdate({ onChange, runtime: facts() })
    await startSelfUpdate({ fetchFn: serve(fx), io: stagingIo() })

    const state = currentSelfUpdateState()
    expect(state.phase).toBe('ready')
    expect(state.targetVersion).toBe('2.0.0')
    expect(state.currentVersion).toBe('1.0.0')
    const record = readStagedRecord(stagingDir(home))
    expect(record?.version).toBe('2.0.0')
    expect(record?.execPath).toBe('/usr/local/bin/c3')
    // The installed binary is untouched until an admin applies the update.
    expect(existsSync('/usr/local/bin/c3')).toBe(false)
    expect(onChange).toHaveBeenCalled()
  })

  it('reports progress and ends the transfer in verifying before ready', async () => {
    const fx = release('2.0.0')
    const seen: Array<{ phase: string; downloadedBytes: number; totalBytes: number }> = []
    configureSelfUpdate({
      runtime: facts(),
      onChange: () => {
        const s = currentSelfUpdateState()
        seen.push({
          phase: s.phase,
          downloadedBytes: s.downloadedBytes,
          totalBytes: s.totalBytes,
        })
      },
    })
    await startSelfUpdate({ fetchFn: serve(fx), io: stagingIo() })
    expect(seen.some((s) => s.phase === 'downloading')).toBe(true)
    const verifying = seen.find((s) => s.phase === 'verifying')
    expect(verifying?.downloadedBytes).toBe(fx.pkgBytes.length)
    expect(verifying?.totalBytes).toBe(fx.pkgBytes.length)
    expect(seen.at(-1)?.phase).toBe('ready')
  })

  it('does nothing when the latest release is not newer', async () => {
    const fx = release('1.0.0')
    configureSelfUpdate({ runtime: facts() })
    await startSelfUpdate({ fetchFn: serve(fx), io: stagingIo() })
    expect(currentSelfUpdateState().phase).toBe('idle')
    expect(readStagedRecord(stagingDir(home))).toBeNull()
  })

  it('goes straight to ready when this exact version is already staged', async () => {
    const fx = release('2.0.0')
    const dir = stagingDir(home)
    const binPath = join(dir, 'c3')
    mkdirSync(dir, { recursive: true })
    writeFileSync(binPath, 'ALREADY')
    writeStagedRecord(dir, {
      version: '2.0.0',
      tag: 'v2.0.0',
      binPath,
      execPath: '/usr/local/bin/c3',
      fromVersion: '1.0.0',
    })
    const fetchFn = serve(fx)
    configureSelfUpdate({ runtime: facts() })
    await startSelfUpdate({ fetchFn, io: stagingIo() })
    expect(currentSelfUpdateState().phase).toBe('ready')
    // Only the tag redirect was fetched — the package was not downloaded again.
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('fails with `checksum` and stages nothing when the sidecar does not match', async () => {
    const fx = release('2.0.0')
    const wrong = `${'0'.repeat(64)}  ${fx.pkgName}\n`
    configureSelfUpdate({ runtime: facts() })
    await startSelfUpdate({
      fetchFn: serve(fx, { '.sha256': () => bytesResponse(Buffer.from(wrong)) }),
      io: stagingIo({
        unpack: () => {
          throw new Error('unpack must not run after a failed checksum')
        },
      }),
    })
    const state = currentSelfUpdateState()
    expect(state.phase).toBe('failed')
    expect(state.failure?.code).toBe('checksum')
    expect(readStagedRecord(stagingDir(home))).toBeNull()
    expect(existsSync(stagingDir(home))).toBe(false)
  })

  it('fails with `network` when the package cannot be fetched', async () => {
    const fx = release('2.0.0')
    configureSelfUpdate({ runtime: facts() })
    await startSelfUpdate({
      fetchFn: serve(fx, { '.tar.gz': () => new Response(null, { status: 502 }) }),
      io: stagingIo(),
    })
    expect(currentSelfUpdateState().failure?.code).toBe('network')
  })

  it('is a no-op — and reports why — when this installation cannot self-update', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch
    configureSelfUpdate({ runtime: facts({ env: { C3_MANAGED_BY: 'desktop' } }) })
    await startSelfUpdate({ fetchFn, io: stagingIo() })
    expect(currentSelfUpdateState()).toMatchObject({
      phase: 'idle',
      capable: false,
      incapableReason: 'desktop-managed',
    })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('does not start a second download while one is in flight', async () => {
    const fx = release('2.0.0')
    const fetchFn = serve(fx)
    configureSelfUpdate({ runtime: facts() })
    const first = startSelfUpdate({ fetchFn, io: stagingIo() })
    await startSelfUpdate({ fetchFn, io: stagingIo() })
    await first
    const calls = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls
    // redirect + package + sidecar = one pipeline, not two.
    expect(calls).toHaveLength(3)
  })
})

describe('cancelSelfUpdate', () => {
  it('discards a staged package and returns to idle', async () => {
    const fx = release('2.0.0')
    configureSelfUpdate({ runtime: facts() })
    await startSelfUpdate({ fetchFn: serve(fx), io: stagingIo() })
    expect(currentSelfUpdateState().phase).toBe('ready')
    cancelSelfUpdate()
    expect(currentSelfUpdateState().phase).toBe('idle')
    expect(existsSync(stagingDir(home))).toBe(false)
  })
})

// ── Apply + relaunch ────────────────────────────────────────────────────────

function hooks(over: Partial<RelaunchHooks> = {}): RelaunchHooks & {
  releasePort: ReturnType<typeof vi.fn>
  exit: ReturnType<typeof vi.fn>
  spawnSuccessor: ReturnType<typeof vi.fn>
  run: ReturnType<typeof vi.fn>
  spawnAssistant: ReturnType<typeof vi.fn>
} {
  const base = {
    pid: 4242,
    releasePort: vi.fn(async () => {}),
    exit: vi.fn(),
    spawnSuccessor: vi.fn(() => true),
    run: vi.fn(() => ({ status: 0, stderr: '' })),
    spawnAssistant: vi.fn(() => true),
  }
  return { ...base, ...over } as never
}

async function stageReady(over: Partial<SelfUpdateRuntime> = {}): Promise<void> {
  configureSelfUpdate({ runtime: facts(over) })
  await startSelfUpdate({ fetchFn: serve(release('2.0.0')), io: stagingIo() })
  expect(currentSelfUpdateState().phase).toBe('ready')
}

describe('applySelfUpdate', () => {
  it('refuses outside ready', async () => {
    const h = hooks()
    configureSelfUpdate({ runtime: facts() })
    configureRelaunch(h)
    await applySelfUpdate()
    expect(h.exit).not.toHaveBeenCalled()
  })

  it('foreground: swaps the binary, frees the port, spawns the successor, exits', async () => {
    const target = join(home, 'bin-c3')
    writeFileSync(target, 'OLD')
    await stageReady({ execPath: target })
    const h = hooks()
    configureRelaunch(h)
    await applySelfUpdate({ io: stagingIo() })

    expect(readFileSync(target, 'utf-8')).toBe('NEW-BINARY')
    expect(h.releasePort).toHaveBeenCalled()
    expect(h.spawnSuccessor).toHaveBeenCalled()
    expect(h.exit).toHaveBeenCalledWith(0)
    // The staged package is spent; the next boot must not think one is pending.
    expect(existsSync(stagingDir(home))).toBe(false)
  })

  it('foreground: a successor that will not start is a relaunch failure, not a silent exit', async () => {
    const target = join(home, 'bin-c3')
    writeFileSync(target, 'OLD')
    await stageReady({ execPath: target })
    const h = hooks({ spawnSuccessor: vi.fn(() => false) })
    configureRelaunch(h)
    await applySelfUpdate({ io: stagingIo() })
    expect(h.exit).not.toHaveBeenCalled()
    expect(currentSelfUpdateState().failure?.code).toBe('relaunch')
  })

  it('daemon: delegates the whole swap to the helper and never replaces in-process', async () => {
    const target = join(home, 'bin-c3')
    writeFileSync(target, 'OLD')
    // A live pid file makes detectRuntimeForms report the --daemon form.
    writeFileSync(join(home, 'c3.pid'), `${process.pid}\n`)
    await stageReady({ execPath: target })
    const h = hooks()
    configureRelaunch(h)
    await applySelfUpdate({ io: stagingIo() })

    expect(h.spawnAssistant).toHaveBeenCalledWith({
      waitPid: 4242,
      updateDir: stagingDir(home),
      form: 'daemon',
    })
    expect(readFileSync(target, 'utf-8')).toBe('OLD')
    expect(h.exit).toHaveBeenCalledWith(0)
    // The helper needs the package, so it must still be there.
    expect(readStagedRecord(stagingDir(home))?.version).toBe('2.0.0')
  })

  it('daemon: a helper that will not spawn keeps this process alive and reports it', async () => {
    writeFileSync(join(home, 'bin-c3'), 'OLD')
    writeFileSync(join(home, 'c3.pid'), `${process.pid}\n`)
    await stageReady({ execPath: join(home, 'bin-c3') })
    const h = hooks({ spawnAssistant: vi.fn(() => false) })
    configureRelaunch(h)
    await applySelfUpdate({ io: stagingIo() })
    expect(h.releasePort).not.toHaveBeenCalled()
    expect(h.exit).not.toHaveBeenCalled()
    expect(currentSelfUpdateState().failure?.code).toBe('relaunch')
  })

  it('fails when the staged package vanished between ready and apply', async () => {
    await stageReady()
    rmSync(stagingDir(home), { recursive: true, force: true })
    const h = hooks()
    configureRelaunch(h)
    await applySelfUpdate({ io: stagingIo() })
    expect(h.exit).not.toHaveBeenCalled()
    expect(currentSelfUpdateState().failure?.code).toBe('replace')
  })
})

// ── Boot reconciliation ─────────────────────────────────────────────────────

describe('restoreStagedOnBoot', () => {
  it('surfaces the failure the helper left behind, then clears it', () => {
    const dir = stagingDir(home)
    writeApplyFailure(dir, { code: 'replace', detail: 'target not writable' })
    configureSelfUpdate({ runtime: facts() })
    restoreStagedOnBoot()
    expect(currentSelfUpdateState()).toMatchObject({
      phase: 'failed',
      failure: { code: 'replace', detail: 'target not writable' },
    })
    // Cleared, so the next boot does not re-report a resolved failure.
    resetSelfUpdateForTests()
    configureSelfUpdate({ runtime: facts() })
    restoreStagedOnBoot()
    expect(currentSelfUpdateState().phase).toBe('idle')
  })

  it('keeps a package staged for a newer version as ready', async () => {
    await stageReady()
    resetSelfUpdateForTests()
    configureSelfUpdate({ runtime: facts() })
    restoreStagedOnBoot()
    expect(currentSelfUpdateState()).toMatchObject({ phase: 'ready', targetVersion: '2.0.0' })
  })

  it('cleans a package for the version now running (the restart already happened)', async () => {
    await stageReady()
    resetSelfUpdateForTests()
    configureSelfUpdate({ runtime: facts({ version: '2.0.0' }) })
    restoreStagedOnBoot()
    expect(currentSelfUpdateState().phase).toBe('idle')
    expect(existsSync(stagingDir(home))).toBe(false)
  })

  it('cleans a package staged for a different binary', async () => {
    await stageReady()
    resetSelfUpdateForTests()
    configureSelfUpdate({ runtime: facts({ execPath: '/opt/elsewhere/c3' }) })
    restoreStagedOnBoot()
    expect(currentSelfUpdateState().phase).toBe('idle')
    expect(existsSync(stagingDir(home))).toBe(false)
  })

  it('is idle when nothing was staged', () => {
    configureSelfUpdate({ runtime: facts() })
    restoreStagedOnBoot()
    expect(currentSelfUpdateState().phase).toBe('idle')
    expect(readdirSync(home)).toEqual([])
  })
})
