/**
 * One-shot legacy import: the three JSON files land in the right tables with the
 * right shapes (workspace names preserved, apiKeys re-encrypted from plaintext, unknown
 * workspace paths kept out of the workspace list), the files are retired afterwards,
 * and a second run imports nothing — the db, not the file, is the source of truth
 * from the first import on.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resetDbForTests } from '../infra/db.js'
import { fromEntries } from './config-codec.js'
import { PERSONALIZED_RULES, SESSION_KEYS, SYSTEM_RULES, WORKSPACE_RULES } from './config-schema.js'
import { readScope, resetConfigStoreForTests, writeScope } from './config-store.js'
import { encryptSecret } from './encryption.js'
import { ensureLegacyImport, resetLegacyImportForTests } from './import-legacy.js'
import { setSettingsPath } from './paths.js'
import { findWorkspaceByPath, listWorkspaceRows } from './workspace-store.js'

let home: string
let claudeHome: string
let settingsPath: string

function writeLegacyFiles(): void {
  writeFileSync(
    settingsPath,
    JSON.stringify({
      agents: [
        {
          id: 'sys',
          vendor: 'claude',
          displayName: 'System',
          config: { apiKey: encryptSecret('sk-secret'), baseUrl: '', model: '' },
        },
      ],
      defaultAgentId: 'sys',
      timezone: 'Asia/Shanghai',
      proxy: { enabled: true, httpProxy: 'http://p:3128' },
      projectConfigs: {
        '/tmp/registered-proj': { sddEnabled: true, maxRoundsPerStage: 9 },
        '/tmp/gone-proj': { sddEnabled: false },
      },
      personalizedSettings: { alice: { uiLang: 'zh', theme: 'light' } },
      agentLang: 'zh',
      mcpApiKeys: [
        {
          id: 'k1',
          label: 'ci',
          secretHash: 'scrypt$abc',
          createdAt: 7,
          workspace: '/tmp/registered-proj',
        },
      ],
    }),
  )
  writeFileSync(
    join(home, 'state.json'),
    JSON.stringify({
      version: 2,
      sessionAgents: { 'sess-1': { agentId: 'sys', vendor: 'claude', storeScope: 'sandbox' } },
      pendingIntents: { 'pending:abc': { agentId: 'sys', createdAt: 42 } },
    }),
  )
  writeFileSync(
    join(claudeHome, 'c3', 'state.json'),
    JSON.stringify({
      version: 2,
      workspaces: [
        {
          id: '11111111-2222-3333-4444-555555555555',
          path: '/tmp/registered-proj',
          name: 'registered-proj',
          lastAccessed: 5,
        },
      ],
      sessionModes: { 'sess-1': 'plan' },
      sessionCodexPolicies: { 'sess-2': { sandboxMode: 'read-only', approvalPolicy: 'never' } },
      activeSessionId: 'sess-1',
      skillSupport: { claude: { supported: true } },
      skillLinkIndex: { '/p:claude:id': { id: 'id', ref: 'sha' } },
      skillAcks: { '/p': { gitignore: true } },
    }),
  )
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'c3-import-'))
  claudeHome = mkdtempSync(join(tmpdir(), 'c3-claude-'))
  mkdirSync(join(claudeHome, 'c3'), { recursive: true })
  settingsPath = join(home, 'settings.json')
  process.env.C3_DB_PATH = join(home, 'c3.db')
  process.env.CLAUDE_CONFIG_DIR = claudeHome
  resetDbForTests()
  resetConfigStoreForTests()
  resetLegacyImportForTests()
  setSettingsPath(settingsPath)
  writeLegacyFiles()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  delete process.env.CLAUDE_CONFIG_DIR
  rmSync(home, { recursive: true, force: true })
  rmSync(claudeHome, { recursive: true, force: true })
})

describe('ensureLegacyImport', () => {
  it('imports system settings with secrets re-encrypted from plaintext', () => {
    ensureLegacyImport()
    const system = fromEntries(readScope({ kind: 'system' }), SYSTEM_RULES)
    expect(system.timezone).toBe('Asia/Shanghai')
    expect(system.proxy).toEqual({ enabled: true, httpProxy: 'http://p:3128' })
    const agents = system.agents as { config: { apiKey: string } }[]
    expect(agents).toHaveLength(1)
    // Decoded back to plaintext ⇒ it was stored as a single (not double) encryption.
    expect(agents[0].config.apiKey).toBe('sk-secret')
    expect(system.agentLang).toBe('zh')
    expect(system.projectConfigs).toBeUndefined()

    const raw = readScope({ kind: 'system' }).find((e) => e.key === 'agents.sys.config.apiKey')
    expect(raw?.type).toBe('secret')
    expect(raw?.value).toMatch(/^c3secretv1:/)
  })

  it('preserves workspace names and keeps unregistered paths out of the list', () => {
    ensureLegacyImport()
    expect(findWorkspaceByPath('/tmp/registered-proj')).toMatchObject({
      name: 'registered-proj',
      registered: true,
    })
    const listed = listWorkspaceRows()
    expect(listed).toHaveLength(1)

    const gone = findWorkspaceByPath('/tmp/gone-proj')
    expect(gone?.registered).toBe(false)
    // …but its configuration is imported all the same.
    expect(
      fromEntries(readScope({ kind: 'workspace', owner: gone!.name }), WORKSPACE_RULES),
    ).toEqual({
      sddEnabled: false,
    })
    expect(
      fromEntries(readScope({ kind: 'workspace', owner: 'registered-proj' }), WORKSPACE_RULES),
    ).toEqual({ sddEnabled: true, maxRoundsPerStage: 9 })
  })

  it('imports personalized, mcp-key, session and ui-state rows', () => {
    ensureLegacyImport()
    expect(
      fromEntries(readScope({ kind: 'personalized', owner: 'alice' }), PERSONALIZED_RULES),
    ).toEqual({
      uiLang: 'zh',
      theme: 'light',
    })
    const key = fromEntries(readScope({ kind: 'mcpKey', owner: 'k1' })) as Record<string, unknown>
    expect(key).toEqual({
      label: 'ci',
      secretHash: 'scrypt$abc',
      createdAt: 7,
      workspaceName: 'registered-proj',
    })

    const session = Object.fromEntries(
      readScope({ kind: 'session', owner: 'sess-1' }).map((e) => [e.key, e.value]),
    )
    expect(session[SESSION_KEYS.agentId]).toBe('sys')
    expect(session[SESSION_KEYS.storeScope]).toBe('sandbox')
    expect(session[SESSION_KEYS.mode]).toBe('plan')

    const pending = Object.fromEntries(
      readScope({ kind: 'session', owner: 'pending:abc' }).map((e) => [e.key, e.value]),
    )
    expect(pending[SESSION_KEYS.pendingCreatedAt]).toBe('42')

    const system = fromEntries(readScope({ kind: 'system' }), SYSTEM_RULES)
    expect(system.state).toEqual({
      activeSessionId: 'sess-1',
      skillSupport: { claude: { supported: true } },
      skillLink: { '/p:claude:id': { id: 'id', ref: 'sha' } },
      skillAcks: { '/p': { gitignore: true } },
    })
  })

  it('retires the files and never imports them twice', () => {
    ensureLegacyImport()
    expect(existsSync(settingsPath)).toBe(false)
    expect(readdirSync(home).some((f) => f.startsWith('settings.json.migrated-'))).toBe(true)
    expect(existsSync(join(home, 'state.json'))).toBe(false)
    expect(existsSync(join(claudeHome, 'c3', 'state.json'))).toBe(false)

    // A user edits a setting after the migration, then an old settings.json reappears
    // (restored from a backup). The import must not run again and undo the change.
    writeScope({ kind: 'system' }, [{ key: 'timezone', value: 'UTC', type: 'string' }], {
      replace: false,
    })
    writeFileSync(settingsPath, JSON.stringify({ timezone: 'Europe/Paris' }))
    resetLegacyImportForTests()
    ensureLegacyImport()
    const system = fromEntries(readScope({ kind: 'system' }), SYSTEM_RULES)
    expect(system.timezone).toBe('UTC')
    expect(existsSync(settingsPath)).toBe(true)
  })

  it('splits a v1 state blob: pending keys become intents, real keys become claude facts', () => {
    // The pre-ADR-0015 shape: one map of session id → agent id, no vendor anywhere.
    writeFileSync(
      join(home, 'state.json'),
      JSON.stringify({
        version: 1,
        sessionAgents: { 'pending:legacy': 'oc', 'real-legacy': 'claude-b' },
      }),
    )
    ensureLegacyImport()

    const pending = Object.fromEntries(
      readScope({ kind: 'session', owner: 'pending:legacy' }).map((e) => [e.key, e.value]),
    )
    // A pending key carries no vendor — it is an intent, not a fact.
    expect(pending[SESSION_KEYS.agentId]).toBe('oc')
    expect(pending[SESSION_KEYS.vendor]).toBeUndefined()

    const real = Object.fromEntries(
      readScope({ kind: 'session', owner: 'real-legacy' }).map((e) => [e.key, e.value]),
    )
    // A real key becomes a fact frozen to claude — the only vendor that existed then.
    expect(real[SESSION_KEYS.agentId]).toBe('claude-b')
    expect(real[SESSION_KEYS.vendor]).toBe('claude')
  })

  it('is a no-op when no legacy file exists', () => {
    rmSync(settingsPath)
    rmSync(join(home, 'state.json'))
    rmSync(join(claudeHome, 'c3', 'state.json'))
    ensureLegacyImport()
    expect(readScope({ kind: 'system' })).toEqual([])
    expect(listWorkspaceRows()).toEqual([])
  })
})
