// Obfuscation helper (release 7/7) — thin, opinionated wrapper around
// `javascript-obfuscator` used by the standard harden tier ONLY.
//
// Why a helper, not inline:
//   - Single place to LOCK the option set. The user-visible spec is "string-array +
//     identifier rename". Aggressive options (controlFlowFlattening, deadCodeInjection,
//     stringEncryption, selfDefending, debugProtection, …) are NOT exposed here on
//     purpose — see specs/non-functional/security.md "Non-goal: hardening" for the
//     full NOT-doing list and the reasons.
//   - Single place to time and fall back. `obfuscateStage()` wraps the call in a
//     timeout + try/catch and returns a uniform { obfuscated, durationMs, error? }
//     so the build primitive can decide without an outer try/catch.
//
// Pure node helper. No deps on other release scripts.
//
// CLI / library entry:
//   import { obfuscateStage, isObfuscationEnabled, decideFallback } from './obfuscate.mjs'
//
// Notes on the option set:
//   - `stringArray: true` + `stringArrayThreshold: 1.0`  → ALL string literals get
//     hoisted into a rotating shuffled array. ~ +10–30% bundle size, near-zero
//     runtime overhead for our use.
//   - `identifierNamesGenerator: 'mangled'` + `renameGlobals: false` → local vars
//     get short names; globals stay (so bun runtime / Node builtins / dlsym lookups
//     keep finding them). Anything more aggressive breaks interop.
//   - `sourceMap: true` + `sourceMapMode: 'separate'` → we get a sidecar map
//     (dist/maps/<target>.js.map) the maintainer can re-symbolicate on demand.
//   - `transformObjectKeys: false` → object-key access by string would break if we
//     rewrote keys; we don't.
//   - `selfDefending: false` / `debugProtection: false` → anti-debug traps
//     false-positive our smoke tests and CI.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import JavaScriptObfuscator from 'javascript-obfuscator'

/** @typedef {{ obfuscated: boolean, durationMs: number, outPath: string, mapPath: string | null, warnings: string[], error?: string }} ObfuscateResult */

/**
 * Should we run obfuscation right now?
 * Reads `RELEASE_HARDEN` env, returns true iff it equals `standard`.
 * Honored by the build primitive before invoking `obfuscateStage`.
 */
export function isObfuscationEnabled(env = process.env) {
  return String(env.RELEASE_HARDEN ?? '').toLowerCase() === 'standard'
}

/**
 * Decide the fallback mode when obfuscation fails.
 *   'bare' — proceed with the un-obfuscated (minified) bundle; warn + record
 *            `obfuscation.applied: false` in the manifest.
 *   'abort' — refuse to ship; hard fail the build.
 *
 * Default policy is 'bare' (graceful). 'abort' is reserved for explicit user override
 * via `C3_OBFUSCATE_FAIL=abort` (used by tests that need a red signal, not by
 * production).
 */
export function decideFallback(err, env = process.env) {
  return String(env.C3_OBFUSCATE_FAIL ?? '').toLowerCase() === 'abort' ? 'abort' : 'bare'
}

/**
 * Read the obfuscator timeout (ms). Default 60s — the c3 server bundle obfuscates
 * in 5–15s; 60s is a generous safety belt that still surfaces pathological inputs.
 */
export function obfuscateTimeoutMs(env = process.env) {
  const v = Number(env.C3_OBFUSCATE_TIMEOUT_MS)
  return Number.isFinite(v) && v > 0 ? v : 60_000
}

/** Per-test/CLI override: force failure to exercise the fallback path. */
export function shouldForceFailure(env = process.env) {
  return String(env.C3_OBFUSCATE_FORCE_FAIL ?? '').length > 0
}

/**
 * Options for the obfuscator. The full set is locked here so callers can't sneak
 * aggressive options in by accident. Exported for unit tests that want to assert
 * the policy (e.g. "controlFlowFlattening is OFF").
 */
export const OBFUSCATOR_OPTIONS = Object.freeze({
  compact: true,
  identifierNamesGenerator: 'mangled',
  renameGlobals: false,
  stringArray: true,
  stringArrayThreshold: 1.0,
  stringArrayEncoding: [],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
  selfDefending: false,
  debugProtection: false,
  numbersToExpressions: false,
  simplify: false,
  splitStrings: false,
  sourceMap: true,
  sourceMapMode: 'separate',
})

/**
 * Run obfuscation on an already-bundled JS file in place.
 *
 * @param {object} o
 * @param {string} o.inPath   absolute path to the bundled JS (input)
 * @param {string} o.outPath  absolute path to write the obfuscated JS (output)
 * @param {string} [o.mapPath] absolute path for the sidecar source map; defaults to
 *   `dist/maps/<basename(outPath)>.map`. The caller is responsible for ensuring the
 *   parent dir exists.
 * @param {number} [o.timeoutMs]
 * @param {object} [o.env]   env-override for testability (defaults to process.env).
 *   Production callers should never pass this; tests inject to control
 *   `C3_OBFUSCATE_FORCE_FAIL` and `C3_OBFUSCATE_TIMEOUT_MS` deterministically.
 * @returns {ObfuscateResult}
 */
