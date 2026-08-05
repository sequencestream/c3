// Unit tests for the Cursor SDK sidecar assembly.
//
// The network-touching half (`stageSidecar` runs npm) is exercised by the binary
// sidecar probe, which needs a real toolchain; what is pinned here is everything
// that decides whether a released archive is HONEST: the target→platform mapping,
// the exact-version rule, the root-entry shims a standalone binary needs, and the
// verification that refuses a tree carrying another platform's package.
import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SDK_PACKAGE,
  generateEntryShims,
  listPackages,
  moveTree,
  pinnedSdkVersion,
  platformPackageFor,
  stageParentDir,
  verifySidecar,
} from './sidecar.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')

function scratch() {
  return mkdtempSync(join(tmpdir(), 'c3-sidecar-test-'))
}

/** Write a package into a `node_modules` root. */
function writePackage(root, name, meta, files = {}) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...meta }))
  for (const [rel, body] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
  }
  return dir
}

/** A minimal but complete sidecar for one target. */
function completeTree(target, version = '1.2.3') {
  const home = scratch()
  const root = join(home, 'node_modules')
  mkdirSync(root, { recursive: true })
  writePackage(
    root,
    SDK_PACKAGE,
    { version, main: './dist/cjs/index.js' },
    {
      'dist/cjs/index.js': 'module.exports = {}\n',
    },
  )
  writePackage(root, platformPackageFor(target), {}, { 'bin/rg': '' })
  writePackage(root, 'zod', { main: './index.cjs' }, { 'index.cjs': 'module.exports = {}\n' })
  return { home, root }
}

describe('target → platform package', () => {
  it('names the platform package each P0 target must carry', () => {
    expect(platformPackageFor('macos-arm64')).toBe('@cursor/sdk-darwin-arm64')
    expect(platformPackageFor('linux-x64')).toBe('@cursor/sdk-linux-x64')
    expect(platformPackageFor('windows-x64')).toBe('@cursor/sdk-win32-x64')
  })

  it('refuses a target it has no platform mapping for', () => {
    expect(() => platformPackageFor('plan9-sparc')).toThrow(/unknown target/)
  })
})

