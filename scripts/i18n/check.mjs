#!/usr/bin/env node
// i18n quality gate. Run via `pnpm i18n:check`.
//
// Three checks against the base locale (en):
//   1. coverage      — every base key present in each other locale (missing = ERROR), extra = WARN
//   2. placeholder   — {name}/{0}/ICU blocks and `|` plural-branch count preserved per key (mismatch = ERROR)
//   3. code -> key   — literal t('key') / $t('key') in web/src must exist in en.json (missing = ERROR);
//                      dynamic keys -> WARN (cannot statically verify); base keys never referenced -> WARN
//
// ERROR -> exit 1 (CI red). Only warnings -> exit 0 (green). Empty en.json with no t() calls -> green.
// CLI args (e.g. filenames lint-staged appends) are ignored — the gate always scans the whole project.

import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, dirname, basename, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdir } from 'node:fs/promises'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const LOCALES_DIR = join(REPO_ROOT, 'web', 'src', 'locales')
const CODE_DIR = join(REPO_ROOT, 'web', 'src')
const BASE_LOCALE = 'en'
// The typed-t wrapper itself calls `t(key, ...)` with a variable; not a usage site.
const CODE_SCAN_IGNORE = [join('web', 'src', 'i18n', 'index.ts')]

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in check.test.mjs)
// ---------------------------------------------------------------------------

/** Flatten a nested message object into a flat map of dot-joined leaf keys. */
export function flatten(obj, prefix = '') {
  const out = {}
  for (const [k, v] of Object.entries(obj ?? {})) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flatten(v, key))
    } else {
      out[key] = v
    }
  }
  return out
}

/** Collapse internal whitespace so ICU blocks differing only in spacing compare equal. */
function normalizeToken(tok) {
  return tok.replace(/\s+/g, ' ').trim()
}

/**
 * Extract the translatable-invariant skeleton of a message: the multiset of
 * top-level `{...}` tokens (named / list / ICU, nested braces kept whole) and
 * the count of top-level `|` plural branches. This is the "replace variables
 * with non-translatable tokens" step — comparison happens on these tokens, so
 * a translation that renames {name}->{naam} or drops a branch is caught.
 */
export function extractTokens(value) {
  if (typeof value !== 'string') return { placeholders: [], pluralBranches: 1 }
  const placeholders = []
  let depth = 0
  let start = -1
  let pipes = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '{') {
      if (depth === 0) start = i
      depth++
    } else if (ch === '}') {
      if (depth > 0) {
        depth--
        if (depth === 0 && start >= 0) {
          placeholders.push(normalizeToken(value.slice(start, i + 1)))
          start = -1
        }
      }
    } else if (ch === '|' && depth === 0) {
      pipes++
    }
  }
  return { placeholders, pluralBranches: pipes + 1 }
}

/** Compare placeholder multiset + plural-branch count between source and target. */
export function comparePlaceholders(srcValue, tgtValue) {
  const a = extractTokens(srcValue)
  const b = extractTokens(tgtValue)
  const sa = [...a.placeholders].sort()
  const sb = [...b.placeholders].sort()
  const samePlaceholders = sa.length === sb.length && sa.every((x, i) => x === sb[i])
  const samePlural = a.pluralBranches === b.pluralBranches
  return {
    ok: samePlaceholders && samePlural,
    expected: { placeholders: sa, pluralBranches: a.pluralBranches },
    actual: { placeholders: sb, pluralBranches: b.pluralBranches },
  }
}

/** Keys present in base but not target (missing), and present in target but not base (extra). */
export function diffKeys(base, target) {
  return {
    missing: Object.keys(base).filter((k) => !(k in target)),
    extra: Object.keys(target).filter((k) => !(k in base)),
  }
}

function lineAt(content, index) {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === '\n') line++
  return line
}

/**
 * Find `t('key')` / `$t('key')` / `.t('key')` calls in source. Returns literal
 * keys (statically verifiable) and dynamic call sites (key is a variable /
 * template literal — skipped, surfaced as a warning).
 */