export function obfuscateStage({ inPath, outPath, mapPath, timeoutMs, env } = {}) {
  if (!inPath || !outPath) {
    throw new Error('[obfuscate] inPath and outPath are required')
  }
  const envSource = env ?? process.env
  const effectiveTimeout = timeoutMs ?? obfuscateTimeoutMs(envSource)
  const t0 = Date.now()
  const warnings = []

  if (shouldForceFailure(envSource)) {
    // Hook for unit tests: pretend the obfuscator blew up so the build primitive
    // exercises the fallback. The env var is documented; production never sets it.
    return {
      obfuscated: false,
      durationMs: Date.now() - t0,
      outPath,
      mapPath: mapPath ?? null,
      warnings,
      error: 'forced failure (C3_OBFUSCATE_FORCE_FAIL set)',
    }
  }

  const input = readFileSync(inPath, 'utf-8')
  let result
  try {
    // The obfuscator is synchronous but a runaway regex / huge input could still
    // wedge; wrap with a soft timeout. We can't actually interrupt sync JS, so the
    // guard is "abort if we crossed the deadline" — measured at start. In practice
    // our bundle obfuscates in seconds.
    result = JavaScriptObfuscator.obfuscate(input, OBFUSCATOR_OPTIONS)
  } catch (err) {
    return {
      obfuscated: false,
      durationMs: Date.now() - t0,
      outPath,
      mapPath: mapPath ?? null,
      warnings,
      error: `obfuscator threw: ${err?.message ?? String(err)}`,
    }
  }
  const durationMs = Date.now() - t0
  if (durationMs > effectiveTimeout) {
    return {
      obfuscated: false,
      durationMs,
      outPath,
      mapPath: mapPath ?? null,
      warnings,
      error: `obfuscation took ${durationMs}ms (timeout ${effectiveTimeout}ms)`,
    }
  }

  const code = result.getObfuscatedCode()
  if (!code || typeof code !== 'string' || code.length === 0) {
    return {
      obfuscated: false,
      durationMs,
      outPath,
      mapPath: mapPath ?? null,
      warnings,
      error: 'obfuscator returned empty code',
    }
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, code, 'utf-8')

  let writtenMapPath = null
  if (result.getSourceMap) {
    const map = result.getSourceMap()
    if (map && typeof map === 'string' && map.length > 0) {
      const mp = mapPath ?? resolve(dirname(outPath), '..', 'maps', `${basename(outPath)}.map`)
      mkdirSync(dirname(mp), { recursive: true })
      writeFileSync(mp, map, 'utf-8')
      writtenMapPath = mp
    }
  }

  // Sanity: a real obfuscation pass produces code longer than the input (the
  // string-array wrapper + identifier rename both ADD characters). If we got a
  // shorter output, something went sideways (e.g. a wrong-options combination
  // that silently no-ops). Surface as a warning — not a hard error, because
  // contrived tiny inputs CAN be shorter after minify + rename.
  if (code.length < input.length) {
    warnings.push(
      `obfuscated output (${code.length}B) is SHORTER than input (${input.length}B) — verify options`,
    )
  }

  return { obfuscated: true, durationMs, outPath, mapPath: writtenMapPath, warnings }
}

function basename(p) {
  const i = p.lastIndexOf('/')
  const j = p.lastIndexOf('\\')
  const k = Math.max(i, j)
  return k >= 0 ? p.slice(k + 1) : p
}

// CLI: `node obfuscate.mjs --in=... --out=... [--map=...]`
// Used by hand for debugging; the release path calls obfuscateStage() directly.
/* global Bun */
// ^ When run under `bun` (Bun.main check), Bun is a runtime global; eslint doesn't know.
function parseArgs(argv) {
  const o = {}
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a)
    if (m) o[m[1]] = m[2]
    else if (a.startsWith('--')) o[a.slice(2)] = true
  }
  return o
}

const isMain = (() => {
  try {
    return import.meta.path === Bun.main
  } catch {
    return false
  }
})()

if (isMain) {
  const a = parseArgs(process.argv.slice(2))
  if (!a.in || !a.out) {
    console.error('usage: obfuscate.mjs --in=<bundle.js> --out=<obf.js> [--map=<out.js.map>]')
    process.exit(2)
  }
  const r = obfuscateStage({ inPath: a.in, outPath: a.out, mapPath: a.map })
  console.log(
    `[obfuscate] obfuscated=${r.obfuscated} duration=${r.durationMs}ms` +
      (r.error ? ` error=${r.error}` : '') +
      (r.warnings.length ? ` warnings=${r.warnings.length}` : ''),
  )
  if (!r.obfuscated) {
    process.exit(1)
  }
}
