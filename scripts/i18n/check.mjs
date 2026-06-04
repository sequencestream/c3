#!/usr/bin/env node
// i18n quality gate. Run via `pnpm i18n:check`.
//
// Four checks against the base locale (en):
//   1. coverage      — every base key present in each other locale (missing = ERROR), extra = WARN
//   2. placeholder   — {name}/{0}/ICU blocks and `|` plural-branch count preserved per key (mismatch = ERROR)
//   3. code -> key   — literal t('key') / $t('key') in web/src must exist in en.json (missing = ERROR);
//                      dynamic keys -> WARN (cannot statically verify); base keys never referenced -> WARN
//   4. code -> locale — the UI error-code SoT (shared/src/ui-codes.ts): every code's key exists in
//                      en.json and its declared params match that key's placeholders (mismatch = ERROR);
//                      every `error: { code: '...' }` emitted by server/src is in the SoT (unknown = ERROR);
//                      SoT codes never emitted by the server -> WARN.
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
const SERVER_DIR = join(REPO_ROOT, 'server', 'src')
const BASE_LOCALE = 'en'
// The typed-t wrapper itself calls `t(key, ...)` with a variable; not a usage site.
const CODE_SCAN_IGNORE = [join('web', 'src', 'i18n', 'index.ts')]

/**
 * Top-level keys that are locale-file metadata, not translations. The double-
 * underscore bracket (`__foo__`) makes them visually distinct and prevents
 * collisions with normal i18n leaf keys (which use `[a-zA-Z][a-zA-Z0-9._-]*`).
 * Only the top level is scanned: nested `__*__` keys are still real keys.
 */
const META_KEY_RE = /^__[A-Za-z][A-Za-z0-9_]*__$/
/**
 * Placeholder-name whitelist applied via WARNING. Allows translation-domain
 * names (`name`, `count`, `path`) and ICU list placeholders (`0`, `1`); catches
 * typos that happen to be valid JS identifiers but off-baseline (`{naem}`).
 * Frozen as WARN (not ERROR) to avoid false positives on legitimate ICU forms.
 */
const PLACEHOLDER_NAME_WHITELIST = /^(?:[a-z][a-zA-Z0-9_]*|\d+)$/

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in check.test.mjs)
// ---------------------------------------------------------------------------

/** Flatten a nested message object into a flat map of dot-joined leaf keys.
 *  Top-level `__*__` keys are metadata (e.g. `__humanReviewed__`) and skipped —
 *  they would otherwise be flagged as `[extra]` against the base locale. */
