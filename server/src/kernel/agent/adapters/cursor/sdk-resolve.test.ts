import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Where the SDK resolves from, and the rule that makes the answer trustworthy:
 * ONE resolution serves the startup gate, the settings signal and the run's lazy
 * import. A test suite that let those drift apart would be pinning the exact bug
 * the boundary exists to prevent — a vendor reported runnable that fails at
 * `start()` because the loader looked somewhere else.
 *
 * The scenarios are the deployment shapes: an override path, the sidecar tree
 * beside the executable, an ordinary install, and none of them.
 */

const scratch: string[] = []
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'c3-sdk-resolve-'))
  scratch.push(dir)
  return dir
}

/** A `node_modules`-shaped root holding a minimal, resolvable `@cursor/sdk`. */
function sdkTree(version = '9.9.9', rootName = 'node_modules'): string {
  const home = fixture()
  const pkg = join(home, rootName, '@cursor', 'sdk')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(
    join(pkg, 'package.json'),
    `{ "name": "@cursor/sdk", "version": "${version}", "main": "./index.cjs" }`,
  )
  writeFileSync(join(pkg, 'index.cjs'), 'module.exports = { Agent: {} }\n')
  return join(home, rootName)
}

/** A directory that exists but holds no SDK — an override pointing at nothing. */
function emptyRoot(): string {
  const home = fixture()
  const root = join(home, 'node_modules')
  mkdirSync(root, { recursive: true })
  return root
}

/**
 * Whether ordinary module resolution finds the SDK. Only the boundary's OWN
 * `createRequire(import.meta.url)` lookup is intercepted — the filesystem-root
 * lookups keep working, which is exactly the shape of a standalone binary: no
 * module path, but a real `node_modules` beside it.
 */
const npmInstalled = vi.hoisted(() => ({ value: true }))
vi.mock('node:module', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:module')>()
  return {
    ...actual,
    createRequire(base: string | URL) {
      const real = actual.createRequire(base)
      if (npmInstalled.value || !String(base).includes('sdk-resolve')) return real
      return {
        resolve: () => {
          throw new Error('MODULE_NOT_FOUND')
        },
      } as unknown as NodeJS.Require
    },
  }
})

beforeEach(() => {
  vi.resetModules()
  npmInstalled.value = true
  delete process.env.CURSOR_SDK_PATH
  delete process.env.CURSOR_RIPGREP_PATH
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.CURSOR_SDK_PATH
  delete process.env.CURSOR_RIPGREP_PATH
})

/** Load the boundary with `process.execPath` pointed at a chosen directory. */
async function load(binDir?: string) {
  if (binDir) {
    vi.spyOn(process, 'execPath', 'get').mockReturnValue(join(binDir, 'c3'))
  }
  return import('./sdk-resolve.js')
}

