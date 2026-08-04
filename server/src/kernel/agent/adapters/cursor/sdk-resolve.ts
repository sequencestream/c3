/**
 * Where `@cursor/sdk` lives, answered once for every consumer.
 *
 * c3 ships in two shapes and the SDK reaches them differently. An npm install
 * resolves it as an ordinary dependency. A standalone binary carries no Cursor
 * runtime at all — bundling the SDK would freeze the build host's platform-native
 * package into every cross-compiled target — so the release lays a per-target SDK
 * tree NEXT TO the executable and the binary resolves it from there.
 *
 * Resolution order, first hit wins:
 *   1. `CURSOR_SDK_PATH` — a `node_modules` root, for a deployment that puts the
 *      tree somewhere of its own choosing;
 *   2. `<dirname(process.execPath)>/node_modules` — the release layout;
 *   3. ordinary module resolution — the npm install, semantics untouched.
 *
 * Every candidate must resolve to the SDK's package entry INSIDE the root it
 * claims: an override that points at nothing must not silently succeed through an
 * ancestor's `node_modules`, it must be rejected and recorded so the next source
 * gets its turn. That is also why availability and loading share this one module —
 * gating on one resolution and then importing through another is exactly how a
 * vendor reports "available" and then fails at `start()`.
 *
 * The probe deliberately stops at resolving the entry: importing would start the
 * SDK's local runtime, which is far too much work to answer "is it there".
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { VendorRuntimeOrigin } from '@ccc/shared/protocol'

/** The package id — what the diagnostics row names and what `import()` asks for. */
export const CURSOR_SDK_MODULE = '@cursor/sdk'

/** Sidecar root relative to the executable. Fixed, and the release writes it. */
export const CURSOR_SDK_SIDECAR_DIRNAME = 'node_modules'

/** Deployment override: a `node_modules` root to resolve the SDK from. */
export const CURSOR_SDK_PATH_ENV = 'CURSOR_SDK_PATH'

/** The env var the SDK reads to locate ripgrep, bypassing its own lookup. */
const RIPGREP_PATH_ENV = 'CURSOR_RIPGREP_PATH'

/** Where the SDK was found, and what was found there. */
export interface CursorSdkResolution {
  available: boolean
  /** Absolute path to the resolved package entry; absent when unresolved. */
  entry?: string
  /** The `node_modules` root it came from; absent for ordinary module resolution. */
  root?: string
  origin?: VendorRuntimeOrigin
  /** A `CURSOR_SDK_PATH` that was set but did not yield the SDK. */
  rejectedOverride?: string
}

/**
 * Resolve the SDK's entry inside one `node_modules` root, explicitly.
 *
 * Deliberately NOT via `createRequire`: that would resolve by walking up looking
 * for a directory literally named `node_modules`, so a root under any other name
 * would silently fail, and a root holding no SDK would "succeed" through whatever
 * tree happens to sit above it. The root is c3's own concept, so it is searched
 * as one — the package must be at `<root>/@cursor/sdk`, and nowhere else.
 *
 * Entry preference is `index.cjs` → `index.js` → the manifest's `main`, in that
 * order, because that is the order a standalone binary's resolver uses: it never
 * reads `package.json`, and finds only a root-level `index`. Preferring the same
 * file everywhere is what stops a sidecar loading one build under Node and a
 * different one inside the binary.
 */
function resolveFromRoot(root: string): string | null {
  const dir = join(root, CURSOR_SDK_MODULE)
  let manifest: { name?: unknown; main?: unknown }
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as typeof manifest
  } catch {
    return null
  }
  if (manifest.name !== CURSOR_SDK_MODULE) return null
  const candidates = ['index.cjs', 'index.js']
  if (typeof manifest.main === 'string') candidates.push(manifest.main)
  for (const candidate of candidates) {
    const entry = join(dir, candidate)
    // Keep the entry inside the package: a `main` that climbs out of it is a
    // broken manifest, not a module this boundary will load.
    if (!entry.startsWith(dir + sep)) continue
    if (existsSync(entry)) return entry
  }
  return null
}

/** The sidecar root this executable would carry, whether or not it exists. */
export function sidecarRoot(): string {
  return join(dirname(process.execPath), CURSOR_SDK_SIDECAR_DIRNAME)
}

/**
 * Where `@cursor/sdk` resolves from right now — the single fact behind the startup
 * adapter gate, the settings runtime signal, the driver's lazy import and the
 * version probe.
 *
 * Not cached: `CURSOR_SDK_PATH` and the sidecar are deployment state a long-lived
 * server should be able to observe changing, and the call is a bare path lookup.
 */
