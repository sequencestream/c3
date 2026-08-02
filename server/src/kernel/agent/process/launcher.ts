import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve as resolvePath } from 'node:path'
import { c3HomeDir, getVendorCliVersions } from '../../config/index.js'
import { readJsonFile, withFileLock, writeAtomic } from '../../config/store.js'
import type { VendorId } from '../adapters/types.js'

export type VendorCliSource =
  | 'env-override'
  | 'managed'
  | 'host-path-fallback'
  | 'missing'
  | 'install-failed'
  | 'override-invalid'

/** Fields every vendor binary carries, however it got onto the machine. */
interface VendorBinaryBase {
  readonly vendor: VendorId
  readonly binary: string
  readonly pathEnv: string
  readonly installHint: string
}

/**
 * A CLI c3 installs and versions itself from npm, under
 * `~/.c3/vendor/<vendor>/<version>`. Only these participate in remote version
 * discovery, download, pinning and history cleanup.
 */
export interface ManagedVendorBinarySpec extends VendorBinaryBase {
  readonly kind: 'managed'
  readonly packageName: string
  readonly preferredDistTag: string
  readonly compatibleRange: string
}

/**
 * A CLI the user installs and updates themselves; c3 only locates it and checks
 * that it is a version we know how to drive. There is no npm package to resolve,
 * so the managed install/pin/cleanup machinery must skip these entirely — the
 * only resolution chain is `$<VENDOR>_PATH` then host PATH.
 *
 * `isCompatibleVersion` replaces `compatibleRange` because an external CLI need
 * not use semver at all (Cursor ships calendar versions like `2026.07.23-e383d2b`,
 * which no semver range can express).
 */
export interface ExternalVendorBinarySpec extends VendorBinaryBase {
  readonly kind: 'external'
  /** Human-readable statement of what c3 supports, shown in diagnostics. */
  readonly compatibilityLabel: string
  /** Whether a probed version string is one c3 knows how to drive. */
  isCompatibleVersion(version: string): boolean
}

export type VendorBinarySpec = ManagedVendorBinarySpec | ExternalVendorBinarySpec

/**
 * The compatible-range field the probe surface reports. Managed specs carry a
 * semver range; external specs carry a prose label, since their versioning
 * scheme need not be semver.
 */
function rangeLabel(spec: VendorBinarySpec): string {
  return spec.kind === 'managed' ? spec.compatibleRange : spec.compatibilityLabel
}

/**
 * The earliest Cursor CLI whose `-p --output-format stream-json` event shapes and
 * `--resume` semantics c3's driver was verified against. Cursor uses calendar
 * versions (`YYYY.MM.DD-<sha>`), so compatibility is a date floor, not a range.
 */
const CURSOR_MIN_CALVER = '2026.07.23'

/** Compare the `YYYY.MM.DD` prefix of two Cursor calendar versions. */
export function cursorVersionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string): [number, number, number] | null => {
    const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(v.trim())
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const got = parse(version)
  const want = parse(minimum)
  if (!got || !want) return false
  for (let i = 0; i < 3; i += 1) {
    if (got[i] !== want[i]) return got[i] > want[i]
  }
  return true
}

export const HOST_BINARIES: Record<VendorId, VendorBinarySpec> = {
  claude: {
    kind: 'managed',
    vendor: 'claude',
    binary: 'claude',
    pathEnv: 'CLAUDE_PATH',
    packageName: '@anthropic-ai/claude-code',
    preferredDistTag: 'latest',
    compatibleRange: '>=0.0.0 <999.0.0',
    installHint:
      'c3 installs Claude Code under ~/.c3/vendor/claude by default. Override with $CLAUDE_PATH, or keep a host `claude` on PATH as a degraded fallback.',
  },
  codex: {
    kind: 'managed',
    vendor: 'codex',
    binary: 'codex',
    pathEnv: 'CODEX_PATH',
    packageName: '@openai/codex',
    preferredDistTag: `${process.platform}-${process.arch}`,
    compatibleRange: '>=0.0.0 <999.0.0',
    installHint:
      'c3 installs Codex under ~/.c3/vendor/codex by default. Override with $CODEX_PATH, or keep a host `codex` on PATH as a degraded fallback.',
  },
  cursor: {
    kind: 'external',
    vendor: 'cursor',
    binary: 'cursor-agent',
    pathEnv: 'CURSOR_AGENT_PATH',
    compatibilityLabel: `>=${CURSOR_MIN_CALVER}`,
    isCompatibleVersion: (version) => cursorVersionAtLeast(version, CURSOR_MIN_CALVER),
    installHint:
      'c3 does not install Cursor. Install the Cursor CLI yourself (`curl https://cursor.com/install -fsS | bash`), sign in with `cursor-agent login`, then keep `cursor-agent` on PATH or point $CURSOR_AGENT_PATH at it.',
  },
}

