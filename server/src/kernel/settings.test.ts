import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { WorkspaceSetting, SystemSettings } from '@ccc/shared/protocol'
import {
  AGENT_ICON_MAX_CHARS,
  consensusVoters,
  enabledAgents,
  launchForAgent,
  normalizeDegradationChain,
  normalizeIcon,
  resolveSessionLaunch,
  vendorScopedVoters,
} from './agent-config/index.js'
import {
  getDefaultMainBranch,
  getDevSkill,
  getGitBranchMode,
  getMaxRoundsPerStage,
  getMaxSpeechChars,
  getServerTimezone,
  getSkillRepos,
  getSocketAutoResume,
  getTimezone,
  getUiLang,
  getUiLangName,
  UI_LANG_NAMES,
  isConsensusEnabled,
  isConsensusMajorityEnabled,
  isValidTimeZone,
  loadWorkspaceSetting,
  loadSettings,
  saveWorkspaceSetting,
  saveSettings,
  resetSettingsCacheForTests,
  DEFAULT_ROUNDS_PER_STAGE,
  DEFAULT_UI_LANG,
  MIN_ROUNDS_PER_STAGE,
  DEFAULT_SPEECH_CHARS,
  MIN_SPEECH_CHARS,
} from './config/index.js'
import { readJsonFile, writeAtomic } from './config/store.js'

// Redirect `~/.c3` to a throwaway dir (os.homedir() honours $HOME on POSIX) so
// these tests never touch the developer's real settings.json.
let dir: string
let prevHome: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-settings-'))
  prevHome = process.env.HOME
  process.env.HOME = dir
  resetSettingsCacheForTests()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME
  else process.env.HOME = prevHome
  resetSettingsCacheForTests()
  rmSync(dir, { recursive: true, force: true })
})

/** Dummy project path for project-level config tests. */
const TEST_PROJ = '/test/project'

/** Persist just a `devSkill` value (with the required baseline fields). */
function saveWithDevSkill(devSkill: string | undefined): void {
  saveWorkspaceSetting(TEST_PROJ, { devSkill } as WorkspaceSetting)
}

/** The on-disk settings.json path under the throwaway $HOME for this test run. */
function settingsPath(): string {
  return join(dir, '.c3', 'settings.json')
}

describe('unique write path — anti-clobber + cross-process merge (2026-06-08-003)', () => {
  /** A minimal legacy-flat agent so degradationChain has a real id to reference. */
  const A1 = { id: 'a1', name: 'One', baseUrl: 'https://one', apiKey: 'k', model: '' }

  it('in-process: two sequential saveWorkspaceSetting (different projects) both persist', () => {
    saveWorkspaceSetting('/proj/a', { devSkill: '/a' } as WorkspaceSetting)
    saveWorkspaceSetting('/proj/b', { devSkill: '/b' } as WorkspaceSetting)
    expect(getDevSkill('/proj/a')).toBe('/a')
    expect(getDevSkill('/proj/b')).toBe('/b')
  })

  it('cross-process: saveWorkspaceSetting re-reads disk and keeps a project another process just added', () => {
    saveWorkspaceSetting('/proj/a', { devSkill: '/a' } as WorkspaceSetting)
    // Simulate ANOTHER c3 instance writing /proj/b straight to disk. We deliberately
    // do NOT reset the in-memory cache — proving our write reads disk, not the cache.
    const disk = readJsonFile<SystemSettings>(settingsPath())!
    writeAtomic(settingsPath(), {
      ...disk,
      projectConfigs: {
        ...disk.projectConfigs,
        '/proj/b': { devSkill: '/b' },
      },
    })
    // Now this process saves /proj/c — it must merge over fresh disk, not stale cache.
    saveWorkspaceSetting('/proj/c', { devSkill: '/c' } as WorkspaceSetting)
    expect(getDevSkill('/proj/a')).toBe('/a')
    expect(getDevSkill('/proj/b')).toBe('/b') // the foreign write survived
    expect(getDevSkill('/proj/c')).toBe('/c')
  })

  it('anti-clobber: saveSettings WITHOUT projectConfigs preserves existing project configs', () => {
    saveWorkspaceSetting('/proj/a', { devSkill: '/a' } as WorkspaceSetting)
    // The old bug: a save_settings carrying no projectConfigs wiped them from disk.
    saveSettings({ agents: [], defaultAgentId: SYSTEM_AGENT_ID } as SystemSettings)
    expect(loadSettings().projectConfigs?.['/proj/a']).toBeTruthy()
    expect(getDevSkill('/proj/a')).toBe('/a')
  })

  it('anti-clobber: saveSettings WITH explicit projectConfigs updates by value and merges siblings', () => {
    saveWorkspaceSetting('/proj/a', { devSkill: '/a' } as WorkspaceSetting)
    saveSettings({
      agents: [],
      defaultAgentId: SYSTEM_AGENT_ID,
      projectConfigs: { '/proj/b': { devSkill: '/b' } },
    } as unknown as SystemSettings)
    expect(getDevSkill('/proj/a')).toBe('/a') // sibling preserved
    expect(getDevSkill('/proj/b')).toBe('/b') // explicit entry applied
  })

  it('anti-clobber: degradationChain / socketAutoResume preserved when omitted, updated when present', () => {
    saveSettings({
      agents: [A1],
      defaultAgentId: 'a1',
      degradationChain: ['a1'],
      socketAutoResume: false,
    } as unknown as SystemSettings)
    // A later save that omits both must keep the disk values.
    saveSettings({ agents: [A1], defaultAgentId: 'a1' } as unknown as SystemSettings)
    expect(loadSettings().degradationChain).toEqual(['a1'])
    expect(getSocketAutoResume()).toBe(false)
    // An explicit value updates.
    saveSettings({
      agents: [A1],
      defaultAgentId: 'a1',
      socketAutoResume: true,
    } as unknown as SystemSettings)
    expect(getSocketAutoResume()).toBe(true)
  })
})

