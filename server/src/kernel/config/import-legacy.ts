/**
 * One-shot import of the three legacy JSON configuration files into `c3.db`.
 *
 *   `~/.c3/settings.json`         → system / workspace / personalized / mcp-key rows
 *   `~/.c3/state.json`            → session rows (agent binding, pending intents)
 *   `~/.claude/c3/state.json`     → the workspace registry + session modes + skill state
 *
 * Each file is a separate marker in `schema_migrations`, so a partially upgraded
 * install finishes the rest on the next boot, and a file that was already imported is
 * never read again — the db is the source of truth from that moment on, and an old
 * JSON left lying around must not be able to resurrect a setting the user changed.
 * Every import writes its rows and its marker inside ONE transaction: a rollback
 * takes the marker with it, so a half-finished import can never read as complete.
 *
 * After a successful import the file is renamed to `<name>.migrated-<epoch>`. It stays
 * on disk (it is the only copy of the pre-migration state) but stops being a second
 * configuration a user could edit and wonder why nothing happens. A failed rename is
 * logged and otherwise ignored: the marker already decided the import is done.
 */
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import { hasMigration, markMigration, type Db } from '../infra/db.js'
import { toEntries, type ConfigEntry } from './config-codec.js'
import {
  AGENT_LANG_KEY,
  MCP_KEY_RULES,
  PERSONALIZED_RULES,
  SESSION_KEYS,
  SYSTEM_RULES,
  WORKSPACE_RULES,
} from './config-schema.js'
import { configTx, writeScope } from './config-store.js'
import { decryptAgentApiKeys } from './encryption.js'
import { legacySettingsFile, legacyStateFile } from './paths.js'
import { ensureWorkspaceId, putWorkspaceRow } from './workspace-store.js'

const MARKER_WORKSPACES = 'config.import_workspaces.v1'
const MARKER_SETTINGS = 'config.import_settings.v1'
const MARKER_SESSION_STATE = 'config.import_session_state.v1'

/** The workspace registry / session-mode file the c3 UI state used to live in. */
function legacyUiStateFile(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR
    ? resolve(process.env.CLAUDE_CONFIG_DIR)
    : join(homedir(), '.claude')
  return join(dir, 'c3', 'state.json')
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch (err) {
    console.error(`[c3] 旧配置文件无法解析,已跳过导入: ${file}`, err)
    return null
  }
}