/** Whether c3 installs and versions this vendor's CLI itself. */
export function isManagedVendor(vendor: VendorId): boolean {
  return HOST_BINARIES[vendor].kind === 'managed'
}

/**
 * The compatibility statement c3 reports for a vendor: a semver range for a
 * managed CLI, a prose label for an externally installed one.
 */
export function vendorCompatibilityLabel(vendor: VendorId): string {
  return rangeLabel(HOST_BINARIES[vendor])
}

/** The managed specs only — the set the npm install/sync/cleanup paths may touch. */
export function managedVendorSpecs(): ManagedVendorBinarySpec[] {
  return (Object.values(HOST_BINARIES) as VendorBinarySpec[]).filter(
    (spec): spec is ManagedVendorBinarySpec => spec.kind === 'managed',
  )
}

/**
 * Assert a vendor is c3-managed before entering an npm install/version path.
 * External CLIs have no package to resolve, so reaching here with one is a wiring
 * bug: it fails loudly rather than inventing a package name.
 */
function requireManaged(vendor: VendorId): ManagedVendorBinarySpec {
  const spec = HOST_BINARIES[vendor]
  if (spec.kind !== 'managed') {
    throw new Error(`${vendor} is an externally installed CLI; c3 does not manage its versions`)
  }
  return spec
}

export interface VendorProbe {
  readonly vendor: VendorId
  readonly binary: string
  readonly path: string | null
  readonly source: VendorCliSource
  readonly present: boolean
  readonly version?: string
  readonly expectedVersion?: string
  readonly compatibleRange: string
  readonly installHint: string
  readonly error?: string
  readonly managedError?: string
}

interface VendorStateEntry {
  vendor: VendorId
  source: VendorCliSource
  selectedVersion?: string
  manualVersion?: string
  latestCompatibleVersion?: string
  compatibleRange: string
  path?: string
  installedAt?: string
  lastCheckedAt?: string
  lastRemoteCheckAt?: string
  lastError?: string
  versionHistory: VendorVersionHistoryEntry[]
}

interface VendorVersionHistoryEntry {
  version: string
  sourceTag?: string
  integrity?: string
  installedPath?: string
  installedAt?: string
  lastUsedAt?: string
  status: 'installed' | 'selected' | 'failed'
}

interface VendorStateFile {
  version: 1
  vendors: Partial<Record<VendorId, VendorStateEntry>>
}

interface NpmPackument {
  'dist-tags'?: Record<string, string>
  versions?: Record<string, NpmVersion>
}

interface NpmVersion {
  version?: string
  bin?: string | Record<string, string>
  dist?: { tarball?: string; integrity?: string; shasum?: string }
}

export interface VendorInstallerDeps {
  fetch?: typeof fetch
  runVersion?: (path: string, vendor: VendorId) => string
  unpack?: (archivePath: string, destDir: string) => void
  now?: () => Date
  env?: NodeJS.ProcessEnv
}

const cache = new Map<VendorId, VendorProbe>()
const REMOTE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const HISTORY_LIMIT = 20

export function lookupCommand(
  binary: string,
  platform: NodeJS.Platform = process.platform,
): [cmd: string, args: string[]] {
  return platform === 'win32' ? ['where', [binary]] : ['sh', ['-c', `command -v ${binary}`]]
}

export function managedBinPath(vendor: VendorId, version: string, home = c3HomeDir()): string {
  const spec = HOST_BINARIES[vendor]
  return join(home, 'vendor', vendor, version, 'bin', spec.binary)
}

export function vendorManifestPath(home = c3HomeDir()): string {
  return join(home, 'vendor', 'manifest.json')
}

function emptyState(): VendorStateFile {
  return { version: 1, vendors: {} }
}

function readState(home = c3HomeDir()): VendorStateFile {
  const state = readJsonFile<VendorStateFile>(vendorManifestPath(home))
  if (!state || state.version !== 1 || !state.vendors) return emptyState()
  return state
}

function writeState(home: string, state: VendorStateFile): void {
  writeAtomic(vendorManifestPath(home), state)
}

function nowIso(deps?: VendorInstallerDeps): string {
  return (deps?.now?.() ?? new Date()).toISOString()
}

function hostPath(vendor: VendorId): string | null {
  const spec = HOST_BINARIES[vendor]
  try {
    const [cmd, args] = lookupCommand(spec.binary)
    const r = spawnSync(cmd, args, { encoding: 'utf-8' })
    const first = r.status === 0 ? (r.stdout.split('\n')[0]?.trim() ?? '') : ''
    return first || null
  } catch {
    return null
  }
}

function isExecutable(path: string): boolean {
  try {
    const s = statSync(path)
    return s.isFile() && (process.platform === 'win32' || (s.mode & 0o111) !== 0)
  } catch {
    return false
  }
}

function defaultRunVersion(path: string): string {
  const r = spawnSync(path, ['--version'], { encoding: 'utf-8' })
  if (r.error || r.status !== 0) {
    throw new Error((r.stderr || r.error?.message || 'version probe failed').trim())
  }
  return (r.stdout || r.stderr || '').trim()
}

