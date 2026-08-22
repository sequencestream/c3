import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import type { ClientToServer, McpApiKeyMeta, PersonalizedSettings } from '@ccc/shared/protocol'
import { installSettingsActions } from './settings-actions'
import type { AppCtx } from './types'
import { applyLocale, i18n } from '@/i18n'

// The repository reads `localStorage` off the global; the controls layer runs in the
// Node test env, so install a fake we can also inspect as "what this browser holds".
function installStorage(): Map<string, string> {
  const map = new Map<string, string>()
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => void map.set(k, v),
  }
  return map
}

/** Same for the root element the theme runtime writes (with the font-scale API too). */
function installDocument(): { dataset: Record<string, string>; style: Record<string, string> } {
  const style = Object.assign({} as Record<string, string>, {
    setProperty(this: Record<string, string>, k: string, v: string): void {
      this[k] = v
    },
  })
  const root = { dataset: {} as Record<string, string>, style }
  ;(globalThis as unknown as { document: unknown }).document = { documentElement: root }
  return root
}

/** A minimal key roster entry — this file only cares that the plaintext is dropped. */
function keyMeta(): McpApiKeyMeta {
  return {
    id: 'key-1',
    name: 'laptop',
    createdAt: 1,
    lastUsedAt: null,
    workspaceName: null,
    unavailable: false,
    tools: [],
    displayPrefix: 'c3k_key-1',
  }
}

function makeCtx(opts: { connected?: boolean } = {}) {
  const sent: ClientToServer[] = []
  const showToast = vi.fn()
  const ctx = {
    send: (m: ClientToServer) => sent.push(m),
    client: opts.connected === false ? null : ({} as AppCtx['client']),
    t: (key: string) => key,
    showToast,
    settingsOpen: ref(false),
    personalizedSettingOpen: ref(false),
    myMcpApiKeyCreated: ref<{ meta: McpApiKeyMeta; key: string } | null>(null),
    imIdentityChallengeCreated: ref(null),
    personalizedSettings: ref<PersonalizedSettings>({ uiLang: 'en', theme: 'dark' }),
    workspaceSettingOpen: ref(false),
    currentWorkspace: ref<string | null>(null),
    installingSkillIds: ref<string[]>([]),
    serverSettings: ref(null),
    skillApprovalRequest: ref(null),
    viewMode: ref<'workspace' | 'workcenter'>('workspace'),
    savedTab: ref('intents'),
    activeTab: ref('intents'),
    flags: { viewModeFirstWorkcenter: true, pendingConsoleBind: false },
    workcenterPage: ref<'dashboard' | 'notifications'>('notifications'),
    loadDashboard: vi.fn(),
    reloadWorkcenter: vi.fn(),
    persistViewMode: vi.fn(),
    onSelectTab: vi.fn(),
    loadRobots: vi.fn(),
  } as unknown as AppCtx
  installSettingsActions(ctx)
  return { ctx, sent, showToast }
}

let storage: Map<string, string>
let root: { dataset: Record<string, string>; style: Record<string, string> }

beforeEach(() => {
  storage = installStorage()
  root = installDocument()
  applyLocale('en')
})

afterEach(() => {
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage
  delete (globalThis as unknown as { document?: unknown }).document
  applyLocale('en')
})

describe('fetchPersonalizedSettings', () => {
  it('offers this browser`s recorded language as the account seed', () => {
    storage.set('c3.uiLang', 'zh')
    const { ctx, sent } = makeCtx()
    ctx.fetchPersonalizedSettings()
    expect(sent).toEqual([{ type: 'get_personalized_settings', localFallback: { uiLang: 'zh' } }])
  })

  it('offers a recorded theme as the seed even when no language was ever chosen', () => {
    storage.set('c3.theme', 'light')
    const { ctx, sent } = makeCtx()
    ctx.fetchPersonalizedSettings()
    expect(sent).toEqual([{ type: 'get_personalized_settings', localFallback: { theme: 'light' } }])
  })

  it('omits the seed entirely when this browser has recorded nothing', () => {
    const { ctx, sent } = makeCtx()
    ctx.fetchPersonalizedSettings()
    expect(sent).toEqual([{ type: 'get_personalized_settings' }])
  })

  it('ignores a corrupt stored value rather than seeding an account with it', () => {
    storage.set('c3.uiLang', 'klingon')
    storage.set('c3.theme', 'solarized')
    const { ctx, sent } = makeCtx()
    ctx.fetchPersonalizedSettings()
    expect(sent).toEqual([{ type: 'get_personalized_settings' }])
  })
})