export function flatten(obj, prefix = '') {
  const out = {}
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (prefix === '' && META_KEY_RE.test(k)) continue
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

/** Names inside `{...}` tokens that look like simple identifiers (skip ICU/list
 *  forms whose contents are not a single identifier). */
function placeholderIdentNames(token) {
  // Strip the outer braces, then trim. ICU forms like `{count, plural, ...}` won't
  // match a pure identifier pattern and are skipped.
  const inner = token.replace(/^\{|\}$/g, '').trim()
  return /^[A-Za-z][A-Za-z0-9_]*$|^\d+$/.test(inner) ? [inner] : []
}

/** Return warning strings for placeholder names that fall outside the whitelist.
 *  Applies to BOTH base and target — a base typo is a future translator trap. */
export function checkPlaceholderNames(base, target, targetLocale) {
  const warnings = []
  function scan(map, loc) {
    for (const [k, v] of Object.entries(map)) {
      if (typeof v !== 'string') continue
      for (const tok of extractTokens(v).placeholders) {
        for (const name of placeholderIdentNames(tok)) {
          if (!PLACEHOLDER_NAME_WHITELIST.test(name)) {
            warnings.push(
              `[placeholder-name] locale '${loc}' key '${k}' uses non-whitelisted ` +
                `placeholder name '${name}' (expected ^[a-z][a-zA-Z0-9_]*$|^\\d+$)`,
            )
          }
        }
      }
    }
  }
  scan(base, BASE_LOCALE)
  if (targetLocale) scan(target, targetLocale)
  return warnings
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
    // Whitelist check fires per-target. Base scan runs once outside the loop.
    warnings.push(...checkPlaceholderNames({}, target, loc))
  }
  // Base placeholder-name scan (catches typos in en.json before they reach translators).
  warnings.push(...checkPlaceholderNames(base, {}, null))

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

/** Find `error: { code: '...' }` literals in server source — the UI error sites. */
export function scanServerCodes(codeFiles) {
  const sites = []
  // `error:` `{` `code:` `'<code>'` — the machine-readable UI error payload shape.
  const re = /error:\s*\{\s*code:\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g
  for (const { file, content } of codeFiles) {
    let m
    re.lastIndex = 0
    while ((m = re.exec(content))) sites.push({ file, code: m[2], line: lineAt(content, m.index) })
  }
  return sites
}

/** Simple `{name}` placeholder names in a message value (ICU/list tokens excluded). */
function placeholderNames(value) {
  return extractTokens(value)
    .placeholders.map((p) => p.replace(/^\{|\}$/g, '').trim())
    .filter((n) => /^[A-Za-z0-9_]+$/.test(n))
}

/**
 * Fourth check — UI error-code SoT (ui-codes.ts) consistency. Pure; caller supplies
 * `uiCodes` (UI_ERROR_CODES), `base` (flattened en.json), and `serverCodeSites`
 * (from {@link scanServerCodes}). Returns { errors[], warnings[] }.
 */
export function runCodeCheck({ uiCodes = {}, base = {}, serverCodeSites = [] }) {
  const errors = []
  const warnings = []
  const emitted = new Set(serverCodeSites.map((s) => s.code))

  for (const code of Object.keys(uiCodes)) {
    const def = uiCodes[code]
    if (!(def.key in base)) {
      errors.push(
        `[code->locale] code '${code}' maps to key '${def.key}' not in ${BASE_LOCALE}.json`,
      )
      continue
    }
    const declared = [...(def.params ?? [])].sort()
    const actual = placeholderNames(base[def.key]).sort()
    const same = declared.length === actual.length && declared.every((p, i) => p === actual[i])
    if (!same) {
      errors.push(
        `[code->locale] code '${code}' params ${JSON.stringify(declared)} diverge from key ` +
          `'${def.key}' placeholders ${JSON.stringify(actual)}`,
      )
    }
    if (!emitted.has(code))
      warnings.push(`[unused-code] code '${code}' in SoT is never emitted by server/src`)
  }
  for (const s of serverCodeSites) {
    if (!(s.code in uiCodes))
      errors.push(
        `[code->locale] ${s.file}:${s.line} server emits code '${s.code}' not in UI_ERROR_CODES (SoT)`,
      )
  }
  return { errors, warnings }
}

// ---------------------------------------------------------------------------
// I/O + CLI
// ---------------------------------------------------------------------------

function loadLocales() {
  const locales = {}
  for (const f of readdirSync(LOCALES_DIR)) {
    // Skip dotfiles (e.g. `.freeze-manifest.json`) — they are tooling state,
    // not locale catalogs. Only `xx.json` are real locales.
    if (!f.endsWith('.json') || f.startsWith('.')) continue
    locales[basename(f, '.json')] = JSON.parse(readFileSync(join(LOCALES_DIR, f), 'utf8'))
  }
  return locales
}

async function loadCodeFiles(dir, ignoreList = []) {
  const out = []
  const ignore = new Set(ignoreList.map((p) => join(REPO_ROOT, p)))
  async function walk(d) {
    for (const ent of await readdir(d, { withFileTypes: true })) {
      const full = join(d, ent.name)
      if (ent.isDirectory()) {
        await walk(full)
      } else if (/\.(ts|vue)$/.test(ent.name) && !ent.name.endsWith('.d.ts') && !ignore.has(full)) {
        out.push({ file: relative(REPO_ROOT, full), content: readFileSync(full, 'utf8') })
      }
    }
  }
  await walk(dir)
  return out
}

async function main() {
  // Freeze check first — fail fast on en.json drift before doing other work.
  const { runFreezeCheck } = await import('./check-freeze.mjs')
  const freeze = runFreezeCheck()
  for (const w of freeze.warnings) console.warn(`  warn  ${w}`)
  for (const e of freeze.errors) console.error(`  error ${e}`)
  if (!freeze.ok) {
    console.error(`\ni18n:check FAILED at freeze gate — ${freeze.errors.length} error(s).`)
    process.exit(1)
  }

  const locales = loadLocales()
  const codeFiles = await loadCodeFiles(CODE_DIR, CODE_SCAN_IGNORE)
  const { errors, warnings } = runCheck({ locales, codeFiles })

  // Fourth check: UI error-code SoT consistency (web codeFiles already loaded above).
  const { loadUiCodes } = await import('./load-ui-codes.mjs')
  const uiCodes = await loadUiCodes()
  const serverFiles = await loadCodeFiles(SERVER_DIR)
  const code = runCodeCheck({
    uiCodes,
    base: flatten(locales[BASE_LOCALE] ?? {}),
    serverCodeSites: scanServerCodes(serverFiles),
  })
  errors.push(...code.errors)
  warnings.push(...code.warnings)

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