export function scanCodeKeys(codeFiles) {
  const literal = []
  const dynamic = []
  // `t(` / `$t(` / `.t(` not preceded by an identifier char (so `count(`, `await(` don't match).
  const litRe = /(?<![\w$])\$?t\s*\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g
  const callRe = /(?<![\w$])\$?t\s*\(\s*([^\s)])/g
  // `<i18n-t keypath="key">` (and `:keypath="'key'"`) — the Translation component's
  // static key. Matched as a literal usage so its key isn't flagged unused.
  const keypathRe = /\bkeypath\s*=\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g
  for (const { file, content } of codeFiles) {
    let m
    litRe.lastIndex = 0
    while ((m = litRe.exec(content)))
      literal.push({ file, key: m[2], line: lineAt(content, m.index) })
    keypathRe.lastIndex = 0
    while ((m = keypathRe.exec(content))) {
      let key = m[2]
      // `:keypath="'key'"` — strip the inner quotes of the bound string literal.
      const inner = key.match(/^\s*(['"])(.*)\1\s*$/)
      if (inner) key = inner[2]
      literal.push({ file, key, line: lineAt(content, m.index) })
    }
    callRe.lastIndex = 0
    while ((m = callRe.exec(content))) {
      const first = m[1]
      if (first !== "'" && first !== '"') dynamic.push({ file, line: lineAt(content, m.index) })
    }
  }
  return { literal, dynamic }
}

/** Run all three checks. Returns { errors[], warnings[] }. Pure — caller supplies data. */
export function runCheck({ baseLocale = BASE_LOCALE, locales, codeFiles = [] }) {
  const errors = []
  const warnings = []
  const base = flatten(locales[baseLocale] ?? {})
  const baseKeys = Object.keys(base)

  for (const [loc, data] of Object.entries(locales)) {
    if (loc === baseLocale) continue
    const target = flatten(data)
    const { missing, extra } = diffKeys(base, target)
    for (const k of missing) errors.push(`[coverage] locale '${loc}' is missing key: ${k}`)
    for (const k of extra)
      warnings.push(`[extra] locale '${loc}' has key not in '${baseLocale}': ${k}`)
    for (const k of baseKeys) {
      if (!(k in target)) continue
      const cmp = comparePlaceholders(base[k], target[k])
      if (!cmp.ok) {
        errors.push(
          `[placeholder] locale '${loc}' key '${k}' diverges from '${baseLocale}' — ` +
            `expected ${JSON.stringify(cmp.expected)}, got ${JSON.stringify(cmp.actual)}`,
        )
      }
    }
  }

  const scan = scanCodeKeys(codeFiles)
  const used = new Set()
  for (const { file, key, line } of scan.literal) {
    used.add(key)
    if (!(key in base)) {
      errors.push(
        `[code->key] ${file}:${line} t('${key}') references a key not in ${baseLocale}.json`,
      )
    }
  }
  for (const { file, line } of scan.dynamic) {
    warnings.push(`[code->key] ${file}:${line} dynamic key in t(...) — cannot statically verify`)
  }
  for (const k of baseKeys) {
    if (!used.has(k))
      warnings.push(`[unused] key '${k}' in ${baseLocale}.json is never referenced in code`)
  }

  return { errors, warnings }
}

// ---------------------------------------------------------------------------
// I/O + CLI
// ---------------------------------------------------------------------------

function loadLocales() {
  const locales = {}
  for (const f of readdirSync(LOCALES_DIR)) {
    if (!f.endsWith('.json')) continue
    locales[basename(f, '.json')] = JSON.parse(readFileSync(join(LOCALES_DIR, f), 'utf8'))
  }
  return locales
}

async function loadCodeFiles() {
  const out = []
  const ignore = new Set(CODE_SCAN_IGNORE.map((p) => join(REPO_ROOT, p)))
  async function walk(dir) {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(full)
      } else if (/\.(ts|vue)$/.test(ent.name) && !ent.name.endsWith('.d.ts') && !ignore.has(full)) {
        out.push({ file: relative(REPO_ROOT, full), content: readFileSync(full, 'utf8') })
      }
    }
  }
  await walk(CODE_DIR)
  return out
}

async function main() {
  const locales = loadLocales()
  const codeFiles = await loadCodeFiles()
  const { errors, warnings } = runCheck({ locales, codeFiles })

  for (const w of warnings) console.warn(`  warn  ${w}`)
  for (const e of errors) console.error(`  error ${e}`)

  const localeCount = Object.keys(locales).length
  if (errors.length) {
    console.error(`\ni18n:check FAILED — ${errors.length} error(s), ${warnings.length} warning(s).`)
    process.exit(1)
  }
  console.log(`i18n:check OK — ${localeCount} locale(s), ${warnings.length} warning(s), 0 errors.`)
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : ''
if (invokedPath && invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