export function parseVendorVersion(vendor: VendorId, output: string): string | null {
  const text = output.trim()
  const patterns: Record<VendorId, RegExp[]> = {
    claude: [
      /claude(?:\s+code)?\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i,
      /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s+\(?claude(?:\s+code)?\)?/i,
    ],
    codex: [/codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i],
    // Cursor prints a bare calendar version, e.g. `2026.07.23-e383d2b`.
    cursor: [/^(\d{4}\.\d{2}\.\d{2}(?:-[0-9A-Za-z.-]+)?)$/m],
  }
  for (const pattern of patterns[vendor]) {
    const m = pattern.exec(text)
    if (m) return m[1]
  }
  return null
}

function probeVersion(path: string, vendor: VendorId, deps?: VendorInstallerDeps): string {
  const raw = deps?.runVersion ? deps.runVersion(path, vendor) : defaultRunVersion(path)
  const parsed = parseVendorVersion(vendor, raw)
  if (!parsed) throw new Error(`cannot parse ${vendor} --version output: ${raw}`)
  return parsed
}

function semverParts(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

export function compareVersions(a: string, b: string): number {
  const pa = semverParts(a)
  const pb = semverParts(b)
  if (!pa || !pb) return a.localeCompare(b)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return a.localeCompare(b)
}

export function satisfiesRange(version: string, range: string): boolean {
  const clauses = range.split(/\s+/).filter(Boolean)
  for (const clause of clauses) {
    const m = /^(>=|>|<=|<|=)?(.+)$/.exec(clause)
    if (!m) return false
    const op = m[1] ?? '='
    const cmp = compareVersions(version, m[2])
    if (op === '>=' && cmp < 0) return false
    if (op === '>' && cmp <= 0) return false
    if (op === '<=' && cmp > 0) return false
    if (op === '<' && cmp >= 0) return false
    if (op === '=' && cmp !== 0) return false
  }
  return true
}

function stateEntry(vendor: VendorId, patch: Partial<VendorStateEntry>): VendorStateEntry {
  const spec = HOST_BINARIES[vendor]
  return {
    vendor,
    source: 'missing',
    compatibleRange: rangeLabel(spec),
    versionHistory: [],
    ...patch,
  }
}

function trimHistory(history: VendorVersionHistoryEntry[]): VendorVersionHistoryEntry[] {
  return history.slice(0, HISTORY_LIMIT)
}

function recordState(
  vendor: VendorId,
  patch: Partial<VendorStateEntry>,
  deps?: VendorInstallerDeps,
): VendorStateEntry {
  const home = c3HomeDir()
  const file = vendorManifestPath(home)
  return withFileLock(file, () => {
    const state = readState(home)
    const prior = state.vendors[vendor] ?? stateEntry(vendor, {})
    const next = stateEntry(vendor, {
      ...prior,
      ...patch,
      lastCheckedAt: nowIso(deps),
      versionHistory: trimHistory(patch.versionHistory ?? prior.versionHistory ?? []),
    })
    state.vendors[vendor] = next
    writeState(home, state)
    return next
  })
}

function probeManaged(vendor: VendorId, version: string, deps?: VendorInstallerDeps): VendorProbe {
  const spec = requireManaged(vendor)
  const path = managedBinPath(vendor, version)
  const versionText = probeVersion(path, vendor, deps)
  if (!satisfiesRange(versionText, spec.compatibleRange)) {
    throw new Error(`${vendor} ${versionText} is outside compatible range ${spec.compatibleRange}`)
  }
  return {
    vendor,
    binary: spec.binary,
    path,
    source: 'managed',
    present: true,
    version: versionText,
    expectedVersion: version,
    compatibleRange: rangeLabel(spec),
    installHint: spec.installHint,
  }
}

/**
 * Resolve an externally installed CLI from host PATH and verify c3 can drive it.
 * A present-but-incompatible binary is deliberately reported as NOT present: a
 * version whose stream shape we have never verified would fail deep inside a run
 * instead of at the door, where the operator can act on the install hint.
 */
function externalProbe(
  vendor: VendorId,
  spec: ExternalVendorBinarySpec,
  deps?: VendorInstallerDeps,
): VendorProbe {
  const path = hostPath(vendor)
  if (!path) return missingProbe(vendor)
  let version: string
  try {
    version = probeVersion(path, vendor, deps)
  } catch (err) {
    return missingProbe(vendor, `host PATH version probe failed: ${(err as Error).message}`)
  }
  if (!spec.isCompatibleVersion(version)) {
    return missingProbe(
      vendor,
      `${spec.binary} ${version} is outside the supported range ${spec.compatibilityLabel}; upgrade it`,
    )
  }
  return {
    vendor,
    binary: spec.binary,
    path,
    source: 'host-path-fallback',
    present: true,
    version,
    compatibleRange: rangeLabel(spec),
    installHint: spec.installHint,
  }
}

function fallbackProbe(
  vendor: VendorId,
  managedError?: string,
  deps?: VendorInstallerDeps,
): VendorProbe {
  const spec = HOST_BINARIES[vendor]
  const path = hostPath(vendor)
  if (path) {
    try {
      const version = probeVersion(path, vendor, deps)
      return {
        vendor,
        binary: spec.binary,
        path,
        source: 'host-path-fallback',
        present: true,
        version,
        compatibleRange: rangeLabel(spec),
        installHint: spec.installHint,
        managedError,
      }
    } catch (err) {
      return missingProbe(
        vendor,
        `host PATH version probe failed: ${(err as Error).message}`,
        managedError,
      )
    }
  }
  return missingProbe(vendor, undefined, managedError)
}

function missingProbe(vendor: VendorId, error?: string, managedError?: string): VendorProbe {
  const spec = HOST_BINARIES[vendor]
  return {
    vendor,
    binary: spec.binary,
    path: null,
    source: managedError ? 'install-failed' : 'missing',
    present: false,
    compatibleRange: rangeLabel(spec),
    installHint: spec.installHint,
    ...(error ? { error } : {}),
    ...(managedError ? { managedError } : {}),
  }
}

export function resolveExecutable(vendor: VendorId, deps?: VendorInstallerDeps): VendorProbe {
  const cached = cache.get(vendor)
  if (cached) return cached
  const env = deps?.env ?? process.env
  const spec = HOST_BINARIES[vendor]
  const override = env[spec.pathEnv]
  if (override) {
    try {
      if (!isExecutable(override)) throw new Error(`not executable: ${override}`)
      const version = probeVersion(override, vendor, deps)
      // An external CLI pointed at explicitly still has to be a version c3 was
      // verified against; the override chooses which binary, not whether it works.
      if (spec.kind === 'external' && !spec.isCompatibleVersion(version)) {
        throw new Error(`${version} is outside the supported range ${spec.compatibilityLabel}`)
      }
      const probe: VendorProbe = {
        vendor,
        binary: spec.binary,
        path: override,
        source: 'env-override',
        present: true,
        version,
        compatibleRange: rangeLabel(spec),
        installHint: spec.installHint,
      }
      cache.set(vendor, probe)
      recordState(
        vendor,
        { source: 'env-override', path: override, selectedVersion: version },
        deps,
      )
      return probe
    } catch (err) {
      const probe: VendorProbe = {
        vendor,
        binary: spec.binary,
        path: null,
        source: 'override-invalid',
        present: false,
        compatibleRange: rangeLabel(spec),
        installHint: spec.installHint,
        error: `${spec.pathEnv} invalid: ${(err as Error).message}`,
      }
      cache.set(vendor, probe)
      recordState(
        vendor,
        { source: 'override-invalid', path: override, lastError: probe.error },
        deps,
      )
      return probe
    }
  }

  // An externally installed CLI has no managed candidates to degrade through:
  // once `$<VENDOR>_PATH` is out of the picture, host PATH is the whole chain.
  // The version still has to be one c3 knows how to drive, and an incompatible
  // one is reported as unusable rather than launched and hoped for.
  if (spec.kind === 'external') {
    const probe = externalProbe(vendor, spec, deps)
    cache.set(vendor, probe)
    recordState(
      vendor,
      {
        source: probe.source,
        path: probe.path ?? undefined,
        selectedVersion: probe.version,
        lastError: probe.error,
      },
      deps,
    )
    return probe
  }

  const pins = getVendorCliVersions()
  const state = readState()
  const entry = state.vendors[vendor]
  const choice = pins[vendor] || undefined
  // Managed resolution degrades in a fixed order: the user's effective-version
  // choice (from settings) → the last sync's latest-compatible download target →
  // the manifest's recorded selectedVersion → host PATH fallback. Each managed
  // candidate that is missing/incompatible records a visible `lastError` but does
  // NOT rewrite `vendorCliVersions` (the user's choice is preserved so the panel
  // can show "selected but currently unavailable").
  const candidates = [choice, entry?.latestCompatibleVersion, entry?.selectedVersion].filter(
    (v): v is string => Boolean(v),
  )
  const tried = new Set<string>()
  const errors: string[] = []
  for (const candidate of candidates) {
    if (tried.has(candidate)) continue
    tried.add(candidate)
    try {
      const probe = probeManaged(vendor, candidate, deps)
      const degraded = choice && candidate !== choice
      const managedError = degraded
        ? `active ${choice} unavailable, degraded to ${candidate}`
        : undefined
      cache.set(vendor, probe)
      recordState(
        vendor,
        {
          source: 'managed',
          selectedVersion: candidate,
          path: probe.path ?? undefined,
          ...(managedError ? { lastError: managedError } : { lastError: undefined }),
          versionHistory: [
            {
              version: candidate,
              installedPath: probe.path ?? undefined,
              lastUsedAt: nowIso(deps),
              status: 'selected',
            },
            ...(entry?.versionHistory ?? []).filter((h) => h.version !== candidate),
          ],
        },
        deps,
      )
      return probe
    } catch (err) {
      errors.push(`${candidate} unusable: ${(err as Error).message}`)
    }
  }

  const managedError =
    errors.length > 0 ? `managed ${vendor} ${errors.join('; ')}` : 'managed CLI not installed yet'
  const probe = fallbackProbe(vendor, managedError, deps)
  cache.set(vendor, probe)
  recordState(vendor, { source: probe.source, lastError: managedError }, deps)
  return probe
}

export function resolve(vendor: VendorId): string | null {
  return resolveExecutable(vendor).path
}

export function probe(vendor: VendorId): VendorProbe {
  return resolveExecutable(vendor)
}

export function probeAll(): VendorProbe[] {
  return (Object.keys(HOST_BINARIES) as VendorId[]).map(probe)
}

export function resetProbeCache(): void {
  cache.clear()
}

function platformTag(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch}`
}

function versionRecord(packument: NpmPackument, version: string): NpmVersion | null {
  return packument.versions?.[version] ?? null
}

function compatibleVersions(packument: NpmPackument, range: string): string[] {
  return Object.keys(packument.versions ?? {})
    .filter((v) => satisfiesRange(v, range) && !isPreRelease(v))
    .sort(compareVersions)
}

/** npm semver pre-release check — a hyphen after patch (e.g. `2.2.0-alpha.1`). */
function isPreRelease(v: string): boolean {
  const m = /^\d+\.\d+\.\d+-(.+)$/.exec(v)
  return m !== null
}

/**
 * Select the download target — always the newest compatible npm version along
 * the dist-tag candidate chain. This is decoupled from the runtime *effective*
 * version selection (`vendorCliVersions`): sync always tracks the latest
 * compatible release so historical versions can coexist and be chosen as the
 * active version without freezing the download target.
 */
export function selectNpmVersion(
  vendor: VendorId,
  packument: NpmPackument,
  platform = process.platform,
  arch = process.arch,
): { version: string; sourceTag: string } {
  const spec = requireManaged(vendor)
  const tags = packument['dist-tags'] ?? {}
  const candidates =
    vendor === 'codex'
      ? [platformTag(platform, arch), spec.preferredDistTag, 'latest']
      : [spec.preferredDistTag, 'latest']
  for (const tag of candidates) {
    const version = tags[tag]
    if (
      version &&
      !isPreRelease(version) &&
      versionRecord(packument, version) &&
      satisfiesRange(version, spec.compatibleRange)
    ) {
      return { version, sourceTag: tag }
    }
  }
  const versions = compatibleVersions(packument, spec.compatibleRange)
  const latest = versions.at(-1)
  if (!latest) throw new Error(`no ${vendor} npm version satisfies ${spec.compatibleRange}`)
  return { version: latest, sourceTag: 'compatible-highest' }
}

function distFor(packument: NpmPackument, version: string): { tarball: string; integrity: string } {
  const dist = versionRecord(packument, version)?.dist
  if (!dist?.tarball) throw new Error(`${version} missing dist.tarball`)
  if (!dist.integrity) throw new Error(`${version} missing dist.integrity`)
  return { tarball: dist.tarball, integrity: dist.integrity }
}

function verifySRI(data: Buffer, integrity: string): void {
  const [algo, expected] = integrity.split('-', 2)
  if (algo !== 'sha512' || !expected) throw new Error(`unsupported npm integrity: ${integrity}`)
  const actual = createHash('sha512').update(data).digest('base64')
  if (actual !== expected) throw new Error('tarball integrity mismatch')
}

function defaultUnpack(archivePath: string, destDir: string): void {
  const r = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], { encoding: 'utf-8' })
  if (r.error || r.status !== 0)
    throw new Error((r.stderr || r.error?.message || 'tar failed').trim())
}

function findPackageJson(dir: string): string {
  const direct = join(dir, 'package', 'package.json')
  if (existsSync(direct)) return direct
  const root = join(dir, 'package.json')
  if (existsSync(root)) return root
  throw new Error('package.json not found in npm tarball')
}

function binRelative(pkg: NpmVersion, binary: string): string {
  if (typeof pkg.bin === 'string') return pkg.bin
  if (pkg.bin && typeof pkg.bin[binary] === 'string') return pkg.bin[binary]
  throw new Error(`package.json#bin missing ${binary}`)
}

