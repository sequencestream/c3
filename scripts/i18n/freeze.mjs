#!/usr/bin/env node
// Freeze the base locale (en.json): record its SHA-256 in `.freeze-manifest.json`
// so any subsequent edit to en.json breaks `pnpm i18n:check-freeze`. This locks
// the translatable surface for ja/ko translation: distributors can hand the
// frozen en.json to translators, and CI will reject any drift.
//
// Usage: `pnpm i18n:freeze`        — write/refresh the manifest
//        `pnpm i18n:unfreeze`      — delete the manifest
//        `pnpm i18n:check-freeze`  — CI gate: hash matches the manifest
//
// The manifest is committed (not gitignored) so CI in any clone sees the
// freeze state. Editing en.json without re-running `i18n:freeze` is a CI error.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const BASE_LOCALE = 'en'
const EN_PATH = join(REPO_ROOT, 'web', 'src', 'locales', `${BASE_LOCALE}.json`)
const MANIFEST_PATH = join(REPO_ROOT, 'web', 'src', 'locales', '.freeze-manifest.json')

function hash(content) {
  // SHA-256 over the raw bytes (preserves the file as committed). LF-only on POSIX
  // so the hash is stable across platforms; Windows checkouts may differ, which is
  // acceptable because the gate runs in CI (Linux) and the editor is local.
  return createHash('sha256').update(content).digest('hex')
}

function main() {
  if (!existsSync(EN_PATH)) {
    console.error(`freeze: ${EN_PATH} not found`)
    process.exit(1)
  }
  const content = readFileSync(EN_PATH, 'utf8')
  const enHash = hash(content)
  const manifest = {
    baseLocale: BASE_LOCALE,
    hash: enHash,
    bytes: Buffer.byteLength(content, 'utf8'),
    frozenAt: new Date().toISOString(),
    version: 1,
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  console.log(
    `freeze: wrote ${MANIFEST_PATH}\n` +
      `  hash:   ${enHash}\n` +
      `  bytes:  ${manifest.bytes}\n` +
      `  at:     ${manifest.frozenAt}`,
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}

export { hash, MANIFEST_PATH, EN_PATH, BASE_LOCALE }