describe('getSocketAutoResume normalization (AS-R18 / AVAIL-7)', () => {
  const save = (socketAutoResume: boolean | undefined): void => {
    saveSettings({
      agents: [],
      defaultAgentId: SYSTEM_AGENT_ID,
      socketAutoResume,
    } as SystemSettings)
  }

  it('defaults to true when unset', () => {
    save(undefined)
    expect(getSocketAutoResume()).toBe(true)
    expect(loadSettings().socketAutoResume).toBe(true)
  })

  it('stays true when explicitly enabled', () => {
    save(true)
    expect(getSocketAutoResume()).toBe(true)
  })

  it('is false only when explicitly disabled', () => {
    save(false)
    expect(getSocketAutoResume()).toBe(false)
    expect(loadSettings().socketAutoResume).toBe(false)
  })
})

describe('consensus.majority normalization (isConsensusMajorityEnabled)', () => {
  const saveConsensus = (consensus: unknown): void => {
    saveWorkspaceSetting(TEST_PROJ, { consensus } as unknown as WorkspaceSetting)
  }

  it('defaults to false when consensus is entirely absent', () => {
    saveWorkspaceSetting(TEST_PROJ, {} as WorkspaceSetting)
    expect(isConsensusMajorityEnabled(TEST_PROJ)).toBe(false)
    expect(loadWorkspaceSetting(TEST_PROJ).consensus?.majority).toBe(false)
  })

  it('defaults to false when consensus exists but omits majority', () => {
    saveConsensus({ enabled: true })
    expect(isConsensusMajorityEnabled(TEST_PROJ)).toBe(false)
    // The sibling flag round-trips independently.
    expect(isConsensusEnabled(TEST_PROJ)).toBe(true)
  })

  it('is true only when explicitly majority: true', () => {
    saveConsensus({ enabled: true, majority: true })
    expect(isConsensusMajorityEnabled(TEST_PROJ)).toBe(true)
    expect(loadWorkspaceSetting(TEST_PROJ).consensus?.majority).toBe(true)
  })

  it('treats a non-true value (truthy or not) as false', () => {
    saveConsensus({ enabled: true, majority: 'yes' })
    expect(isConsensusMajorityEnabled(TEST_PROJ)).toBe(false)
    saveConsensus({ enabled: true, majority: 1 })
    expect(isConsensusMajorityEnabled(TEST_PROJ)).toBe(false)
    saveConsensus({ enabled: true, majority: false })
    expect(isConsensusMajorityEnabled(TEST_PROJ)).toBe(false)
  })

  it('is independent of enabled (majority can be true while consensus is off)', () => {
    saveConsensus({ enabled: false, majority: true })
    expect(isConsensusEnabled(TEST_PROJ)).toBe(false)
    expect(isConsensusMajorityEnabled(TEST_PROJ)).toBe(true)
  })
})

describe('getDevSkill normalization', () => {
  it('defaults to empty (no prefix) when unset', () => {
    saveWithDevSkill(undefined)
    expect(getDevSkill(TEST_PROJ)).toBe('')
  })

  it('defaults to empty for a whitespace-only value', () => {
    saveWithDevSkill('   ')
    expect(getDevSkill(TEST_PROJ)).toBe('')
  })

  it('trims surrounding whitespace', () => {
    saveWithDevSkill('  /foo  ')
    expect(getDevSkill(TEST_PROJ)).toBe('/foo')
  })

  it('prepends a missing leading slash', () => {
    saveWithDevSkill('my-skill')
    expect(getDevSkill(TEST_PROJ)).toBe('/my-skill')
  })

  it('keeps an already-slashed command unchanged', () => {
    saveWithDevSkill('/foo')
    expect(getDevSkill(TEST_PROJ)).toBe('/foo')
  })
})

/** Persist just a `maxRoundsPerStage` value (with the required baseline fields). */
function saveWithMaxRounds(value: unknown): void {
  saveWorkspaceSetting(TEST_PROJ, { maxRoundsPerStage: value } as unknown as WorkspaceSetting)
}

