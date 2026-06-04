#!/usr/bin/env node
// i18n text extractor. Run via `pnpm i18n:extract`.
//
// Two modes:
//   scan (default) — AST-walk every web/src/**/*.vue template, collect translatable
//                    text nodes + whitelisted attributes (title/placeholder/alt/aria-label/…),
//                    emit a stable per-file "candidate key -> source text" report to
//                    scripts/i18n/extract.candidates.json. Draft keys are SUGGESTIONS only;
//                    final key naming + interpolation splitting is decided by humans.
//   --emit <map>   — read a finalized { "<dot.key>": "<text>" } mapping and merge it into
//                    the nested web/src/locales/en.json skeleton (collision = error, never
//                    silently overwrites).
//
// Repeatable & deterministic: output is sorted (file -> line -> column) and deduped, so two
// runs over an unchanged tree produce byte-identical candidates. CLI args other than the
// recognised flags are ignored (safe under lint-staged), the scan always walks the whole tree.

import { readFileSync, readdirSync, writeFileSync, realpathSync } from 'node:fs'
import { join, dirname, basename, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseVue } from 'vue-eslint-parser'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const CODE_DIR = join(REPO_ROOT, 'web', 'src')
const LOCALES_DIR = join(REPO_ROOT, 'web', 'src', 'locales')
const CANDIDATES_OUT = join(HERE, 'extract.candidates.json')

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in extract.test.mjs)
// ---------------------------------------------------------------------------

/**
 * Attributes whose value is human-visible prose and must be extracted.
 * Exhaustive on text-bearing attrs to avoid leaks; deliberately EXCLUDES ARIA
 * state/relationship attrs (aria-hidden/expanded/pressed/haspopup/modal/checked/…)
 * which carry booleans/ids/tokens, not translatable text.
 */
export const TRANSLATABLE_ATTRS = new Set([
  'title',
  'placeholder',
  'alt',
  'label',
  'badge',
  'content',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
])

/** True if the string carries translatable prose (≥1 Unicode letter, not pure punctuation/number/symbol). */
export function isTranslatableText(s) {
  if (typeof s !== 'string') return false
  const t = s.trim()
  if (!t) return false
  return /\p{L}/u.test(t)
}

