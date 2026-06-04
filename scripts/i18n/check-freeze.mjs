#!/usr/bin/env node
// CI gate for the freeze manifest. Used standalone (`pnpm i18n:check-freeze`) and
// embedded into `pnpm i18n:check` so the four-check run also enforces the freeze.
//
// Exit codes:
//   0 — green (manifest present and hash matches OR no manifest and project is
//       newly bootstrapped)
//   1 — red  (manifest present but hash drifted — en.json was edited underfoot)

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { hash, MANIFEST_PATH, EN_PATH, BASE_LOCALE } from './freeze.mjs'

/**
 * Pure check: given a (possibly-null) manifest JSON object and the current
 * en.json raw text, return { ok, errors, warnings }. Both args are nullable so
 * callers don't have to handle the "manifest file doesn't exist" path here.
 */
export function checkFreeze(manifest, enContent) {
  const errors = []
  const warnings = []
  if (manifest == null) {
    warnings.push(
      `[freeze] no manifest — base locale '${BASE_LOCALE}' is unfrozen. ` +
        `Run \`pnpm i18n:freeze\` after intentional edits.`,
    )
    return { ok: true, errors, warnings }
  }
  if (typeof enContent !== 'string') {
    errors.push(`[freeze] manifest present but ${BASE_LOCALE}.json content unavailable`)
    return { ok: false, errors, warnings }
  }
  const currentHash = hash(enContent)
  if (manifest.hash !== currentHash) {
    errors.push(
      `[freeze] ${BASE_LOCALE}.json has drifted from freeze manifest — ` +
        `expected ${manifest.hash}, got ${currentHash}. ` +
        `If the edit is intentional, run \`pnpm i18n:unfreeze\` then \`pnpm i18n:freeze\`.`,
    )
    return { ok: false, errors, warnings }
  }
  return { ok: true, errors, warnings }
}

/**
 * I/O wrapper: reads the manifest + en.json off disk and delegates to
 * `checkFreeze`. Returns { ok, errors, warnings }.
 */
export function runFreezeCheck() {
  let manifest = null
  if (existsSync(MANIFEST_PATH)) {
    try {
      manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    } catch (e) {
      return {
        ok: false,
        errors: [`[freeze] manifest is not valid JSON: ${e.message}`],
        warnings: [],
      }
    }
  }
  const enContent = existsSync(EN_PATH) ? readFileSync(EN_PATH, 'utf8') : null
  return checkFreeze(manifest, enContent)
}

function main() {
  const { ok, errors, warnings } = runFreezeCheck()
  for (const w of warnings) console.warn(`  warn  ${w}`)
  for (const e of errors) console.error(`  error ${e}`)
  if (!ok) {
    console.error(`\ni18n:check-freeze FAILED — ${errors.length} error(s).`)
    process.exit(1)
  }
  console.log(`i18n:check-freeze OK — ${warnings.length} warning(s), 0 errors.`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