describe('openPersonalizedSetting', () => {
  it('opens the page and refreshes both the preferences and this identity\u2019s key roster', () => {
    const { ctx, sent } = makeCtx()
    ctx.openPersonalizedSetting()
    expect(ctx.personalizedSettingOpen.value).toBe(true)
    expect(sent.map((m) => m.type)).toEqual([
      'get_personalized_settings',
      'list_my_mcp_api_keys',
      'get_my_im_identity',
    ])
  })

  it('drops a still-revealed plaintext key, so opening the page never re-shows one', () => {
    const { ctx } = makeCtx()
    ctx.myMcpApiKeyCreated.value = { meta: keyMeta(), key: 'c3k_x_SECRET' }
    ctx.openPersonalizedSetting()
    expect(ctx.myMcpApiKeyCreated.value).toBeNull()
  })

  it('closing the page also drops the plaintext', () => {
    const { ctx } = makeCtx()
    ctx.personalizedSettingOpen.value = true
    ctx.myMcpApiKeyCreated.value = { meta: keyMeta(), key: 'c3k_x_SECRET' }
    ctx.closePersonalizedSetting()
    expect(ctx.personalizedSettingOpen.value).toBe(false)
    expect(ctx.myMcpApiKeyCreated.value).toBeNull()
  })

  it('does not open the system-settings page (three independent entries)', () => {
    const { ctx } = makeCtx()
    ctx.openPersonalizedSetting()
    expect(ctx.settingsOpen.value).toBe(false)
    expect(ctx.workspaceSettingOpen.value).toBe(false)
  })
})

describe('setLocale', () => {
  it('applies the language, records it in this browser, and saves it for the identity', () => {
    const { ctx, sent } = makeCtx()
    ctx.setLocale('zh')
    expect(i18n.global.locale.value).toBe('zh')
    expect(storage.get('c3.uiLang')).toBe('zh')
    expect(ctx.personalizedSettings.value).toEqual({ uiLang: 'zh', theme: 'dark' })
    // The whole record goes out, so changing the language never drops the theme.
    expect(sent).toEqual([
      { type: 'save_personalized_settings', settings: { uiLang: 'zh', theme: 'dark' } },
    ])
  })

  it('is a no-op when the language is already active', () => {
    const { ctx, sent } = makeCtx()
    ctx.setLocale('en')
    expect(sent).toEqual([])
  })

  it('rolls the UI back and reports the failure when there is no connection', () => {
    const { ctx, sent, showToast } = makeCtx({ connected: false })
    ctx.setLocale('zh')
    expect(i18n.global.locale.value).toBe('en')
    expect(storage.get('c3.uiLang')).toBe('en')
    expect(ctx.personalizedSettings.value).toEqual({ uiLang: 'en', theme: 'dark' })
    expect(sent).toEqual([])
    expect(showToast).toHaveBeenCalledWith('error.personalizedSetting.saveFailed')
  })

  it('never sends a system-settings save (the language left that class)', () => {
    const { ctx, sent } = makeCtx()
    ctx.setLocale('ja')
    expect(sent.some((m) => m.type === 'save_settings')).toBe(false)
  })

  it('leaves the theme alone', () => {
    const { ctx } = makeCtx()
    ctx.setTheme('light')
    ctx.setLocale('zh')
    expect(root.dataset.theme).toBe('light')
    expect(ctx.personalizedSettings.value).toEqual({ uiLang: 'zh', theme: 'light' })
  })
})

