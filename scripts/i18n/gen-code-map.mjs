#!/usr/bin/env node
// Build-time generator: derive the code -> key map artifact from the SoT
// (shared/src/ui-codes.ts). Run via `pnpm i18n:gen-codes`.
//
// The artifact (code-key.map.json) is a deterministic, sorted projection of the
// SoT — an inspection/doc aid, NOT a second source. The authoritative data is the
// SoT; `pnpm i18n:check` enforces SoT <-> en.json <-> server consistency. The
// artifact is .gitignored (regenerate any time), mirroring extract.candidates.json.

import { writeFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadUiCodes } from './load-ui-codes.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_PATH = join(HERE, 'code-key.map.json')

/** Deterministic { code: { key, params? } } projection, sorted by code. Pure (unit-tested). */
export function buildCodeMap(uiCodes) {
  const out = {}
  for (const code of Object.keys(uiCodes).sort()) {
    const def = uiCodes[code]
    out[code] = def.params ? { key: def.key, params: [...def.params] } : { key: def.key }
  }
  return out
}

async function main() {
  const uiCodes = await loadUiCodes()
  const map = buildCodeMap(uiCodes)
  writeFileSync(OUT_PATH, JSON.stringify(map, null, 2) + '\n')
  console.log(`i18n:gen-codes OK — ${Object.keys(map).length} code(s) -> ${OUT_PATH}`)
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : ''
if (invokedPath && invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