describe('getMaxRoundsPerStage normalization', () => {
  it('falls back to the default when unset', () => {
    saveWithMaxRounds(undefined)
    expect(getMaxRoundsPerStage(TEST_PROJ)).toBe(DEFAULT_ROUNDS_PER_STAGE)
  })

  it('clamps a positive value below the floor up to the minimum', () => {
    saveWithMaxRounds(5)
    expect(getMaxRoundsPerStage(TEST_PROJ)).toBe(MIN_ROUNDS_PER_STAGE)
  })

  it('clamps the floor exactly to the minimum', () => {
    saveWithMaxRounds(MIN_ROUNDS_PER_STAGE)
    expect(getMaxRoundsPerStage(TEST_PROJ)).toBe(MIN_ROUNDS_PER_STAGE)
  })

  it('keeps a legal value at or above the floor', () => {
    saveWithMaxRounds(20)
    expect(getMaxRoundsPerStage(TEST_PROJ)).toBe(20)
  })

  it('floors a fractional value', () => {
    saveWithMaxRounds(12.9)
    expect(getMaxRoundsPerStage(TEST_PROJ)).toBe(12)
  })

  it('falls back to the default for a non-numeric value', () => {
    saveWithMaxRounds('nope')
    expect(getMaxRoundsPerStage(TEST_PROJ)).toBe(DEFAULT_ROUNDS_PER_STAGE)
  })

  it('falls back to the default for zero/negative values', () => {
    saveWithMaxRounds(0)
    expect(getMaxRoundsPerStage(TEST_PROJ)).toBe(DEFAULT_ROUNDS_PER_STAGE)
    saveWithMaxRounds(-3)
    expect(getMaxRoundsPerStage(TEST_PROJ)).toBe(DEFAULT_ROUNDS_PER_STAGE)
  })
})

const AGENTS: import('@ccc/shared/protocol').AgentConfig[] = [
  {
    id: 'sys',
    vendor: 'claude',
    configMode: 'system',
    displayName: 'System',
    config: { baseUrl: '', apiKey: '', model: '' },
  },
  {
    id: 'a1',
    vendor: 'claude',
    configMode: 'custom',
    displayName: 'Agent One',
    config: { baseUrl: 'https://one.example.com', apiKey: 'key1', model: '' },
  },
  {
    id: 'a2',
    vendor: 'claude',
    configMode: 'custom',
    displayName: 'Agent Two',
    config: { baseUrl: 'https://two.example.com', apiKey: 'key2', model: '' },
  },
  {
    id: 'a3',
    vendor: 'claude',
    configMode: 'custom',
    displayName: 'Agent Three',
    config: { baseUrl: '', apiKey: '', model: 'claude-opus-4' },
  },
]

describe('normalizeDegradationChain', () => {
  it('returns undefined for undefined input', () => {
    expect(normalizeDegradationChain(undefined, AGENTS)).toBeUndefined()
  })

  it('returns undefined for empty array', () => {
    expect(normalizeDegradationChain([], AGENTS)).toBeUndefined()
  })

  it('returns undefined when no known agent ids are given', () => {
    expect(normalizeDegradationChain(['unknown-id', 'also-unknown'], AGENTS)).toBeUndefined()
  })

  it('filters out unknown ids and keeps known ones in order', () => {
    const result = normalizeDegradationChain(['unknown', 'a2', 'also-unknown', 'a1'], AGENTS)
    expect(result).toEqual(['a2', 'a1'])
  })

  it('strips duplicate ids (keeps first occurrence)', () => {
    const result = normalizeDegradationChain(['a1', 'a2', 'a1', 'a3', 'a2'], AGENTS)
    expect(result).toEqual(['a1', 'a2', 'a3'])
  })

  it('ignores non-string entries', () => {
    const result = normalizeDegradationChain(
      ['a1', null, 123, undefined, 'a2'] as unknown as string[],
      AGENTS,
    )
    expect(result).toEqual(['a1', 'a2'])
  })

  it('accepts the system agent id as a valid chain entry', () => {
    const result = normalizeDegradationChain(['sys', 'a1'], AGENTS)
    expect(result).toEqual(['sys', 'a1'])
  })

  it('drops disabled agents from the chain (AC-R10)', () => {
    const agents = AGENTS.map((a) => (a.id === 'a2' ? { ...a, enabled: false } : a))
    const result = normalizeDegradationChain(['a1', 'a2', 'a3'], agents)
    expect(result).toEqual(['a1', 'a3'])
  })
})

/**
 * Persist a set of agents (plus the baseline fields) and re-read via loadSettings.
 * Typed `unknown[]` on purpose: these tests deliberately feed legacy-flat /
 * untrusted on-disk shapes through `normalize` (the migration path), so the
 * inputs are NOT yet valid `AgentConfig` discriminated unions.
 */
function saveAgents(agents: unknown[], defaultAgentId = SYSTEM_AGENT_ID): SystemSettings {
  return saveSettings({ agents, defaultAgentId } as unknown as SystemSettings)
}

/** A system-mode claude agent record (2026-06-06-007): the system agent is no
 *  longer auto-injected, so tests that want one in the table add it explicitly. */
const SYS_RECORD = {
  id: SYSTEM_AGENT_ID,
  vendor: 'claude',
  configMode: 'system',
  displayName: 'System',
  config: { baseUrl: '', apiKey: '', model: '' },
}

