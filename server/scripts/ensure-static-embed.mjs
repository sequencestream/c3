// Ensure server/src/static-embed.ts exists. If missing, write a stub with an
// empty Map so dev/typecheck/build work without first running pkg. The pkg
// pipeline overwrites it with real embedded data via generate-static-embed.mjs.
import { existsSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(here, '..', 'src', 'static-embed.ts')

if (existsSync(out)) {
  process.exit(0)
}

const body = `// AUTO-GENERATED stub by server/scripts/ensure-static-embed.mjs
// Real embedded assets are produced by generate-static-embed.mjs during \`pnpm pkg\`.
export const STATIC_ASSETS: ReadonlyMap<string, { body: string; mime: string }> = new Map();
`

writeFileSync(out, body)
console.log('[ensure-static-embed] wrote empty stub:', out)
