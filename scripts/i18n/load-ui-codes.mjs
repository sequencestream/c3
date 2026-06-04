// Load the UI error-code SoT (shared/src/ui-codes.ts) from a plain Node script.
// The SoT is TypeScript and has no runtime imports (its types erase to nothing),
// so we transpile it in-memory and import the emitted JS via a data: URL. This
// keeps a single authored source — no hand-maintained JS mirror to drift.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..', '..')
export const SOT_PATH = resolve(REPO_ROOT, 'shared', 'src', 'ui-codes.ts')

/** Returns the `UI_ERROR_CODES` object from the shared TS SoT. */
export async function loadUiCodes(path = SOT_PATH) {
  const src = readFileSync(path, 'utf8')
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
  })
  const url = 'data:text/javascript;base64,' + Buffer.from(outputText, 'utf8').toString('base64')
  const mod = await import(url)
  return mod.UI_ERROR_CODES
}
