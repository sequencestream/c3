// Smoke/unit tests for the release orchestration skeleton (release 1/7).
// Proves: (1) phase order is Phase0 → Phase1 → Phase2, (2) target validation,
// (3) friendly→bun target mapping & outfile naming, (4) a built native product
// is executable (conditional — only when dist/<native>/c3 exists).
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { TARGETS, defaultOutfile } from '../../server/scripts/release/build-target.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const orchestrator = resolve(here, 'release-build.mjs')

function dryRun(args = []) {
  return spawnSync('node', [orchestrator, '--dry-run', ...args], {
    encoding: 'utf-8',
    cwd: repoRoot,
  })
}

describe('release-build orchestrator', () => {
  it('emits phases strictly in order Phase0 → Phase1 → Phase2', () => {
    const { stdout, status } = dryRun()
    expect(status).toBe(0)
    const i0 = stdout.indexOf('Phase0')
    const i1 = stdout.indexOf('Phase1')
    const i2 = stdout.indexOf('Phase2')
    expect(i0).toBeGreaterThanOrEqual(0)
    expect(i1).toBeGreaterThan(i0)
    expect(i2).toBeGreaterThan(i1)
  })

  it('Phase0=web build, Phase1=generate-static-embed, Phase2=compile', () => {
    const { stdout } = dryRun()
    expect(stdout).toMatch(/Phase0\s+web build/)
    expect(stdout).toMatch(/Phase1\s+generate-static-embed/)
    // Phase2 prints `bundle → compile (parallel)`.
    expect(stdout).toMatch(/Phase2\s+(.*\s+)?compile \(parallel\)/)
  })

  it('defaults to the P0 two-platform matrix', () => {
    const { stdout } = dryRun()
    expect(stdout).toContain('macos-arm64')
    expect(stdout).toContain('linux-x64')
  })

  it('honors --targets and lists only the requested targets', () => {
    const { stdout } = dryRun(['--targets=linux-x64'])
    expect(stdout).toContain('linux-x64')
    expect(stdout).not.toMatch(/compile \(parallel\): .*macos-arm64/)
  })

  it('rejects unknown targets with a non-zero exit', () => {
    const { status, stderr } = dryRun(['--targets=plan9-ppc'])
    expect(status).not.toBe(0)
    expect(stderr).toMatch(/unknown target/)
  })

  it('--dry-run executes nothing', () => {
    const { stdout } = dryRun()
    expect(stdout).toMatch(/nothing executed/)
  })
})

describe('build-target primitive', () => {
  it('maps the P0 friendly names to bun target triples', () => {
    expect(TARGETS['macos-arm64']).toBe('bun-darwin-arm64')
    expect(TARGETS['linux-x64']).toBe('bun-linux-x64')
  })

  it('names outfiles <friendly>/c3 under dist/ (per-target subdirs; binary is always `c3`)', () => {
    // Release 8/7: the BINARY is `c3` (or `c3.exe` on Windows). The per-target
    // subdir is internal scratch so parallel targets don't clobber each other.
    // The package (the distribution unit) carries the version + platform info.
    expect(defaultOutfile('macos-arm64').endsWith('/dist/macos-arm64/c3')).toBe(true)
    expect(defaultOutfile('linux-x64').endsWith('/dist/linux-x64/c3')).toBe(true)
    expect(defaultOutfile('macos-x64').endsWith('/dist/macos-x64/c3')).toBe(true)
    expect(defaultOutfile('windows-x64').endsWith('/dist/windows-x64/c3.exe')).toBe(true)
  })
})

describe('built native product (conditional)', () => {
  const candidates = ['macos-arm64', 'linux-x64'].map((t) => defaultOutfile(t))
  const product = candidates.find((p) => existsSync(p))

  it.runIf(product)('runs --version and prints version + commit + build time', () => {
    const { stdout, status } = spawnSync(product, ['--version'], { encoding: 'utf-8' })
    expect(status).toBe(0)
    const out = stdout.trim()
    expect(out).toMatch(/^v?\d+\.\d+\.\d+/) // git-describe or package.json baseline
    expect(out).toMatch(/commit [0-9a-f]{7}/)
    expect(out).toMatch(/built \S/)
  })
})