function installHistory(
  prior: VendorStateEntry | undefined,
  entry: VendorVersionHistoryEntry,
): VendorVersionHistoryEntry[] {
  return trimHistory([
    entry,
    ...(prior?.versionHistory ?? []).filter((h) => h.version !== entry.version),
  ])
}

export async function syncManagedVendorCli(
  vendor: VendorId,
  deps: VendorInstallerDeps = {},
): Promise<VendorProbe> {
  const spec = requireManaged(vendor)
  const home = c3HomeDir()
  const state = readState(home)
  // The download target is decoupled from the user's effective-version choice
  // (`vendorCliVersions`): sync always tracks the latest compatible release so
  // historical versions can be selected as active without freezing the download.
  const choice = getVendorCliVersions()[vendor] || undefined
  const fetchFn = deps.fetch ?? fetch
  let packument: NpmPackument
  try {
    const res = await fetchFn(
      `https://registry.npmjs.org/${encodeURIComponent(spec.packageName)}`,
      {
        headers: { 'User-Agent': 'c3-managed-vendor-cli' },
      },
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    packument = (await res.json()) as NpmPackument
  } catch (err) {
    const fallback = resolveExecutable(vendor, deps)
    const msg = `npm packument fetch failed for ${vendor}: ${(err as Error).message}`
    console.log(`[c3] vendor packument-failed: ${vendor} (${(err as Error).message})`)
    recordState(vendor, { source: fallback.source, lastError: msg }, deps)
    return fallback.path ? { ...fallback, managedError: msg } : missingProbe(vendor, undefined, msg)
  }

  const selected = selectNpmVersion(vendor, packument)
  const path = managedBinPath(vendor, selected.version, home)
  if (existsSync(path)) {
    const probe = probeManaged(vendor, selected.version, deps)
    const prior = state.vendors[vendor]
    recordState(
      vendor,
      {
        source: 'managed',
        selectedVersion: choice ? prior?.selectedVersion : selected.version,
        latestCompatibleVersion: selected.version,
        path,
        lastRemoteCheckAt: nowIso(deps),
        lastError: undefined,
        versionHistory: installHistory(prior, {
          version: selected.version,
          sourceTag: selected.sourceTag,
          installedPath: path,
          lastUsedAt: nowIso(deps),
          status: 'installed',
        }),
      },
      deps,
    )
    resetProbeCache()
    const priorVersion = prior?.selectedVersion
    // Log against the resolved new selectedVersion (the effective version),
    // not the download target — when the user pinned a history version the
    // download target advances (latest) but the effective version stays.
    const newSelected = choice ? prior?.selectedVersion : selected.version
    if (priorVersion && priorVersion !== newSelected) {
      console.log(
        `[c3] vendor upgrade: ${vendor} v${priorVersion} → v${newSelected} (already downloaded)`,
      )
    } else {
      console.log(`[c3] vendor ok: ${vendor} v${newSelected} (current)`)
    }
    return probe
  }

  // Download and install a new/cached version
  console.log(`[c3] vendor download: ${vendor} v${selected.version} ...`)
  try {
    const dist = distFor(packument, selected.version)
    const tarRes = await fetchFn(dist.tarball, {
      headers: { 'User-Agent': 'c3-managed-vendor-cli' },
    })
    if (!tarRes.ok) throw new Error(`tarball HTTP ${tarRes.status}`)
    const tarball = Buffer.from(await tarRes.arrayBuffer())
    verifySRI(tarball, dist.integrity)

    const downloads = join(home, 'vendor', vendor, 'downloads')
    mkdirSync(downloads, { recursive: true })
    const archive = join(downloads, `${selected.version}.tgz`)
    writeFileSync(archive, tarball)
    const staging = mkdtempSync(join(tmpdir(), `c3-${vendor}-${selected.version}-`))
    ;(deps.unpack ?? defaultUnpack)(archive, staging)
    const pkgJsonPath = findPackageJson(staging)
    const pkgDir = dirname(pkgJsonPath)
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as NpmVersion
    const srcBin = join(pkgDir, binRelative(pkg, spec.binary))
    if (!existsSync(srcBin)) throw new Error(`bin target missing: ${srcBin}`)
    const publishTmp = `${join(home, 'vendor', vendor, `${selected.version}.staging-${process.pid}`)}`
    const finalDir = join(home, 'vendor', vendor, selected.version)
    mkdirSync(join(publishTmp, 'bin'), { recursive: true })
    cpSync(pkgDir, join(publishTmp, 'package'), { recursive: true })
    const destBin = join(publishTmp, 'bin', spec.binary)
    const relBin = binRelative(pkg, spec.binary)
    const packageBin = join(publishTmp, 'package', relBin)
    chmodSync(packageBin, 0o755)

    // Install optional dependencies (platform-native binaries) and run postinstall
    // scripts. Both @anthropic-ai/claude-code and @openai/codex ship the native
    // binary through platform-scoped optionalDependencies (e.g. codex-darwin-arm64)
    // or a postinstall hook — the bare tarball doesn't include it, so we need a
    // full `npm install --omit=dev` to materialise the binary before probing.
    console.log(`[c3] vendor npm-install: ${vendor} v${selected.version} ...`)
    {
      const pkgDir = join(publishTmp, 'package')
      const npmR = spawnSync(
        'npm',
        [
          'install',
          '--no-save',
          '--no-audit',
          '--no-fund',
          '--omit=dev',
          '--omit=peer',
          '--no-package-lock',
          '--loglevel=error',
        ],
        {
          cwd: pkgDir,
          encoding: 'utf-8',
          timeout: 120_000,
          // @anthropic-ai/claude-code postinstall guards against direct-publish
          // with a CHECK: `node -e "if (!process.env.AUTHORIZED) process.exit(1)"`.
          // We set AUTHORIZED=true so the guard passes and the real install.cjs
          // (which downloads the native binary) actually runs.
          env: { ...process.env, AUTHORIZED: 'true' },
        },
      )
      if (npmR.error || npmR.status !== 0) {
        throw new Error(
          `npm install failed: ${(npmR.stderr || npmR.stdout || npmR.error?.message || 'unknown').trim()}`,
        )
      }
    }
    writeFileSync(
      destBin,
      `#!/bin/sh\nDIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$DIR/../package/${relBin}" "$@"\n`,
      'utf-8',
    )
    chmodSync(destBin, 0o755)
    const version = probeVersion(destBin, vendor, deps)
    if (!satisfiesRange(version, spec.compatibleRange)) {
      throw new Error(`${vendor} ${version} outside ${spec.compatibleRange}`)
    }
    rmSync(finalDir, { recursive: true, force: true })
    renameSync(publishTmp, finalDir)
    rmSync(staging, { recursive: true, force: true })

    const prior = readState(home).vendors[vendor]
    recordState(
      vendor,
      {
        source: 'managed',
        selectedVersion: choice ? prior?.selectedVersion : selected.version,
        latestCompatibleVersion: selected.version,
        path,
        installedAt: nowIso(deps),
        lastRemoteCheckAt: nowIso(deps),
        lastError: undefined,
        versionHistory: installHistory(prior, {
          version: selected.version,
          sourceTag: selected.sourceTag,
          integrity: dist.integrity,
          installedPath: path,
          installedAt: nowIso(deps),
          lastUsedAt: nowIso(deps),
          status: 'installed',
        }),
      },
      deps,
    )
    resetProbeCache()
    const priorVersion = prior?.selectedVersion
    const newSelected = choice ? prior?.selectedVersion : selected.version
    if (priorVersion && priorVersion !== newSelected) {
      console.log(`[c3] vendor upgrade: ${vendor} v${priorVersion} → v${newSelected}`)
    } else {
      console.log(`[c3] vendor installed: ${vendor} v${selected.version} (download target)`)
    }
    return probeManaged(vendor, selected.version, deps)
  } catch (err) {
    const msg = `managed ${vendor} ${selected.version} install failed: ${(err as Error).message}`
    console.log(
      `[c3] vendor install-failed: ${vendor} v${selected.version} (${(err as Error).message})`,
    )
    const old = resolveExecutable(vendor, deps)
    const prior = readState(home).vendors[vendor]
    recordState(
      vendor,
      {
        source: old.source,
        latestCompatibleVersion: selected.version,
        lastRemoteCheckAt: nowIso(deps),
        lastError: msg,
        versionHistory: installHistory(prior, {
          version: selected.version,
          sourceTag: selected.sourceTag,
          status: 'failed',
        }),
      },
      deps,
    )
    return old.path ? { ...old, managedError: msg } : missingProbe(vendor, undefined, msg)
  }
}

export function shouldCheckRemote(vendor: VendorId, now = Date.now()): boolean {
  const last = readState().vendors[vendor]?.lastRemoteCheckAt
  if (!last) return true
  return now - Date.parse(last) >= REMOTE_CHECK_INTERVAL_MS
}

/**
 * Trigger the managed-CLI remote sync for every vendor whose 24h cooldown has
 * expired, and return immediately. This is the ONLY startup entry point: the
 * registry fetch, tarball download and npm install can take tens of seconds on a
 * slow network, and the server must bind its port and reach readiness regardless.
 * Each vendor runs on its own promise chain and swallows its failure into the
 * manifest, so a background error never becomes an unhandled rejection nor changes
 * the startup result. The current process keeps using the pre-refresh probe until
 * a later resolve picks the new binary up.
 */
export function refreshManagedVendorClisInBackground(deps?: VendorInstallerDeps): void {
  // Externally installed CLIs are the user's to update; there is no npm package
  // to check, so they are skipped rather than failed against the registry.
  for (const { vendor } of managedVendorSpecs()) {
    if (!shouldCheckRemote(vendor, deps?.now?.().getTime())) {
      console.log(`[c3] vendor check-skip: ${vendor} (checked recently)`)
      continue
    }
    console.log(`[c3] vendor check: ${vendor} (background) ...`)
    void syncManagedVendorCli(vendor, deps).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[c3] vendor check-failed: ${vendor} (${msg})`)
      try {
        recordState(vendor, { source: 'install-failed', lastError: msg }, deps)
      } catch {
        // The manifest write is best-effort; a background failure must not escalate.
      }
    })
  }
}

export function cleanManagedHistory(vendor: VendorId, inUse: readonly string[] = []): void {
  const home = c3HomeDir()
  const state = readState(home)
  const entry = state.vendors[vendor]
  if (!entry) return
  // The protected set covers every source of the current effective-version
  // choice: the manifest's selectedVersion, the settings-level choice
  // (`vendorCliVersions`), and caller-supplied in-use versions. A version that
  // is the active selection must never be cleaned even if it is a historical
  // version older than the latest download target.
  const protectedVersions = new Set(
    [entry.selectedVersion, getVendorCliVersions()[vendor], ...inUse].filter((v): v is string =>
      Boolean(v),
    ),
  )
  for (const h of entry.versionHistory.slice(HISTORY_LIMIT)) {
    if (protectedVersions.has(h.version)) continue
    rmSync(join(home, 'vendor', vendor, h.version), { recursive: true, force: true })
  }
  entry.versionHistory = trimHistory(entry.versionHistory)
  writeState(home, state)
}

/**
 * Sync the manifest's `selectedVersion` to the user's effective-version choices
 * after a `save_settings` round-trip, and refresh the probe cache so the next
 * `get_settings` and subsequent session launches use the new priority. This is
 * the single entry point the settings save path calls — it never touches
 * `settings.json` itself, only the manifest + probe cache.
 *
 * - choice set & installed+compatible ⇒ selectedVersion = choice, clear lastError.
 * - choice set but not installed/incompatible ⇒ selectedVersion = choice (kept,
 *   so the panel shows the selection), record lastError. The choice is NOT
 *   cleared so the user can see and re-pick.
 * - choice empty ⇒ selectedVersion = latestCompatibleVersion (auto-follow).
 */
export function applyVendorCliChoices(
  choices: Partial<Record<VendorId, string>>,
  deps?: VendorInstallerDeps,
): void {
  for (const spec of managedVendorSpecs()) {
    const vendor = spec.vendor
    const choice = choices[vendor]?.trim() || undefined
    const entry = readState().vendors[vendor]
    if (!choice) {
      const target = entry?.latestCompatibleVersion
      if (target) {
        recordState(vendor, { selectedVersion: target, lastError: undefined }, deps)
      }
      continue
    }
    const path = managedBinPath(vendor, choice)
    if (existsSync(path) && satisfiesRange(choice, spec.compatibleRange)) {
      recordState(vendor, { selectedVersion: choice, lastError: undefined }, deps)
    } else {
      recordState(
        vendor,
        {
          selectedVersion: choice,
          lastError: `active ${choice} not installed/incompatible`,
        },
        deps,
      )
    }
  }
  resetProbeCache()
}

/** A selectable installed managed version (failed entries are excluded). */
export interface VendorCliVersionEntry {
  version: string
  installedAt?: string
  sourceTag?: string
  status: 'installed' | 'selected'
}

/** Manifest-derived status for the settings panel: installed version list +
 *  effective/download target versions + sync/check times + last error. */
export interface VendorCliStatus {
  installedVersions: VendorCliVersionEntry[]
  activeVersion?: string
  downloadTargetVersion?: string
  lastCheckedAt?: string
  lastRemoteCheckAt?: string
  lastError?: string
}

/**
 * Read the manifest-derived vendor CLI status for the settings panel. Only
 * installed/selected history entries are exposed as selectable; failed entries
 * are filtered out. This is a pure read — it does not resolve or probe.
 */
export function readVendorCliStatus(vendor: VendorId): VendorCliStatus {
  const entry = readState().vendors[vendor]
  if (!entry) return { installedVersions: [] }
  const installedVersions: VendorCliVersionEntry[] = entry.versionHistory
    .filter(
      (h): h is VendorVersionHistoryEntry & { status: 'installed' | 'selected' } =>
        h.status === 'installed' || h.status === 'selected',
    )
    .map((h) => ({
      version: h.version,
      ...(h.installedAt ? { installedAt: h.installedAt } : {}),
      ...(h.sourceTag ? { sourceTag: h.sourceTag } : {}),
      status: h.status,
    }))
  return {
    installedVersions,
    ...(entry.selectedVersion ? { activeVersion: entry.selectedVersion } : {}),
    ...(entry.latestCompatibleVersion
      ? { downloadTargetVersion: entry.latestCompatibleVersion }
      : {}),
    ...(entry.lastCheckedAt ? { lastCheckedAt: entry.lastCheckedAt } : {}),
    ...(entry.lastRemoteCheckAt ? { lastRemoteCheckAt: entry.lastRemoteCheckAt } : {}),
    ...(entry.lastError ? { lastError: entry.lastError } : {}),
  }
}

export function vendorCliDisplayPath(vendor: VendorId, version: string): string {
  return join(
    '~',
    '.c3',
    'vendor',
    vendor,
    version,
    'bin',
    basename(managedBinPath(vendor, version)),
  )
}

export function resolveAbsoluteExecutablePath(path: string): string {
  return resolvePath(path)
}
