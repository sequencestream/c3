#!/usr/bin/env node
// Undo a freeze: delete the manifest. After this, `i18n:check-freeze` will warn
// (unfrozen) rather than error. Use this when intentionally editing en.json —
// then re-run `i18n:freeze` to lock the new state.
//
// Usage: `pnpm i18n:unfreeze`

import { unlinkSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { MANIFEST_PATH } from './freeze.mjs'

function main() {
  if (!existsSync(MANIFEST_PATH)) {
    console.log(`unfreeze: no manifest at ${MANIFEST_PATH} — nothing to do`)
    return
  }
  unlinkSync(MANIFEST_PATH)
  console.log(`unfreeze: removed ${MANIFEST_PATH}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