describe('enabled flag (AC-R10)', () => {
  it('persists enabled as an explicit boolean; absent ⇒ enabled (back-compat)', () => {
    // No `enabled` field on the incoming agent → treated as enabled and persisted as true.
    const saved = saveAgents([
      { id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '' } as never,
    ])
    const a1 = saved.agents.find((a) => a.id === 'a1')
    expect(a1?.enabled).toBe(true)
  })

  it('keeps an explicit false (disabled) through normalize', () => {
    const saved = saveAgents([
      { id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '', enabled: false },
    ])
    expect(saved.agents.find((a) => a.id === 'a1')?.enabled).toBe(false)
  })

  it('an agent with the legacy system id is editable like any other (AC-R1 retired)', () => {
    // 2026-06-06-007: the undeletable, override-ignoring system singleton is gone.
    // An agent that carries the legacy `system` id is now a normal agent — its
    // provider overrides are kept (a non-empty baseUrl ⇒ configMode `custom`).
    const saved = saveAgents([
      {
        id: SYSTEM_AGENT_ID,
        name: 'edited',
        baseUrl: 'https://one',
        apiKey: 'k',
        model: 'm',
        enabled: false,
      },
    ])
    const sys = saved.agents.find((a) => a.id === SYSTEM_AGENT_ID)!
    expect(sys.enabled).toBe(false)
    expect(sys.configMode).toBe('custom')
    expect(sys.config.baseUrl).toBe('https://one')
    expect(sys.config.apiKey).toBe('k')
    expect(sys.config.model).toBe('m')
  })

  it('enabledAgents() returns only enabled agents', () => {
    saveAgents([
      { id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '', enabled: true },
      { id: 'a2', name: 'Two', baseUrl: '', apiKey: '', model: '', enabled: false },
    ])
    const ids = enabledAgents().map((a) => a.id)
    expect(ids).toContain('a1')
    expect(ids).not.toContain('a2')
  })

  it('enabledAgents() excludes a disabled system agent', () => {
    saveAgents([
      { id: SYSTEM_AGENT_ID, name: 'System', baseUrl: '', apiKey: '', model: '', enabled: false },
    ])
    expect(enabledAgents().some((a) => a.id === SYSTEM_AGENT_ID)).toBe(false)
  })

  it('consensusVoters drops disabled agents and the session self', () => {
    saveAgents([
      { id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '', enabled: true },
      { id: 'a2', name: 'Two', baseUrl: '', apiKey: '', model: '', enabled: false },
    ])
    const voters = consensusVoters('a1').map((a) => a.id)
    expect(voters).not.toContain('a1') // self excluded
    expect(voters).not.toContain('a2') // disabled excluded
  })

  it('vendorScopedVoters keeps only same-vendor agents and counts the cross-vendor exclusions', () => {
    // A heterogeneous table: the session runs a claude agent; an opencode agent
    // and a claude (system-mode) agent are also enabled.
    saveAgents([
      SYS_RECORD,
      {
        id: 'a1',
        vendor: 'claude',
        configMode: 'custom',
        displayName: 'One',
        config: { baseUrl: '', apiKey: '', model: '' },
      },
      {
        id: 'oc',
        vendor: 'opencode',
        configMode: 'custom',
        displayName: 'OC',
        config: { baseUrl: '', apiKey: '', model: '' },
      },
    ])
    const { voters, vendorScope, crossVendorExcluded } = vendorScopedVoters('a1')
    const ids = voters.map((a) => a.id)
    expect(vendorScope).toBe('claude')
    expect(ids).toContain(SYSTEM_AGENT_ID) // same-vendor claude voter kept
    expect(ids).not.toContain('a1') // self excluded
    expect(ids).not.toContain('oc') // cross-vendor (opencode) excluded
    expect(crossVendorExcluded).toBe(1) // the one opencode agent
  })

  it('vendorScopedVoters yields zero voters when the session vendor is the only one present', () => {
    // Session runs the lone opencode agent; the only other enabled agent is a
    // different vendor (claude system-mode) → no same-vendor voter → consensus skipped.
    const saved = saveAgents([
      SYS_RECORD,
      {
        id: 'oc',
        vendor: 'opencode',
        configMode: 'custom',
        displayName: 'OC',
        config: { baseUrl: '', apiKey: '', model: '' },
      },
    ])
    expect(saved.agents.find((a) => a.id === 'oc')?.vendor).toBe('opencode')
    const { voters, vendorScope, crossVendorExcluded } = vendorScopedVoters('oc')
    expect(vendorScope).toBe('opencode')
    expect(voters).toHaveLength(0)
    expect(crossVendorExcluded).toBe(1) // the claude system agent
  })

  it('still launches a session bound to a disabled agent (no lock-out — AC-R10)', () => {
    const settings = saveAgents([
      { id: 'a1', name: 'One', baseUrl: 'https://one', apiKey: 'k', model: '', enabled: false },
    ])
    // Sanity: a1 is disabled yet present.
    expect(settings.agents.find((a) => a.id === 'a1')?.enabled).toBe(false)
    // No binding for this session → falls back to the default. The system agent is
    // no longer auto-injected, so with `a1` the only agent it becomes the default
    // (2026-06-06-007); the launch still resolves — a disabled agent never locks out.
    const launch = resolveSessionLaunch('some-session')
    expect(launch.agentId).toBe('a1')
    // loadSettings is consistent with the saved set.
    expect(loadSettings().agents.some((a) => a.id === 'a1')).toBe(true)
  })
})

/** Persist just a `maxSpeechChars` value (with the required baseline fields). */
function saveWithMaxSpeechChars(value: unknown): void {
  saveWorkspaceSetting(TEST_PROJ, { maxSpeechChars: value } as unknown as WorkspaceSetting)
}