function retire(file: string): void {
  try {
    if (existsSync(file)) renameSync(file, `${file}.migrated-${Date.now()}`)
  } catch (err) {
    console.error(`[c3] 旧配置文件重命名失败(不影响已完成的导入): ${file}`, err)
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

// ---------------------------------------------------------------------------
// The workspace registry (and the UI state that shared its file)
// ---------------------------------------------------------------------------

function importUiState(d: Db, now: number): void {
  const raw = readJson(legacyUiStateFile())
  if (raw) {
    const workspaces = Array.isArray(raw.workspaces) ? raw.workspaces : []
    const systemEntries = toEntries(
      {
        state: {
          activeSessionId:
            typeof raw.activeSessionId === 'string' ? raw.activeSessionId : undefined,
          skillSupport: asRecord(raw.skillSupport) ?? undefined,
          skillLink: asRecord(raw.skillLinkIndex) ?? undefined,
          skillAcks: asRecord(raw.skillAcks) ?? undefined,
        },
      },
      SYSTEM_RULES,
    )
    for (const w of workspaces) {
      const rec = asRecord(w)
      if (!rec || typeof rec.path !== 'string' || !rec.path) continue
      putWorkspaceRow(
        {
          // Keep the id the wire already handed out; a fresh uuid would invalidate
          // every workspace id a running console holds.
          id: typeof rec.id === 'string' && rec.id ? rec.id : ensureWorkspaceId(rec.path, now),
          path: rec.path,
          name: typeof rec.name === 'string' && rec.name ? rec.name : rec.path,
          lastAccessed: typeof rec.lastAccessed === 'number' ? rec.lastAccessed : now,
          registered: true,
        },
        now,
      )
    }
    if (systemEntries.length > 0) writeScope({ kind: 'system' }, systemEntries, { replace: false })
    importSessionModes(raw)
  }
  markMigration(d, MARKER_WORKSPACES)
}

/** Session permission mode + codex policy, keyed by session id. */
function importSessionModes(raw: Record<string, unknown>): void {
  const modes = asRecord(raw.sessionModes) ?? {}
  const policies = asRecord(raw.sessionCodexPolicies) ?? {}
  for (const [sessionId, mode] of Object.entries(modes)) {
    if (typeof mode !== 'string' || !mode) continue
    writeScope(
      { kind: 'session', owner: sessionId },
      [{ key: SESSION_KEYS.mode, value: mode, type: 'string' }],
      { replace: false },
    )
  }
  for (const [sessionId, policy] of Object.entries(policies)) {
    const rec = asRecord(policy)
    if (!rec) continue
    const entries: ConfigEntry[] = []
    if (typeof rec.sandboxMode === 'string')
      entries.push({ key: SESSION_KEYS.codexSandboxMode, value: rec.sandboxMode, type: 'string' })
    if (typeof rec.approvalPolicy === 'string')
      entries.push({
        key: SESSION_KEYS.codexApprovalPolicy,
        value: rec.approvalPolicy,
        type: 'string',
      })
    if (entries.length > 0)
      writeScope({ kind: 'session', owner: sessionId }, entries, { replace: false })
  }
}

// ---------------------------------------------------------------------------
// settings.json
// ---------------------------------------------------------------------------

function importSettings(d: Db, now: number): void {
  const raw = readJson(legacySettingsFile())
  if (raw) {
    // apiKeys are ciphertext on disk; decrypt first so the codec's `secret` handling
    // re-encrypts the PLAINTEXT rather than encrypting an already-encrypted token.
    decryptAgentApiKeys(raw)

    const { projectConfigs, personalizedSettings, agentLang, mcpApiKeys, ...system } = raw
    // The top-level `uiLang` was superseded by per-account personalized settings and
    // is dropped on every save already; it must not come back through the import.
    delete system.uiLang

    const systemEntries = toEntries(system, SYSTEM_RULES)
    if (typeof agentLang === 'string' && agentLang) {
      systemEntries.push({ key: AGENT_LANG_KEY, value: agentLang, type: 'string' })
    }
    if (systemEntries.length > 0) writeScope({ kind: 'system' }, systemEntries, { replace: false })

    for (const [path, config] of Object.entries(asRecord(projectConfigs) ?? {})) {
      const rec = asRecord(config)
      if (!rec) continue
      // A path that is not a registered workspace still gets its configuration —
      // under a row that stays out of the workspace list until the user adds it.
      const workspaceId = ensureWorkspaceId(path, now)
      writeScope({ kind: 'workspace', owner: workspaceId }, toEntries(rec, WORKSPACE_RULES))
    }

    for (const [subject, prefs] of Object.entries(asRecord(personalizedSettings) ?? {})) {
      const rec = asRecord(prefs)
      if (!rec) continue
      writeScope({ kind: 'personalized', owner: subject }, toEntries(rec, PERSONALIZED_RULES))
    }

    if (Array.isArray(mcpApiKeys)) {
      for (const key of mcpApiKeys) {
        const rec = asRecord(key)
        if (!rec || typeof rec.id !== 'string' || !rec.id) continue
        const { id, ...fields } = rec
        writeScope({ kind: 'mcpKey', owner: id }, toEntries(fields, MCP_KEY_RULES))
      }
    }
  }
  markMigration(d, MARKER_SETTINGS)
}

// ---------------------------------------------------------------------------
// state.json (session ↔ agent binding)
// ---------------------------------------------------------------------------

function importSessionState(d: Db, now: number): void {
  const raw = readJson(legacyStateFile())
  if (raw) {
    const sessionAgents = asRecord(raw.sessionAgents) ?? {}
    for (const [sessionId, fact] of Object.entries(sessionAgents)) {
      // A v1 blob stored one map of bare agent-id strings, conflating both key spaces.
      // Split it the way the shape always meant: a `pending:` key is an intent (no
      // vendor to freeze), anything else is a fact — and multi-vendor did not exist
      // then, so such a fact is a claude session by construction.
      if (typeof fact === 'string') {
        if (!fact) continue
        if (sessionId.startsWith(PENDING_SESSION_PREFIX)) {
          writeScope(
            { kind: 'session', owner: sessionId },
            [
              { key: SESSION_KEYS.agentId, value: fact, type: 'string' },
              { key: SESSION_KEYS.pendingCreatedAt, value: String(now), type: 'number' },
            ],
            { replace: false },
          )
        } else {
          writeScope(
            { kind: 'session', owner: sessionId },
            [
              { key: SESSION_KEYS.agentId, value: fact, type: 'string' },
              { key: SESSION_KEYS.vendor, value: 'claude', type: 'string' },
            ],
            { replace: false },
          )
        }
        continue
      }
      const rec = asRecord(fact)
      if (!rec || typeof rec.agentId !== 'string' || !rec.agentId) continue
      const entries: ConfigEntry[] = [
        { key: SESSION_KEYS.agentId, value: rec.agentId, type: 'string' },
      ]
      if (typeof rec.vendor === 'string')
        entries.push({ key: SESSION_KEYS.vendor, value: rec.vendor, type: 'string' })
      if (rec.storeScope === 'host' || rec.storeScope === 'sandbox')
        entries.push({ key: SESSION_KEYS.storeScope, value: rec.storeScope, type: 'string' })
      writeScope({ kind: 'session', owner: sessionId }, entries, { replace: false })
    }

    for (const [pendingId, intent] of Object.entries(asRecord(raw.pendingIntents) ?? {})) {
      const rec = asRecord(intent)
      if (!rec || typeof rec.agentId !== 'string' || !rec.agentId) continue
      const createdAt = typeof rec.createdAt === 'number' ? rec.createdAt : now
      writeScope(
        { kind: 'session', owner: pendingId },
        [
          { key: SESSION_KEYS.agentId, value: rec.agentId, type: 'string' },
          { key: SESSION_KEYS.pendingCreatedAt, value: String(createdAt), type: 'number' },
        ],
        { replace: false },
      )
    }
  }
  markMigration(d, MARKER_SESSION_STATE)
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

let imported = false

/**
 * Import whatever legacy file has not been imported yet. Cheap and idempotent: after
 * the first call in a process it is a no-op, and across processes the markers decide.
 * Every configuration read entry point calls this before its first load.
 */
export function ensureLegacyImport(): void {
  if (imported) return
  imported = true
  // Renaming happens only after the transaction commits: a rename inside it would
  // survive a rollback and take the only copy of the configuration with it.
  const retireAfterCommit: string[] = []
  try {
    configTx((d) => {
      const now = Date.now()
      if (!hasMigration(d, MARKER_WORKSPACES)) {
        importUiState(d, now)
        retireAfterCommit.push(legacyUiStateFile())
      }
      if (!hasMigration(d, MARKER_SETTINGS)) {
        importSettings(d, now)
        retireAfterCommit.push(legacySettingsFile())
      }
      if (!hasMigration(d, MARKER_SESSION_STATE)) {
        importSessionState(d, now)
        retireAfterCommit.push(legacyStateFile())
      }
    })
  } catch (err) {
    // The db is unavailable or the import failed as a whole (the transaction rolled
    // back, markers included). c3 continues on defaults and retries on the next boot.
    console.error('[c3] 旧配置导入失败,本次使用默认配置(下次启动会重试):', err)
    return
  }
  for (const file of retireAfterCommit) retire(file)
}

/** Test hook: allow the import to run again in the same process. */
export function resetLegacyImportForTests(): void {
  imported = false
}