/** Collapse a free-text string into a camelCase slug of up to `maxWords` words. */
export function slugify(text, maxWords = 5) {
  const words = String(text)
    .toLowerCase()
    .replace(/[`'’"]/g, '')
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .slice(0, maxWords)
  if (!words.length) return 'text'
  return words.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('')
}

// File-path → frozen namespace heuristic (see specs/style/i18n-spec.md §2.1).
const NS_RULES = [
  [/permissionprompt/i, 'permission'],
  [/discussion/i, 'discussion'],
  [/requirement/i, 'requirement'],
  [/schedule/i, 'schedule'],
  [/session/i, 'session'],
  [/systemsettings|settingspanel/i, 'settings'],
  [/appheader|workspaceswitcher|basedropdown/i, 'nav'],
]

/** Guess one of the nine frozen namespaces from a file path. Returns { namespace, nsGuess }. */
export function deriveNamespace(filePath) {
  for (const [re, ns] of NS_RULES) {
    if (re.test(filePath)) return { namespace: ns, nsGuess: false }
  }
  return { namespace: 'common', nsGuess: true }
}

/** camelCase subject from the component file's base name (AppHeader.vue -> appHeader). */
export function deriveSubject(filePath) {
  const base = basename(filePath).replace(/\.vue$/, '')
  return base.charAt(0).toLowerCase() + base.slice(1)
}

/** UI-role suffix per attribute (§2.2). null = plain body/message (no suffix). */
export function attrSuffix(attr) {
  if (attr === 'title') return 'tooltip'
  if (attr === 'placeholder') return 'placeholder'
  if (attr === 'alt' || attr === 'label' || attr === 'aria-label' || attr === 'aria-description')
    return 'label'
  return null
}

/**
 * Suggest a DRAFT key `<namespace>.<subject>.<slug>[.<suffix>]` (§2). Always a
 * suggestion — humans finalise naming and interpolation splitting.
 */
export function suggestKey({ filePath, text, attr }) {
  const { namespace, nsGuess } = deriveNamespace(filePath)
  const subject = deriveSubject(filePath)
  const slug = slugify(text)
  const suffix = attrSuffix(attr)
  const segs = [namespace, subject, slug]
  if (suffix) segs.push(suffix)
  return { key: segs.join('.'), nsGuess }
}

/** Strip <script> blocks (keeping newlines) so the JS parser won't choke on `lang="ts"`. */
function stripScripts(code) {
  return code.replace(/<script[\s\S]*?<\/script>/g, (m) => m.replace(/[^\n]/g, ' '))
}

/**
 * Extract candidates from one SFC. Returns an array of:
 *   { file, line, column, kind, attr, text, suggestedKey, nsGuess }
 * kind ∈ 'text' | 'mustache-literal' | 'attr' | 'bind-literal' | 'dynamic'.
 * Dynamic nodes (variable / concatenated expressions) are recorded but get no
 * suggestedKey — they need manual interpolation splitting (§ scope).
 */
export function extractFromSfc({ file, code }) {
  const out = []
  let ast
  try {
    ast = parseVue(stripScripts(code), { sourceType: 'module', ecmaVersion: 2022 })
  } catch (err) {
    return { candidates: out, error: err.message }
  }
  if (!ast.templateBody) return { candidates: out, error: null }

  const push = (node, { kind, attr = null, text }) => {
    const loc = node.loc?.start ?? { line: 0, column: 0 }
    const base = { file, line: loc.line, column: loc.column, kind, attr, text }
    if (kind === 'dynamic') {
      out.push({ ...base, suggestedKey: null, nsGuess: false })
    } else {
      const { key, nsGuess } = suggestKey({ filePath: file, text, attr })
      out.push({ ...base, suggestedKey: key, nsGuess })
    }
  }

  const visit = (node) => {
    if (!node || typeof node !== 'object') return

    if (node.type === 'VText' && isTranslatableText(node.value)) {
      push(node, { kind: 'text', text: node.value.trim() })
    }

    // Only mustache `{{ }}` in element content — skip containers that are a directive's value
    // (those are handled by the VAttribute/directive branch below).
    if (
      node.type === 'VExpressionContainer' &&
      node.expression &&
      node.parent?.type !== 'VAttribute'
    ) {
      const ex = node.expression
      if (ex.type === 'Literal' && typeof ex.value === 'string' && isTranslatableText(ex.value)) {
        push(node, { kind: 'mustache-literal', text: ex.value.trim() })
      } else if (ex.type !== 'VFilterSequenceExpression') {
        const raw = code.slice(node.range[0], node.range[1])
        if (/['"`][^'"`]*\p{L}[^'"`]*['"`]/u.test(raw))
          push(node, { kind: 'dynamic', text: raw.trim() })
      }
    }

    if (node.type === 'VAttribute' && node.directive === false) {
      const name = node.key?.name
      if (TRANSLATABLE_ATTRS.has(name) && node.value && isTranslatableText(node.value.value)) {
        push(node, { kind: 'attr', attr: name, text: node.value.value.trim() })
      }
    }

    if (node.type === 'VAttribute' && node.directive === true) {
      const arg = node.key?.argument?.name
      if (arg && TRANSLATABLE_ATTRS.has(arg)) {
        const ex = node.value?.expression
        if (
          ex?.type === 'Literal' &&
          typeof ex.value === 'string' &&
          isTranslatableText(ex.value)
        ) {
          push(node, { kind: 'bind-literal', attr: arg, text: ex.value.trim() })
        } else if (ex) {
          push(node, {
            kind: 'dynamic',
            attr: arg,
            text: code.slice(ex.range[0], ex.range[1]).trim(),
          })
        }
      }
    }

    for (const k of Object.keys(node)) {
      if (k === 'parent' || k === 'loc' || k === 'range') continue
      const v = node[k]
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v === 'object' && v.type) visit(v)
    }
  }

  visit(ast.templateBody)
  return { candidates: out, error: null }
}

/**
 * Build the per-file candidate report from { file, code } inputs.
 * Deterministic: files sorted, candidates sorted by line→column→attr→text, and
 * duplicates (same file+attr+text) collapsed with an `occurrences` count.
 */
export function buildCandidates(files) {
  const byFile = {}
  const errors = []
  let total = 0
  let dynamic = 0
  let nsGuess = 0

  for (const { file, code } of files) {
    const { candidates, error } = extractFromSfc({ file, code })
    if (error) errors.push({ file, error })
    if (!candidates.length) continue

    const merged = new Map()
    for (const c of candidates) {
      const dedupeKey = `${c.attr ?? ''} ${c.kind === 'dynamic' ? `dyn:${c.text}` : c.text}`
      const prev = merged.get(dedupeKey)
      if (prev) {
        prev.occurrences++
      } else {
        merged.set(dedupeKey, { ...c, occurrences: 1 })
      }
    }
    const list = [...merged.values()].sort(
      (a, b) =>
        a.line - b.line ||
        a.column - b.column ||
        (a.attr ?? '').localeCompare(b.attr ?? '') ||
        a.text.localeCompare(b.text),
    )
    byFile[file] = list
    total += list.length
    for (const c of list) {
      if (c.kind === 'dynamic') dynamic++
      if (c.nsGuess) nsGuess++
    }
  }

  const sorted = {}
  for (const f of Object.keys(byFile).sort()) sorted[f] = byFile[f]
  return {
    summary: { files: Object.keys(sorted).length, candidates: total, dynamic, nsGuess },
    errors,
    byFile: sorted,
  }
}

/** Set a dotted key path on a nested object; throw on any collision with an existing leaf/branch. */
export function setDeep(obj, dotKey, value) {
  const segs = dotKey.split('.')
  let cur = obj
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]
    if (cur[s] === undefined) cur[s] = {}
    else if (typeof cur[s] !== 'object' || Array.isArray(cur[s])) {
      throw new Error(
        `key collision at '${segs.slice(0, i + 1).join('.')}' (leaf vs branch) for '${dotKey}'`,
      )
    }
    cur = cur[s]
  }
  const last = segs[segs.length - 1]
  if (cur[last] !== undefined) {
    if (typeof cur[last] === 'object') {
      throw new Error(`key collision at '${dotKey}' (branch already exists)`)
    }
    if (cur[last] !== value) {
      throw new Error(`key collision at '${dotKey}': '${cur[last]}' vs '${value}'`)
    }
    return // identical re-emit is a no-op
  }
  cur[last] = value
}

/** Merge a flat { dot.key: text } mapping into a (possibly nested) base locale object. */
export function mergeIntoLocale(baseObj, mapping) {
  const out = structuredClone(baseObj ?? {})
  for (const [key, value] of Object.entries(mapping)) setDeep(out, key, value)
  return out
}

// ---------------------------------------------------------------------------
// I/O + CLI
// ---------------------------------------------------------------------------

function loadVueFiles() {
  const out = []
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name)
      if (ent.isDirectory()) walk(full)
      else if (ent.name.endsWith('.vue'))
        out.push({ file: relative(REPO_ROOT, full), code: readFileSync(full, 'utf8') })
    }
  }
  walk(CODE_DIR)
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

function runScan() {
  const report = buildCandidates(loadVueFiles())
  writeFileSync(CANDIDATES_OUT, JSON.stringify(report, null, 2) + '\n', 'utf8')
  const { files, candidates, dynamic, nsGuess } = report.summary
  console.log(`i18n:extract scan — ${candidates} candidate(s) across ${files} file(s)`)
  console.log(`  ${dynamic} dynamic (manual split), ${nsGuess} namespace-guessed (review)`)
  console.log(`  written to ${relative(REPO_ROOT, CANDIDATES_OUT)}`)
  if (report.errors.length) {
    for (const e of report.errors) console.warn(`  warn  parse failed: ${e.file} — ${e.error}`)
  }
}

function runEmit(mapPath) {
  const mapping = JSON.parse(readFileSync(resolve(REPO_ROOT, mapPath), 'utf8'))
  const enPath = join(LOCALES_DIR, 'en.json')
  const base = JSON.parse(readFileSync(enPath, 'utf8'))
  const merged = mergeIntoLocale(base, mapping)
  writeFileSync(enPath, JSON.stringify(merged, null, 2) + '\n', 'utf8')
  console.log(
    `i18n:extract emit — merged ${Object.keys(mapping).length} key(s) into ${relative(REPO_ROOT, enPath)}`,
  )
}

function main() {
  const args = process.argv.slice(2)
  const emitIdx = args.indexOf('--emit')
  if (emitIdx !== -1) runEmit(args[emitIdx + 1])
  else runScan()
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : ''
if (invokedPath && invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main()
}