describe('getMaxSpeechChars normalization', () => {
  it('falls back to the default when unset', () => {
    saveWithMaxSpeechChars(undefined)
    expect(getMaxSpeechChars(TEST_PROJ)).toBe(DEFAULT_SPEECH_CHARS)
  })

  it('clamps a positive value below the floor up to the minimum', () => {
    saveWithMaxSpeechChars(100)
    expect(getMaxSpeechChars(TEST_PROJ)).toBe(MIN_SPEECH_CHARS)
  })

  it('clamps the floor exactly to the minimum', () => {
    saveWithMaxSpeechChars(MIN_SPEECH_CHARS)
    expect(getMaxSpeechChars(TEST_PROJ)).toBe(MIN_SPEECH_CHARS)
  })

  it('keeps a legal value at or above the floor', () => {
    saveWithMaxSpeechChars(500)
    expect(getMaxSpeechChars(TEST_PROJ)).toBe(500)
  })

  it('floors a fractional value', () => {
    saveWithMaxSpeechChars(450.7)
    expect(getMaxSpeechChars(TEST_PROJ)).toBe(450)
  })

  it('falls back to the default for a non-numeric value', () => {
    saveWithMaxSpeechChars('nope')
    expect(getMaxSpeechChars(TEST_PROJ)).toBe(DEFAULT_SPEECH_CHARS)
  })

  it('falls back to the default for zero/negative values', () => {
    saveWithMaxSpeechChars(0)
    expect(getMaxSpeechChars(TEST_PROJ)).toBe(DEFAULT_SPEECH_CHARS)
    saveWithMaxSpeechChars(-3)
    expect(getMaxSpeechChars(TEST_PROJ)).toBe(DEFAULT_SPEECH_CHARS)
  })
})

/**
 * Persist global-level settings with `skillRepos` on the SystemSettings object,
 * simulating an old settings.json on disk (one-shot migration).
 */
function saveWithLegacySkillRepos(repos: unknown): void {
  saveSettings({
    agents: [],
    defaultAgentId: SYSTEM_AGENT_ID,
    skillRepos: repos,
  } as unknown as SystemSettings)
}

describe('skillRepos migration from SystemSettings to WorkspaceSetting', () => {
  const REPO_A = {
    id: 'my-skills',
    repo: 'https://github.com/o/r',
    ref: 'main',
  }
  const REPO_B = {
    id: 'custom',
    repo: 'https://git.example.com/skills.git',
    ref: 'v1',
  }
  const REPO_C = {
    id: 'proj-a',
    repo: 'https://git.example.com/a.git',
    ref: 'main',
  }
  const REPO_D = {
    id: 'proj-b',
    repo: 'https://git.example.com/b.git',
    ref: 'dev',
  }

  it('captures legacy global skillRepos into the project seed (one-shot)', () => {
    const repos = [REPO_A]
    // Save the global settings with skillRepos (old-style), triggering
    // normalize → captureLegacyProjectSeed.
    saveWithLegacySkillRepos(repos)
    // The global settings should NOT carry skillRepos (deprecated, stripped on save).
    expect(loadSettings().skillRepos).toBeUndefined()
    // Loading a project config for the first time should seed it from the legacy value.
    const cfg = loadWorkspaceSetting(TEST_PROJ)
    expect(cfg.skillRepos).toEqual(repos)
    // getSkillRepos(workspacePath) should read from the project config.
    expect(getSkillRepos(TEST_PROJ)).toEqual(repos)
  })

  it('does not seed skillRepos when the legacy settings carry none', () => {
    saveWithLegacySkillRepos(undefined)
    const cfg = loadWorkspaceSetting('/other/project')
    expect(cfg.skillRepos).toBeUndefined()
  })

  it('survives a normal saveWorkspaceSetting round-trip', () => {
    const saved = saveWorkspaceSetting(TEST_PROJ, {
      skillRepos: [REPO_B],
    } as unknown as WorkspaceSetting)
    expect(saved.skillRepos).toEqual([REPO_B])
    expect(getSkillRepos(TEST_PROJ)).toEqual([REPO_B])
  })

  it('is independent between projects (per-project skillRepos)', () => {
    saveWorkspaceSetting('/project/a', { skillRepos: [REPO_C] } as unknown as WorkspaceSetting)
    saveWorkspaceSetting('/project/b', { skillRepos: [REPO_D] } as unknown as WorkspaceSetting)
    expect(getSkillRepos('/project/a')).toEqual([REPO_C])
    expect(getSkillRepos('/project/b')).toEqual([REPO_D])
  })
})

/** Persist just a `uiLang` value (with the required baseline fields). */
function saveWithUiLang(uiLang: unknown): void {
  saveSettings({ agents: [], defaultAgentId: SYSTEM_AGENT_ID, uiLang } as SystemSettings)
}

describe('getUiLang normalization', () => {
  it('defaults to en when unset', () => {
    saveWithUiLang(undefined)
    expect(getUiLang()).toBe(DEFAULT_UI_LANG)
    expect(getUiLang()).toBe('en')
  })

  it('keeps a known language code', () => {
    saveWithUiLang('zh')
    expect(getUiLang()).toBe('zh')
  })

  it('falls back to en for an unknown code', () => {
    saveWithUiLang('xx')
    expect(getUiLang()).toBe('en')
  })

  it('falls back to en for a non-string value', () => {
    saveWithUiLang(42)
    expect(getUiLang()).toBe('en')
  })

  it('is independent from voiceLang (decoupled)', () => {
    saveSettings({
      agents: [],
      defaultAgentId: SYSTEM_AGENT_ID,
      uiLang: 'zh',
      voiceLang: 'en-US',
    } as SystemSettings)
    expect(getUiLang()).toBe('zh')
    expect(loadSettings().voiceLang).toBe('en-US')
  })
})

