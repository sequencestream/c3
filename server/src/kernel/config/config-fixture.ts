/**
 * Test fixture for the configuration tables: point every config store at a throwaway
 * database and seed/inspect stored settings without going through the public save
 * path (which normalizes, and would therefore hide exactly what these tests probe).
 *
 * Only tests import this. It is the db-era replacement for "write a settings.json and
 * call `setSettingsPath`", which is what those tests used to do.
 */
import { join } from 'node:path'
import { resetDbForTests } from '../infra/db.js'
import { fromEntries, toEntries, type ConfigEntry } from './config-codec.js'
import {
  MCP_KEY_RULES,
  PERSONALIZED_RULES,
  SYSTEM_RULES,
  WORKSPACE_RULES,
} from './config-schema.js'
import { listScopeOwners, readScope, resetConfigStoreForTests, writeScope } from './config-store.js'
import { resetSettingsCacheForTests } from './index.js'
import { resetLegacyImportForTests } from './import-legacy.js'
import { resetMcpApiKeyCache } from './mcp-api-keys.js'
import { resetPersonalizedCache } from './personalized.js'
import { ensureWorkspaceId } from './workspace-store.js'

/**
 * Aim every config store at `<dir>/c3.db` and drop all caches — the state a freshly
 * started c3 is in. Call from `beforeEach`; call {@link releaseConfigDb} on the way out.
 */
export function useConfigDb(dir: string): string {
  const file = join(dir, 'c3.db')
  process.env.C3_DB_PATH = file
  resetConfigCaches()
  return file
}

/** Drop the throwaway database binding and every cache built from it. */
export function releaseConfigDb(): void {
  delete process.env.C3_DB_PATH
  resetConfigCaches()
}

/** Reset every cache that could serve values from a previous database. */
export function resetConfigCaches(): void {
  resetDbForTests()
  resetConfigStoreForTests()
  resetLegacyImportForTests()
  resetSettingsCacheForTests()
  resetPersonalizedCache()
  resetMcpApiKeyCache()
}

/**
 * Store a raw (un-normalized) system-settings record, exactly as a hand-written
 * settings.json used to. `projectConfigs` is expanded into per-workspace scopes, the
 * same split the real save path performs.
 */
export function seedSystemSettings(raw: Record<string, unknown>): void {
  const { projectConfigs, ...system } = raw
  // Replacing, not patching: `raw` is the whole stored record, so a second seed in the
  // same test starts from a clean slate instead of inheriting the first one's fields.
  writeScope({ kind: 'system' }, toEntries(system, SYSTEM_RULES))
  for (const [path, cfg] of Object.entries(
    (projectConfigs as Record<string, unknown> | undefined) ?? {},
  )) {
    seedWorkspaceSetting(path, cfg)
  }
  resetSettingsCacheForTests()
}

/** Store one workspace's raw configuration. */
export function seedWorkspaceSetting(workspacePath: string, cfg: unknown): void {
  const workspaceId = ensureWorkspaceId(workspacePath, Date.now())
  writeScope({ kind: 'workspace', owner: workspaceId }, toEntries(cfg, WORKSPACE_RULES))
  resetSettingsCacheForTests()
}

/** Store one account's raw personalized record. */
export function seedPersonalized(subject: string, raw: unknown): void {
  writeScope({ kind: 'personalized', owner: subject }, toEntries(raw, PERSONALIZED_RULES))
  resetPersonalizedCache()
}

/** Every stored personalized record, keyed by subject — for storage-level assertions. */
export function readStoredPersonalized(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const subject of listScopeOwners('personalized')) {
    const entries = readScope({ kind: 'personalized', owner: subject })
    if (entries.length > 0) out[subject] = fromEntries(entries, PERSONALIZED_RULES)
  }
  return out
}

/** Store one MCP API key record (its `id` becomes the scope owner). */
export function seedMcpKey(id: string, raw: Record<string, unknown>): void {
  const { id: _ignored, ...fields } = raw
  writeScope({ kind: 'mcpKey', owner: id }, toEntries(fields, MCP_KEY_RULES))
  resetMcpApiKeyCache()
}

/** Every stored MCP API key record, id included — for storage-level assertions. */
export function readStoredMcpKeys(): Record<string, unknown>[] {
  return listScopeOwners('mcpKey').map((id) => ({
    id,
    ...(fromEntries(readScope({ kind: 'mcpKey', owner: id }), MCP_KEY_RULES) as Record<
      string,
      unknown
    >),
  }))
}

/** Store one session's raw values (agent binding, mode, codex policy). */
export function seedSession(sessionId: string, values: Record<string, string>): void {
  writeScope(
    { kind: 'session', owner: sessionId },
    Object.entries(values).map(([key, value]) => ({ key, value, type: 'string' as const })),
  )
}

/**
 * The system rows exactly as stored — values still encoded, secrets still encrypted.
 * For tests that assert HOW a value is persisted rather than what it reads back as.
 */
export function readRawSystemRows(): ConfigEntry[] {
  return readScope({ kind: 'system' })
}

/** Write rows verbatim, bypassing the codec — for hand-built legacy/corrupt rows. */
export function seedRawSystemRows(entries: readonly ConfigEntry[]): void {
  writeScope({ kind: 'system' }, entries, { replace: false })
  resetSettingsCacheForTests()
}

/** The stored system settings as they would be read back (secrets decrypted). */
export function readStoredSystemSettings(): Record<string, unknown> {
  return fromEntries(readScope({ kind: 'system' }), SYSTEM_RULES)
}

/**
 * One workspace's stored configuration, or undefined when it has no rows — the db-era
 * equivalent of reading `projectConfigs[path]` out of the settings file.
 */
export function readStoredWorkspaceSetting(
  workspacePath: string,
): Record<string, unknown> | undefined {
  const workspaceId = ensureWorkspaceId(workspacePath, Date.now())
  const entries = readScope({ kind: 'workspace', owner: workspaceId })
  return entries.length > 0 ? fromEntries(entries, WORKSPACE_RULES) : undefined
}
