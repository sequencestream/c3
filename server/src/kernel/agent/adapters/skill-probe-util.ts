/**
 * Best-effort version detectors for the {@link SkillSupportProbe.version} cache key
 * (mount layer 2/3). The value need only be *stable per installed version and
 * different across upgrades* — it gates cache invalidation, not correctness. When a
 * version can't be resolved we return a sentinel so the loader still functions
 * (it just won't re-probe on an upgrade it couldn't observe); a unit test injects a
 * controllable `version()` to prove invalidation deterministically.
 */
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'

/** Resolve an npm package's installed version via its `package.json`, or `'unknown'`. */
export function pkgVersion(pkg: string): string {
  try {
    const require = createRequire(import.meta.url)
    const meta = require(`${pkg}/package.json`) as { version?: unknown }
    return typeof meta.version === 'string' ? meta.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Resolve a host CLI's version via `<bin> --version`, or `'unavailable'` when the
 * binary is not on PATH / errors. `'unavailable'` doubles as the signal that the
 * vendor's CLI is absent, so a probe can map it to a `none` support state.
 */
export function cliVersion(bin: string): Promise<string> {
  return new Promise((done) => {
    execFile(bin, ['--version'], { timeout: 5_000 }, (err, stdout) => {
      if (err) return done('unavailable')
      const line = stdout.toString().trim().split('\n')[0]?.trim()
      done(line || 'unknown')
    })
  })
}