describe('getUiLangName', () => {
  it('returns the name (with native endonym) of the current uiLang', () => {
    saveWithUiLang('zh')
    expect(getUiLangName()).toBe('Chinese (简体中文)')
  })

  it('covers all five known languages', () => {
    const expected: Record<string, string> = {
      en: 'English',
      zh: 'Chinese (简体中文)',
      ja: 'Japanese (日本語)',
      ko: 'Korean (한국어)',
      ru: 'Russian (Русский)',
    }
    for (const [lang, name] of Object.entries(expected)) {
      saveWithUiLang(lang)
      expect(getUiLangName()).toBe(name)
      expect(UI_LANG_NAMES[lang as keyof typeof UI_LANG_NAMES]).toBe(name)
    }
  })

  it('falls back to the en name when uiLang is unset', () => {
    saveWithUiLang(undefined)
    expect(getUiLangName()).toBe('English')
  })
})

/** Persist just a `timezone` value (with the required baseline fields). */
function saveWithTimezone(timezone: unknown): void {
  saveSettings({ agents: [], defaultAgentId: SYSTEM_AGENT_ID, timezone } as SystemSettings)
}

describe('isValidTimeZone', () => {
  it('accepts well-known IANA zone names', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true)
    expect(isValidTimeZone('America/New_York')).toBe(true)
    expect(isValidTimeZone('UTC')).toBe(true)
  })

  it('rejects unknown / non-string / empty values', () => {
    expect(isValidTimeZone('Not/AZone')).toBe(false)
    expect(isValidTimeZone('')).toBe(false)
    expect(isValidTimeZone('   ')).toBe(false)
    expect(isValidTimeZone(42)).toBe(false)
    expect(isValidTimeZone(undefined)).toBe(false)
  })
})

describe('getTimezone normalization', () => {
  it('defaults to the server local zone when unset', () => {
    saveWithTimezone(undefined)
    expect(getTimezone()).toBe(getServerTimezone())
  })

  it('keeps a valid IANA zone', () => {
    saveWithTimezone('Asia/Shanghai')
    expect(getTimezone()).toBe('Asia/Shanghai')
    expect(loadSettings().timezone).toBe('Asia/Shanghai')
  })

  it('falls back to the server local zone for an invalid value', () => {
    saveWithTimezone('Not/AZone')
    expect(getTimezone()).toBe(getServerTimezone())
    // Persisted value is the normalized (valid) zone, not the bogus input.
    expect(loadSettings().timezone).toBe(getServerTimezone())
  })

  it('falls back to the server local zone for a non-string value', () => {
    saveWithTimezone(123)
    expect(getTimezone()).toBe(getServerTimezone())
  })
})

describe('normalizeIcon (AC-R11)', () => {
  it('returns "" for missing / non-string input', () => {
    expect(normalizeIcon(undefined)).toBe('')
    expect(normalizeIcon(null)).toBe('')
    expect(normalizeIcon(42)).toBe('')
    expect(normalizeIcon({})).toBe('')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeIcon('  🤖  ')).toBe('🤖')
  })

  it('returns "" for whitespace-only input', () => {
    expect(normalizeIcon('   ')).toBe('')
    expect(normalizeIcon('\t\n')).toBe('')
  })

  it('keeps a short emoji or text verbatim', () => {
    expect(normalizeIcon('🤖')).toBe('🤖')
    expect(normalizeIcon('fox')).toBe('fox')
  })

  it('truncates a string longer than AGENT_ICON_MAX_CHARS', () => {
    const long = 'a'.repeat(AGENT_ICON_MAX_CHARS + 5)
    const out = normalizeIcon(long)
    expect(out).toBe('a'.repeat(AGENT_ICON_MAX_CHARS))
    expect(out.length).toBe(AGENT_ICON_MAX_CHARS)
  })
})

describe('AgentConfig.icon persistence (AC-R11)', () => {
  it('persists a valid icon on a non-system agent', () => {
    const saved = saveAgents([
      { id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '', icon: '🤖' } as never,
    ])
    expect(saved.agents.find((a) => a.id === 'a1')?.icon).toBe('🤖')
  })

  it('defaults icon to "" when the incoming agent has no `icon` field (back-compat)', () => {
    // No `icon` field on the incoming agent → treated as empty.
    const saved = saveAgents([
      { id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '' } as never,
    ])
    expect(saved.agents.find((a) => a.id === 'a1')?.icon).toBe('')
  })

  it('loads an old config (no icon field) without error and yields ""', () => {
    // Simulate a legacy on-disk shape: no icon at all.
    saveSettings({
      agents: [{ id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '' }],
      defaultAgentId: 'a1',
    } as unknown as SystemSettings)
    const reloaded = loadSettings()
    expect(reloaded.agents.find((a) => a.id === 'a1')?.icon).toBe('')
  })

  it('honours an icon on an agent carrying the legacy system id (AC-R1 retired)', () => {
    // 2026-06-06-007: the system id is no longer special — both the icon and the
    // provider overrides are kept (non-empty baseUrl ⇒ configMode `custom`).
    const saved = saveAgents([
      {
        id: SYSTEM_AGENT_ID,
        name: 'edited',
        baseUrl: 'https://one',
        apiKey: 'k',
        model: 'm',
        icon: '🛡️',
      },
    ])
    const sys = saved.agents.find((a) => a.id === SYSTEM_AGENT_ID)!
    expect(sys.icon).toBe('🛡️')
    expect(sys.configMode).toBe('custom')
    expect(sys.config.baseUrl).toBe('https://one')
  })

  it('truncates an over-long icon on save', () => {
    const tooLong = '🦊'.repeat(20) // well over AGENT_ICON_MAX_CHARS
    const saved = saveAgents([
      { id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '', icon: tooLong } as never,
    ])
    const out = saved.agents.find((a) => a.id === 'a1')?.icon ?? ''
    expect(out.length).toBe(AGENT_ICON_MAX_CHARS)
  })

  it('persists a system-agent icon across load (system agent can have one too)', () => {
    saveSettings({
      agents: [
        { id: SYSTEM_AGENT_ID, name: 'System', baseUrl: '', apiKey: '', model: '', icon: '⚙️' },
      ],
      defaultAgentId: SYSTEM_AGENT_ID,
    } as unknown as SystemSettings)
    const sys = loadSettings().agents.find((a) => a.id === SYSTEM_AGENT_ID)!
    expect(sys.icon).toBe('⚙️')
  })
})

