// Post-process helpers for the Bun stage bundle (`build-target.mjs`).
//
// Some dependencies read `../package.json` via `createRequire(import.meta.url)` at
// module load (@deepseek-ai/dsh-llm attribution). The node esbuild artifact avoids
// that by rewriting `import.meta.url` to a real file URL (`server/build.mjs`); in a
// `bun --compile` binary `import.meta.url` lives under bunfs and the read throws
// before the CLI can start. Inline the manifest at bundle time instead.
import { createRequire } from 'node:module'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** `createRequire(import.meta.url)('../package.json')` in a single-file bundle. */
const PACKAGE_JSON_AT_LOAD = /createRequire\w*\(import\.meta\.url\)\((['"])\.\.\/package\.json\1\)/g

/**
 * The version of the only package that performs this load-time read, or `0.0.0`
 * when it cannot be determined.
 *
 * The peer itself is not resolvable from `server/package.json` (pnpm keeps it in
 * the virtual store), but the SDK client that declares it IS a server
 * dependency and pins the version exactly — so the pin is the version the
 * bundled copy reports.
 *
 * @returns {string}
 */
function bundledManifestVersion() {
  try {
    const requireFromServer = createRequire(resolve(serverDir, 'package.json'))
    const client = /** @type {{ peerDependencies?: Record<string, string> }} */ (
      requireFromServer('@deepseek-ai/dsh-sdk-client/package.json')
    )
    const pinned = client.peerDependencies?.['@deepseek-ai/dsh-llm']
    if (typeof pinned === 'string' && /^\d+\.\d+\.\d+/.test(pinned)) return pinned
  } catch {
    /* fall through to the warning below */
  }
  console.warn('[bundle-patches] cannot resolve the @deepseek-ai/dsh-llm version; inlining 0.0.0')
  return '0.0.0'
}

/** Manifest shape the bundled attribution module destructures. */
function defaultManifest() {
  return { version: bundledManifestVersion() }
}

/**
 * Replace every load-time `../package.json` read with an inlined manifest.
 *
 * The regex is deliberately narrow: the stage bundle has exactly one such read
 * (@deepseek-ai/dsh-llm), and a second package's read would need its own
 * manifest rather than this one.
 *
 * @param {string} source
 * @param {() => Record<string, unknown>} [resolveManifest]
 * @returns {string}
 */
export function patchBundledPackageJsonRequires(source, resolveManifest = defaultManifest) {
  return source.replace(PACKAGE_JSON_AT_LOAD, () => JSON.stringify(resolveManifest()))
}