describe('pinnedSdkVersion', () => {
  it('reads the exact version the server depends on', () => {
    const meta = JSON.parse(readFileSync(join(repoRoot, 'server', 'package.json'), 'utf-8'))
    expect(pinnedSdkVersion()).toBe(meta.dependencies[SDK_PACKAGE])
  })

  it('rejects a range — the sidecar and an npm install must never differ', () => {
    const dir = scratch()
    const path = join(dir, 'package.json')
    writeFileSync(path, JSON.stringify({ dependencies: { [SDK_PACKAGE]: '^1.0.0' } }))
    expect(() => pinnedSdkVersion(path)).toThrow(/exact version/)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('generateEntryShims', () => {
  it('gives every package a root entry, because a binary reads no package.json', () => {
    const { home, root } = completeTree('macos-arm64')
    const result = generateEntryShims(root)
    // The SDK's entry is in `dist/`, so it gets a shim; zod's is already at the
    // root, so it is left alone; the platform package has no module entry at all.
    expect(result.shimmed).toContain(SDK_PACKAGE)
    expect(result.native).toContain('zod')
    expect(result.binOnly).toContain('@cursor/sdk-darwin-arm64')
    expect(readFileSync(join(root, SDK_PACKAGE, 'index.cjs'), 'utf-8')).toBe(
      "module.exports = require('./dist/cjs/index.js')\n",
    )
    rmSync(home, { recursive: true, force: true })
  })

  it('re-exports through a relative path, which is what actually resolves', () => {
    const { home, root } = completeTree('linux-x64')
    generateEntryShims(root)
    const shim = readFileSync(join(root, SDK_PACKAGE, 'index.cjs'), 'utf-8')
    expect(shim).toMatch(/require\('\.\//)
    expect(shim).not.toMatch(/require\('\//)
    rmSync(home, { recursive: true, force: true })
  })
})

describe('verifySidecar', () => {
  it('accepts a complete, target-correct tree', () => {
    const { home, root } = completeTree('macos-arm64')
    generateEntryShims(root)
    const summary = verifySidecar({ root, target: 'macos-arm64', version: '1.2.3' })
    expect(summary.platformPackage).toBe('@cursor/sdk-darwin-arm64')
    rmSync(home, { recursive: true, force: true })
  })

  it('refuses a build-host platform package that leaked into another target', () => {
    const { home, root } = completeTree('linux-x64')
    generateEntryShims(root)
    writePackage(root, '@cursor/sdk-darwin-arm64', {}, { 'bin/rg': '' })
    expect(() => verifySidecar({ root, target: 'linux-x64', version: '1.2.3' })).toThrow(
      /foreign platform package/,
    )
    rmSync(home, { recursive: true, force: true })
  })

  it('refuses a tree missing this target’s platform package', () => {
    const { home, root } = completeTree('macos-arm64')
    generateEntryShims(root)
    rmSync(join(root, '@cursor/sdk-darwin-arm64'), { recursive: true, force: true })
    expect(() => verifySidecar({ root, target: 'macos-arm64', version: '1.2.3' })).toThrow(
      /platform package .* missing/,
    )
    rmSync(home, { recursive: true, force: true })
  })

  it('refuses a platform package with no payload', () => {
    const { home, root } = completeTree('macos-arm64')
    generateEntryShims(root)
    rmSync(join(root, '@cursor/sdk-darwin-arm64', 'bin'), { recursive: true, force: true })
    expect(() => verifySidecar({ root, target: 'macos-arm64', version: '1.2.3' })).toThrow(
      /no bin\/ payload/,
    )
    rmSync(home, { recursive: true, force: true })
  })

  it('refuses a version that does not match the pin', () => {
    const { home, root } = completeTree('macos-arm64', '9.9.9')
    generateEntryShims(root)
    expect(() => verifySidecar({ root, target: 'macos-arm64', version: '1.2.3' })).toThrow(
      /version mismatch/,
    )
    rmSync(home, { recursive: true, force: true })
  })

  it('refuses a package a binary could not reach — an unshimmed tree', () => {
    const { home, root } = completeTree('macos-arm64')
    // No shims generated: the SDK's entry lives in dist/, so a binary cannot
    // resolve it, and shipping that would strand Cursor at the first run.
    expect(() => verifySidecar({ root, target: 'macos-arm64', version: '1.2.3' })).toThrow(
      /no root entry/,
    )
    rmSync(home, { recursive: true, force: true })
  })
})

describe('staging locality', () => {
  it('stages next to the destination, never in the OS temp dir', () => {
    // The Windows runner has TEMP on C: and the workspace on D:, so a temp-dir
    // staging prefix makes the move into dist/ a cross-volume rename (EXDEV).
    expect(stageParentDir('/build/dist/windows-x64')).toBe(resolve('/build/dist'))
    expect(stageParentDir('dist/windows-x64')).toBe(resolve('dist'))
    expect(stageParentDir('/build/dist/windows-x64').startsWith(tmpdir())).toBe(false)
  })

  it('moveTree relocates a tree and leaves nothing at the source', () => {
    const home = scratch()
    const src = join(home, 'staged')
    mkdirSync(join(src, 'pkg'), { recursive: true })
    writeFileSync(join(src, 'pkg', 'index.cjs'), 'module.exports = 1\n')

    moveTree(src, join(home, 'node_modules'))

    expect(existsSync(src)).toBe(false)
    expect(readFileSync(join(home, 'node_modules', 'pkg', 'index.cjs'), 'utf-8')).toContain(
      'module.exports',
    )
    rmSync(home, { recursive: true, force: true })
  })
})

describe('listPackages', () => {
  it('walks scoped and unscoped alike, and skips npm bookkeeping', () => {
    const { home, root } = completeTree('macos-arm64')
    mkdirSync(join(root, '.bin'), { recursive: true })
    const names = listPackages(root)
    expect(names).toContain(SDK_PACKAGE)
    expect(names).toContain('zod')
    expect(names).not.toContain('.bin')
    rmSync(home, { recursive: true, force: true })
  })
})