describe('vendor discriminated-union migration (legacy-flat → claude)', () => {
  it('migrates a legacy-flat agent into the claude arm (name→displayName, fields→config)', () => {
    const saved = saveAgents([
      { id: 'a1', name: 'One', baseUrl: 'https://one', apiKey: 'k1', model: 'm1' },
    ])
    const a1 = saved.agents.find((a) => a.id === 'a1')!
    expect(a1.vendor).toBe('claude')
    expect(a1.displayName).toBe('One')
    expect(a1.config).toEqual({ baseUrl: 'https://one', apiKey: 'k1', model: 'm1' })
    // The flat fields do not survive at the top level.
    expect((a1 as unknown as Record<string, unknown>).baseUrl).toBeUndefined()
    expect((a1 as unknown as Record<string, unknown>).name).toBeUndefined()
  })

  it('re-injects the system agent as a claude agent with an empty (default) config', () => {
    const saved = saveAgents([])
    const sys = saved.agents.find((a) => a.id === SYSTEM_AGENT_ID)!
    expect(sys.vendor).toBe('claude')
    expect(sys.config).toEqual({ baseUrl: '', apiKey: '', model: '' })
  })

  it('keeps a new-shape claude agent through normalize (no double-wrap)', () => {
    const saved = saveAgents([
      {
        id: 'a1',
        vendor: 'claude',
        displayName: 'One',
        config: { baseUrl: 'https://one', apiKey: 'k', model: '' },
      },
    ])
    const a1 = saved.agents.find((a) => a.id === 'a1')!
    expect(a1.config).toEqual({ baseUrl: 'https://one', apiKey: 'k', model: '' })
    expect(a1.displayName).toBe('One')
  })

  it('drops an agent whose vendor has no registered schema (codex/opencode have no adapter yet)', () => {
    const saved = saveAgents([
      { id: 'cx', vendor: 'codex', displayName: 'Codex', config: { foo: 'bar' } },
      { id: 'a1', name: 'One', baseUrl: '', apiKey: '', model: '' },
    ])
    expect(saved.agents.find((a) => a.id === 'cx')).toBeUndefined()
    // The valid legacy-flat sibling still survives.
    expect(saved.agents.find((a) => a.id === 'a1')).toBeTruthy()
  })

  it('round-trips a legacy-flat on-disk shape through load without error', () => {
    saveSettings({
      agents: [{ id: 'a1', name: 'One', baseUrl: 'https://one', apiKey: 'k', model: '' }],
      defaultAgentId: 'a1',
    } as unknown as SystemSettings)
    resetSettingsCacheForTests()
    const a1 = loadSettings().agents.find((a) => a.id === 'a1')!
    expect(a1.vendor).toBe('claude')
    expect(a1.config.baseUrl).toBe('https://one')
  })
})

describe('Claude launch non-regression (AC-R4/R5)', () => {
  it('the system agent yields no overrides (empty config ⇒ {})', () => {
    const sys = loadSettings().agents.find((a) => a.id === SYSTEM_AGENT_ID)!
    expect(launchForAgent(sys)).toEqual({})
  })

  it('a migrated non-system claude agent maps config → env + model + thinking workaround', () => {
    const saved = saveAgents([
      { id: 'a1', name: 'One', baseUrl: 'https://one', apiKey: 'k', model: 'm1' },
    ])
    const a1 = saved.agents.find((a) => a.id === 'a1')!
    expect(launchForAgent(a1)).toEqual({
      envOverrides: {
        ANTHROPIC_BASE_URL: 'https://one',
        ANTHROPIC_API_KEY: 'k',
        ANTHROPIC_AUTH_TOKEN: 'k',
        CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
      },
      model: 'm1',
    })
  })
})