describe('resolveCursorSdk', () => {
  it('takes CURSOR_SDK_PATH ahead of everything else', async () => {
    const root = sdkTree()
    process.env.CURSOR_SDK_PATH = root
    const { resolveCursorSdk } = await load()
    const resolution = resolveCursorSdk()
    expect(resolution.available).toBe(true)
    expect(resolution.origin).toBe('override')
    expect(resolution.root).toBe(resolve(root))
    expect(resolution.entry).toContain(join('@cursor', 'sdk'))
  })

  it('accepts an override root under any name, not only one called node_modules', async () => {
    // The root is c3's own concept, not Node's: resolving it by walking up for a
    // directory literally named `node_modules` would fail here, silently, and the
    // operator would see "unresolved" with a perfectly good tree on disk.
    const root = sdkTree('9.9.9', 'cursor-sdk-tree')
    process.env.CURSOR_SDK_PATH = root
    const { resolveCursorSdk } = await load(fixture())
    const resolution = resolveCursorSdk()
    expect(resolution.origin).toBe('override')
    expect(resolution.entry).toBe(join(root, '@cursor/sdk', 'index.cjs'))
  })

  it('falls back to the sidecar beside the executable', async () => {
    const root = sdkTree()
    const { resolveCursorSdk } = await load(join(root, '..'))
    const resolution = resolveCursorSdk()
    expect(resolution.available).toBe(true)
    expect(resolution.origin).toBe('sidecar')
  })

  it('rejects an override that yields no SDK, and records it while falling through', async () => {
    const root = sdkTree()
    const bogus = emptyRoot()
    process.env.CURSOR_SDK_PATH = bogus
    const { resolveCursorSdk } = await load(join(root, '..'))
    const resolution = resolveCursorSdk()
    // The override must not "succeed" by walking up into some ancestor's tree,
    // and it must not swallow the deployment's real sidecar either.
    expect(resolution.origin).toBe('sidecar')
    expect(resolution.rejectedOverride).toBe(resolve(bogus))
    expect(resolution.available).toBe(true)
  })

  it('keeps ordinary module resolution when there is no override and no sidecar', async () => {
    const { resolveCursorSdk } = await load(fixture())
    const resolution = resolveCursorSdk()
    // The repo has @cursor/sdk installed, so this is the npm-install shape: it
    // resolves, and it says so without claiming a sidecar.
    expect(resolution.available).toBe(true)
    expect(resolution.origin).toBe('installed')
    expect(resolution.root).toBeUndefined()
  })

  it('reports unavailable when nothing resolves', async () => {
    const empty = fixture()
    process.env.CURSOR_SDK_PATH = join(empty, 'nowhere')
    // A binary build with no sidecar: no module path, no tree beside it.
    npmInstalled.value = false
    const { resolveCursorSdk, cursorSdkAvailable } = await load(empty)
    const resolution = resolveCursorSdk()
    expect(resolution.available).toBe(false)
    expect(resolution.entry).toBeUndefined()
    expect(resolution.rejectedOverride).toBe(resolve(join(empty, 'nowhere')))
    // The gate and the resolution are the same fact — never two answers.
    expect(cursorSdkAvailable()).toBe(false)
  })
})

describe('the availability gate and the loader read one resolution', () => {
  it('agrees with resolveCursorSdk in every scenario', async () => {
    const root = sdkTree()
    const { resolveCursorSdk, cursorSdkAvailable } = await load(join(root, '..'))
    expect(cursorSdkAvailable()).toBe(resolveCursorSdk().available)
  })

  it('loads the copy the resolution named, and points ripgrep into that tree', async () => {
    const root = sdkTree()
    const platform = join(root, `@cursor/sdk-${process.platform}-${process.arch}`, 'bin')
    mkdirSync(platform, { recursive: true })
    const rg = join(platform, process.platform === 'win32' ? 'rg.exe' : 'rg')
    writeFileSync(rg, '')
    const { loadCursorSdk, resolveCursorSdk } = await load(join(root, '..'))
    const sdk = (await loadCursorSdk()) as unknown as { Agent: unknown }
    expect(sdk.Agent).toBeDefined()
    expect(resolveCursorSdk().origin).toBe('sidecar')
    // The SDK finds its platform binaries by walking up from `process.argv[1]`,
    // which in a standalone binary never reaches the sidecar; the env var is what
    // makes the shipped ripgrep reachable.
    expect(process.env.CURSOR_RIPGREP_PATH).toBe(rg)
  })

  it('leaves an operator-set ripgrep path alone', async () => {
    const root = sdkTree()
    const platform = join(root, `@cursor/sdk-${process.platform}-${process.arch}`, 'bin')
    mkdirSync(platform, { recursive: true })
    writeFileSync(join(platform, process.platform === 'win32' ? 'rg.exe' : 'rg'), '')
    process.env.CURSOR_RIPGREP_PATH = '/usr/local/bin/rg'
    const { loadCursorSdk } = await load(join(root, '..'))
    await loadCursorSdk()
    expect(process.env.CURSOR_RIPGREP_PATH).toBe('/usr/local/bin/rg')
  })

  it('fails the load with an actionable message when nothing resolved', async () => {
    const empty = fixture()
    npmInstalled.value = false
    const { loadCursorSdk } = await load(empty)
    await expect(loadCursorSdk()).rejects.toThrow(/CURSOR_SDK_PATH/)
  })
})

describe('resolvedCursorSdkVersion', () => {
  it('reads the version off the copy that will be loaded', async () => {
    const root = sdkTree('4.5.6')
    const { resolvedCursorSdkVersion } = await load(join(root, '..'))
    expect(resolvedCursorSdkVersion()).toBe('4.5.6')
  })

  it('answers `unavailable` when nothing resolved', async () => {
    const { resolvedCursorSdkVersion } = await load()
    expect(resolvedCursorSdkVersion({ available: false })).toBe('unavailable')
  })
})
