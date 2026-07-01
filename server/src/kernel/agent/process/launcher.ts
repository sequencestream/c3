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

export interface VendorBinarySpec {
  readonly vendor: VendorId
  readonly binary: string
  readonly pathEnv: string
  readonly packageName: string
  readonly preferredDistTag: string
  readonly compatibleRange: string
  readonly installHint: string
}

export const HOST_BINARIES: Record<VendorId, VendorBinarySpec> = {
  claude: {
    vendor: 'claude',
    binary: 'claude',
    pathEnv: 'CLAUDE_PATH',
    packageName: '@anthropic-ai/claude-code',
    preferredDistTag: 'stable',
    compatibleRange: '>=0.0.0 <999.0.0',
    installHint:
      'c3 installs Claude Code under ~/.c3/vendor/claude by default. Override with $CLAUDE_PATH, or keep a host `claude` on PATH as a degraded fallback.',
  },
  codex: {
    vendor: 'codex',
    binary: 'codex',
    pathEnv: 'CODEX_PATH',
    packageName: '@openai/codex',
    preferredDistTag: `${process.platform}-${process.arch}`,
    compatibleRange: '>=0.0.0 <999.0.0',
    installHint:
      'c3 installs Codex under ~/.c3/vendor/codex by default. Override with $CODEX_PATH, or keep a host `codex` on PATH as a degraded fallback.',
  },
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
    claude: [/claude(?:\s+code)?\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i],
    codex: [/codex\s+(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i],
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
    compatibleRange: spec.compatibleRange,
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
  const spec = HOST_BINARIES[vendor]
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
    compatibleRange: spec.compatibleRange,
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
        compatibleRange: spec.compatibleRange,
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
    compatibleRange: spec.compatibleRange,
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
      const probe: VendorProbe = {
        vendor,
        binary: spec.binary,
        path: override,
        source: 'env-override',
        present: true,
        version,
        compatibleRange: spec.compatibleRange,
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
        compatibleRange: spec.compatibleRange,
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

  const pins = getVendorCliVersions()
  const state = readState()
  const manualVersion = pins[vendor] || undefined
  const selectedVersion =
    manualVersion ??
    state.vendors[vendor]?.latestCompatibleVersion ??
    state.vendors[vendor]?.selectedVersion
  if (selectedVersion) {
    try {
      const probe = probeManaged(vendor, selectedVersion, deps)
      cache.set(vendor, probe)
      recordState(
        vendor,
        {
          source: 'managed',
          selectedVersion,
          manualVersion,
          path: probe.path ?? undefined,
          lastError: undefined,
          versionHistory: [
            {
              version: selectedVersion,
              installedPath: probe.path ?? undefined,
              lastUsedAt: nowIso(deps),
              status: 'selected',
            },
            ...(state.vendors[vendor]?.versionHistory ?? []).filter(
              (h) => h.version !== selectedVersion,
            ),
          ],
        },
        deps,
      )
      return probe
    } catch (err) {
      const managedError = `managed ${vendor} ${selectedVersion} unusable: ${(err as Error).message}`
      const probe = fallbackProbe(vendor, managedError, deps)
      cache.set(vendor, probe)
      recordState(vendor, { source: probe.source, manualVersion, lastError: managedError }, deps)
      return probe
    }
  }

  const probe = fallbackProbe(vendor, 'managed CLI not installed yet', deps)
  cache.set(vendor, probe)
  recordState(vendor, { source: probe.source, manualVersion, lastError: probe.managedError }, deps)
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
    .filter((v) => satisfiesRange(v, range))
    .sort(compareVersions)
}

export function selectNpmVersion(
  vendor: VendorId,
  packument: NpmPackument,
  manualVersion?: string,
  platform = process.platform,
  arch = process.arch,
): { version: string; sourceTag: string } {
  const spec = HOST_BINARIES[vendor]
  if (manualVersion) {
    if (!satisfiesRange(manualVersion, spec.compatibleRange)) {
      throw new Error(`${vendor} manual version ${manualVersion} outside ${spec.compatibleRange}`)
    }
    if (!versionRecord(packument, manualVersion))
      throw new Error(`${vendor} ${manualVersion} not in npm packument`)
    return { version: manualVersion, sourceTag: 'manual' }
  }

  const tags = packument['dist-tags'] ?? {}
  const candidates =
    vendor === 'codex'
      ? [platformTag(platform, arch), spec.preferredDistTag, 'latest']
      : [spec.preferredDistTag, 'latest']
  for (const tag of candidates) {
    const version = tags[tag]
    if (
      version &&
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
  const spec = HOST_BINARIES[vendor]
  const home = c3HomeDir()
  const state = readState(home)
  const manualVersion = getVendorCliVersions()[vendor] || undefined
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
    recordState(vendor, { source: fallback.source, manualVersion, lastError: msg }, deps)
    return fallback.path ? { ...fallback, managedError: msg } : missingProbe(vendor, undefined, msg)
  }

  const selected = selectNpmVersion(vendor, packument, manualVersion)
  const path = managedBinPath(vendor, selected.version, home)
  if (existsSync(path)) {
    const probe = probeManaged(vendor, selected.version, deps)
    const prior = state.vendors[vendor]
    recordState(
      vendor,
      {
        source: 'managed',
        selectedVersion: selected.version,
        manualVersion,
        latestCompatibleVersion: manualVersion ? prior?.latestCompatibleVersion : selected.version,
        path,
        lastRemoteCheckAt: nowIso(deps),
        lastError: undefined,
        versionHistory: installHistory(prior, {
          version: selected.version,
          sourceTag: selected.sourceTag,
          installedPath: path,
          lastUsedAt: nowIso(deps),
          status: 'selected',
        }),
      },
      deps,
    )
    resetProbeCache()
    return probe
  }

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
        selectedVersion: selected.version,
        manualVersion,
        latestCompatibleVersion: manualVersion ? prior?.latestCompatibleVersion : selected.version,
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
    return probeManaged(vendor, selected.version, deps)
  } catch (err) {
    const msg = `managed ${vendor} ${selected.version} install failed: ${(err as Error).message}`
    const old = resolveExecutable(vendor, deps)
    const prior = readState(home).vendors[vendor]
    recordState(
      vendor,
      {
        source: old.source,
        manualVersion,
        latestCompatibleVersion: manualVersion ? prior?.latestCompatibleVersion : selected.version,
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

export async function syncManagedVendorClis(deps?: VendorInstallerDeps): Promise<VendorProbe[]> {
  const out: VendorProbe[] = []
  for (const vendor of Object.keys(HOST_BINARIES) as VendorId[]) {
    out.push(await syncManagedVendorCli(vendor, deps))
  }
  return out
}

export function shouldCheckRemote(vendor: VendorId, now = Date.now()): boolean {
  const last = readState().vendors[vendor]?.lastRemoteCheckAt
  if (!last) return true
  return now - Date.parse(last) >= REMOTE_CHECK_INTERVAL_MS
}

export function refreshManagedVendorClisInBackground(deps?: VendorInstallerDeps): void {
  for (const vendor of Object.keys(HOST_BINARIES) as VendorId[]) {
    if (!shouldCheckRemote(vendor, deps?.now?.().getTime())) continue
    void syncManagedVendorCli(vendor, deps).catch((err: unknown) => {
      recordState(vendor, { source: 'install-failed', lastError: (err as Error).message }, deps)
    })
  }
}

export function cleanManagedHistory(vendor: VendorId, inUse: readonly string[] = []): void {
  const home = c3HomeDir()
  const state = readState(home)
  const entry = state.vendors[vendor]
  if (!entry) return
  const protectedVersions = new Set(
    [entry.selectedVersion, entry.manualVersion, ...inUse].filter((v): v is string => Boolean(v)),
  )
  for (const h of entry.versionHistory.slice(HISTORY_LIMIT)) {
    if (protectedVersions.has(h.version)) continue
    rmSync(join(home, 'vendor', vendor, h.version), { recursive: true, force: true })
  }
  entry.versionHistory = trimHistory(entry.versionHistory)
  writeState(home, state)
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