export function resolveCursorSdk(env: NodeJS.ProcessEnv = process.env): CursorSdkResolution {
  const override = env[CURSOR_SDK_PATH_ENV]?.trim()
  if (override) {
    const root = resolve(override)
    const entry = resolveFromRoot(root)
    if (entry) return { available: true, entry, root, origin: 'override' }
  }

  const sidecar = sidecarRoot()
  const fromSidecar = resolveFromRoot(sidecar)
  if (fromSidecar) {
    return {
      available: true,
      entry: fromSidecar,
      root: sidecar,
      origin: 'sidecar',
      ...(override ? { rejectedOverride: resolve(override) } : {}),
    }
  }

  try {
    const entry = createRequire(import.meta.url).resolve(CURSOR_SDK_MODULE)
    return {
      available: true,
      entry,
      origin: 'installed',
      ...(override ? { rejectedOverride: resolve(override) } : {}),
    }
  } catch {
    return { available: false, ...(override ? { rejectedOverride: resolve(override) } : {}) }
  }
}

/**
 * Whether `@cursor/sdk` is resolvable from this process — the whole of Cursor's
 * availability check, since the SDK runs in-process rather than as a host CLI the
 * operator installs.
 */
export function cursorSdkAvailable(): boolean {
  return resolveCursorSdk().available
}

/** The package directory holding a resolved entry — the nearest `@cursor/sdk/`. */
function packageDir(entry: string): string | null {
  let dir = dirname(entry)
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) {
      try {
        const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
          name?: unknown
        }
        if (meta.name === CURSOR_SDK_MODULE) return dir
      } catch {
        /* unreadable manifest — keep walking */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The resolved SDK's version, or `'unknown'` when it cannot be read.
 *
 * Read off the resolved package rather than by module resolution: `@cursor/sdk`
 * does not export its `package.json`, and the value has to describe the copy that
 * will actually be loaded, not whichever one a second resolution would find.
 */
export function resolvedCursorSdkVersion(
  resolution: CursorSdkResolution = resolveCursorSdk(),
): string {
  if (!resolution.entry) return 'unavailable'
  const dir = packageDir(resolution.entry)
  if (!dir) return 'unknown'
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf-8')) as {
      version?: unknown
    }
    return typeof meta.version === 'string' ? meta.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * Point the SDK at the ripgrep binary in the sidecar's platform package.
 *
 * The SDK finds its platform binaries by walking up from `process.argv[1]`, which
 * inside a standalone binary is a path in the embedded filesystem — the sidecar is
 * never on that walk. `CURSOR_RIPGREP_PATH` outranks the walk, so setting it is
 * what makes the shipped ripgrep reachable. An operator's own value is left alone.
 *
 * The sandbox helper (`cursorsandbox`) has no such override; a binary deployment
 * therefore cannot run Cursor sandboxed, and says so rather than pretending to.
 */
function pointAtSidecarRipgrep(resolution: CursorSdkResolution, env: NodeJS.ProcessEnv): void {
  if (!resolution.root || env[RIPGREP_PATH_ENV]) return
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const path = join(
    resolution.root,
    `${CURSOR_SDK_MODULE}-${process.platform}-${process.arch}`,
    'bin',
    binary,
  )
  if (existsSync(path)) env[RIPGREP_PATH_ENV] = path
}

/** The SDK's module shape, as the driver and the session store consume it. */
export type CursorSdkModule = typeof import('@cursor/sdk')

let loading: Promise<CursorSdkModule> | null = null

/**
 * Load the SDK from wherever {@link resolveCursorSdk} found it.
 *
 * A sidecar or override is imported by its resolved absolute path; an ordinary
 * install is imported by name, so an npm deployment keeps exactly the resolution
 * semantics it always had. Cached because the local runtime is expensive to
 * initialise and every turn would otherwise re-enter it.
 */
export function loadCursorSdk(): Promise<CursorSdkModule> {
  loading ??= (async () => {
    const resolution = resolveCursorSdk()
    if (!resolution.available || !resolution.entry) {
      throw new Error(
        `${CURSOR_SDK_MODULE} could not be resolved — install the sidecar tree next to the executable, or set ${CURSOR_SDK_PATH_ENV} to a node_modules root that contains it.`,
      )
    }
    pointAtSidecarRipgrep(resolution, process.env)
    if (resolution.origin === 'installed') {
      return (await import(CURSOR_SDK_MODULE)) as CursorSdkModule
    }
    return (await import(pathToFileURL(resolution.entry).href)) as CursorSdkModule
  })().catch((err) => {
    // A failed load must not poison the cache: the sidecar can be repaired under a
    // long-lived server, and the next turn should get a real attempt.
    loading = null
    throw err
  })
  return loading
}

/** Drop the cached module — for tests that swap the resolution underneath. */
export function resetCursorSdkCache(): void {
  loading = null
}