describe('gitBranchMode + defaultMainBranch (2026-06-10)', () => {
  it('defaults to current-branch when absent (backward compatible)', () => {
    saveWorkspaceSetting(TEST_PROJ, {} as WorkspaceSetting)
    expect(getGitBranchMode(TEST_PROJ)).toBe('current-branch')
    expect(getDefaultMainBranch(TEST_PROJ)).toBeUndefined()
  })

  it('normalize emits gitBranchMode even on an empty config', () => {
    saveWorkspaceSetting(TEST_PROJ, {} as WorkspaceSetting)
    expect(loadWorkspaceSetting(TEST_PROJ).gitBranchMode).toBe('current-branch')
  })

  it('persists and reads back worktree mode + a default main branch', () => {
    saveWorkspaceSetting(TEST_PROJ, {
      gitBranchMode: 'worktree',
      defaultMainBranch: 'develop',
    } as WorkspaceSetting)
    expect(getGitBranchMode(TEST_PROJ)).toBe('worktree')
    expect(getDefaultMainBranch(TEST_PROJ)).toBe('develop')
  })

  it('falls back to current-branch for an unknown mode value', () => {
    saveWorkspaceSetting(TEST_PROJ, {
      gitBranchMode: 'bogus',
    } as unknown as WorkspaceSetting)
    expect(getGitBranchMode(TEST_PROJ)).toBe('current-branch')
  })

  it('trims a blank default main branch to undefined', () => {
    saveWorkspaceSetting(TEST_PROJ, {
      gitBranchMode: 'worktree',
      defaultMainBranch: '   ',
    } as WorkspaceSetting)
    expect(getDefaultMainBranch(TEST_PROJ)).toBeUndefined()
  })

  it('reads the legacy on-disk key `gitCommitMode` when the new key is absent', () => {
    // Simulate a pre-rename settings.json: only the legacy `gitCommitMode` key is
    // persisted (no `gitBranchMode`). Write it straight to disk to bypass the
    // normalize-on-save path, then prove load falls back to the legacy key.
    const disk = readJsonFile<SystemSettings>(settingsPath()) ?? ({} as SystemSettings)
    writeAtomic(settingsPath(), {
      ...disk,
      projectConfigs: {
        ...disk.projectConfigs,
        [TEST_PROJ]: { gitCommitMode: 'worktree' } as unknown as WorkspaceSetting,
      },
    })
    expect(getGitBranchMode(TEST_PROJ)).toBe('worktree')
    expect(loadWorkspaceSetting(TEST_PROJ).gitBranchMode).toBe('worktree')
  })

  it('prefers the new key `gitBranchMode` over the legacy `gitCommitMode` on disk', () => {
    const disk = readJsonFile<SystemSettings>(settingsPath()) ?? ({} as SystemSettings)
    writeAtomic(settingsPath(), {
      ...disk,
      projectConfigs: {
        ...disk.projectConfigs,
        [TEST_PROJ]: {
          gitBranchMode: 'current-branch',
          gitCommitMode: 'worktree',
        } as unknown as WorkspaceSetting,
      },
    })
    expect(getGitBranchMode(TEST_PROJ)).toBe('current-branch')
  })
})

describe('agent order_seq — user-controlled global order (normalize + enabledAgents)', () => {
  /** A minimal claude agent; `order_seq`/`enabled` are spread in only when given so
   *  the "missing field" back-compat path is exercised verbatim. */
  function ag(
    id: string,
    opts: { order_seq?: number; enabled?: boolean } = {},
  ): Record<string, unknown> {
    return {
      id,
      vendor: 'claude',
      configMode: 'system',
      displayName: id,
      config: { baseUrl: '', apiKey: '', model: '' },
      ...(opts.order_seq !== undefined ? { order_seq: opts.order_seq } : {}),
      ...(opts.enabled !== undefined ? { enabled: opts.enabled } : {}),
    }
  }

  function saveAgents(agents: Record<string, unknown>[], defaultAgentId: string): void {
    saveSettings({ agents, defaultAgentId } as unknown as SystemSettings)
  }

  it('backfills a missing order_seq by array order into a dense 0..n sequence', () => {
    saveAgents([ag('x'), ag('y'), ag('z')], 'x')
    expect(loadSettings().agents.map((a) => [a.id, a.order_seq])).toEqual([
      ['x', 0],
      ['y', 1],
      ['z', 2],
    ])
  })

  it('sorts by explicit order_seq, breaks duplicate positions stably, regularizes to 0..n', () => {
    // y and z both claim position 2 → stable tie-break by array order (y before z);
    // x at 5 lands last; the final order_seq is reassigned densely.
    saveAgents(
      [ag('x', { order_seq: 5 }), ag('y', { order_seq: 2 }), ag('z', { order_seq: 2 })],
      'x',
    )
    expect(loadSettings().agents.map((a) => a.id)).toEqual(['y', 'z', 'x'])
    expect(loadSettings().agents.map((a) => a.order_seq)).toEqual([0, 1, 2])
  })

  it('appends agents missing order_seq at the tail, after the explicitly-ordered ones', () => {
    saveAgents([ag('a', { order_seq: 1 }), ag('b'), ag('c', { order_seq: 0 })], 'a')
    expect(loadSettings().agents.map((a) => a.id)).toEqual(['c', 'a', 'b'])
  })

  it('pins the system agent to the front regardless of its order_seq', () => {
    saveAgents([ag('x', { order_seq: 0 }), ag(SYSTEM_AGENT_ID, { order_seq: 9 })], 'x')
    const ids = loadSettings().agents.map((a) => a.id)
    expect(ids).toEqual([SYSTEM_AGENT_ID, 'x'])
    expect(loadSettings().agents[0].order_seq).toBe(0)
  })

  it('enabledAgents() returns the order_seq order and excludes disabled agents', () => {
    saveAgents(
      [
        ag('x', { order_seq: 2 }),
        ag('y', { order_seq: 0, enabled: false }),
        ag('z', { order_seq: 1 }),
      ],
      'x',
    )
    expect(enabledAgents().map((a) => a.id)).toEqual(['z', 'x'])
  })
})