describe('setTheme', () => {
  it('applies the theme, records it in this browser, and saves it for the identity', () => {
    const { ctx, sent } = makeCtx()
    ctx.setTheme('light')
    expect(root.dataset.theme).toBe('light')
    expect(root.style.colorScheme).toBe('light')
    expect(storage.get('c3.theme')).toBe('light')
    expect(ctx.personalizedSettings.value).toEqual({ uiLang: 'en', theme: 'light' })
    expect(sent).toEqual([
      { type: 'save_personalized_settings', settings: { uiLang: 'en', theme: 'light' } },
    ])
  })

  it('is a no-op when the theme is already active', () => {
    const { ctx, sent } = makeCtx()
    ctx.setTheme('dark')
    expect(sent).toEqual([])
  })

  it('rolls the theme, the browser record and the snapshot back when there is no connection', () => {
    const { ctx, sent, showToast } = makeCtx({ connected: false })
    ctx.setTheme('light')
    expect(root.dataset.theme).toBe('dark')
    expect(root.style.colorScheme).toBe('dark')
    expect(storage.get('c3.theme')).toBe('dark')
    expect(ctx.personalizedSettings.value).toEqual({ uiLang: 'en', theme: 'dark' })
    expect(sent).toEqual([])
    expect(showToast).toHaveBeenCalledWith('error.personalizedSetting.saveFailed')
  })

  it('leaves the display language alone', () => {
    const { ctx } = makeCtx()
    ctx.setLocale('zh')
    ctx.setTheme('light')
    expect(i18n.global.locale.value).toBe('zh')
    expect(storage.get('c3.uiLang')).toBe('zh')
  })

  it('never sends a system-settings save (the theme is a personal preference)', () => {
    const { ctx, sent } = makeCtx()
    ctx.setTheme('light')
    expect(sent.some((m) => m.type === 'save_settings')).toBe(false)
  })
})

describe('setFontScale', () => {
  it('applies the scale, records it in this browser, and saves it for the identity', () => {
    const { ctx, sent } = makeCtx()
    ctx.setFontScale(115)
    expect(root.style['--c-font-scale']).toBe('1.15')
    expect(storage.get('c3.fontScale')).toBe('115')
    expect(ctx.personalizedSettings.value).toEqual({
      uiLang: 'en',
      theme: 'dark',
      fontScale: 115,
    })
    // The whole record goes out, so changing the scale never drops language/theme.
    expect(sent).toEqual([
      {
        type: 'save_personalized_settings',
        settings: { uiLang: 'en', theme: 'dark', fontScale: 115 },
      },
    ])
  })

  it('is a no-op when the scale is already active', () => {
    const { ctx, sent } = makeCtx()
    ctx.setFontScale(100)
    expect(sent).toEqual([])
  })

  it('rolls the CSS variable, the browser record and the snapshot back on no connection', () => {
    const { ctx, sent, showToast } = makeCtx({ connected: false })
    ctx.setFontScale(110)
    expect(root.style['--c-font-scale']).toBe('1')
    expect(storage.get('c3.fontScale')).toBe('100')
    expect(ctx.personalizedSettings.value).toEqual({ uiLang: 'en', theme: 'dark' })
    expect(sent).toEqual([])
    expect(showToast).toHaveBeenCalledWith('error.personalizedSetting.saveFailed')
  })

  it('leaves the display language and theme alone', () => {
    const { ctx } = makeCtx()
    ctx.setLocale('zh')
    ctx.setTheme('light')
    ctx.setFontScale(85)
    expect(i18n.global.locale.value).toBe('zh')
    expect(root.dataset.theme).toBe('light')
    expect(storage.get('c3.uiLang')).toBe('zh')
    expect(storage.get('c3.theme')).toBe('light')
  })

  it('never sends a system-settings save (the scale is a personal preference)', () => {
    const { ctx, sent } = makeCtx()
    ctx.setFontScale(120)
    expect(sent.some((m) => m.type === 'save_settings')).toBe(false)
  })
})
