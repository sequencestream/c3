import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsPanel from './SettingsPanel.vue'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { SystemSettings } from '@ccc/shared/protocol'

const baseSettings: SystemSettings = {
  agents: [
    {
      id: SYSTEM_AGENT_ID,
      vendor: 'claude',
      configMode: 'system',
      displayName: 'System',
      config: { baseUrl: '', apiKey: '', model: '' },
    },
  ],
  defaultAgentId: SYSTEM_AGENT_ID,
  toolAgentId: '',
  intentAgentId: '',
  defaultMode: 'default',
  consensus: { enabled: false },
  voiceLang: 'zh-CN',
  uiLang: 'zh',
  showToolSessions: false,
  devSkill: '',
  maxRoundsPerStage: 14,
  maxSpeechChars: 400,
}

describe('SettingsPanel.vue — agent enable/disable', () => {
  const twoAgents: SystemSettings = {
    ...baseSettings,
    agents: [
      {
        id: SYSTEM_AGENT_ID,
        vendor: 'claude',
        configMode: 'system',
        displayName: 'System',
        config: { baseUrl: '', apiKey: '', model: '' },
      },
      {
        id: 'a1',
        vendor: 'claude',
        configMode: 'custom',
        displayName: 'One',
        enabled: true,
        config: { baseUrl: 'https://one', apiKey: 'k', model: '' },
      },
      {
        id: 'a2',
        vendor: 'claude',
        configMode: 'custom',
        displayName: 'Two',
        enabled: false,
        config: { baseUrl: 'https://two', apiKey: 'k', model: '' },
      },
    ],
  }

  it('renders an accessible switch per agent row, reflecting enabled state', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: twoAgents } })
    const switches = w.findAll('[data-testid="agent-enabled-switch"]')
    expect(switches).toHaveLength(3)
    expect(switches.every((s) => s.attributes('role') === 'switch')).toBe(true)
    // System + a1 enabled (absent/true), a2 disabled.
    expect((switches[0].element as HTMLInputElement).checked).toBe(true)
    expect(switches[0].attributes('aria-checked')).toBe('true')
    expect((switches[1].element as HTMLInputElement).checked).toBe(true)
    expect(switches[1].attributes('aria-checked')).toBe('true')
    expect((switches[2].element as HTMLInputElement).checked).toBe(false)
    expect(switches[2].attributes('aria-checked')).toBe('false')
    expect(switches[0].attributes('title')).toBe('Enable / disable this agent')
  })

  it('offers only enabled agents in the default-agent dropdown (no per-row radio)', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: twoAgents } })
    // The per-row radio is gone; a single dropdown below the list replaces it.
    expect(w.findAll('.col-default input[type="radio"]')).toHaveLength(0)
    const opts = w
      .findAll('[data-testid="default-agent-select"] option')
      .map((o) => (o.element as HTMLOptionElement).value)
    // system + a1 enabled; a2 (disabled) excluded.
    expect(opts).toEqual([SYSTEM_AGENT_ID, 'a1'])
  })

  it('emits the toggled enabled value on save', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: twoAgents } })
    const switches = w.findAll('[data-testid="agent-enabled-switch"]')
    await switches[1].setValue(false) // disable a1
    expect(switches[1].attributes('aria-checked')).toBe('false')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].agents.find((a) => a.id === 'a1')?.enabled).toBe(false)
  })

  it('new agents default to enabled', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const addBtn = w.find('[data-testid="settings-add-agent"]')
    expect(addBtn.exists()).toBe(true)
    await addBtn.trigger('click')
    const checks = w.findAll('[data-testid="agent-enabled-switch"]')
    // System row + the freshly added one, both checked.
    expect((checks[checks.length - 1].element as HTMLInputElement).checked).toBe(true)
  })
})

describe('SettingsPanel.vue — default-agent dropdown + fall-through (2026-06-15-001)', () => {
  const mk = (id: string, enabled?: boolean): SystemSettings['agents'][number] => ({
    id,
    vendor: 'claude',
    configMode: 'custom',
    displayName: id,
    ...(enabled === undefined ? {} : { enabled }),
    config: { baseUrl: `https://${id}`, apiKey: 'k', model: '' },
  })
  const threeAgents: SystemSettings = {
    ...baseSettings,
    agents: [mk('a1'), mk('a2'), mk('a3')],
    defaultAgentId: 'a2',
  }

  it('seeds the dropdown from settings.defaultAgentId', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: threeAgents } })
    const sel = w.find('[data-testid="default-agent-select"]')
    expect((sel.element as HTMLSelectElement).value).toBe('a2')
  })

  it('rewrites the default to the next enabled agent when the current default is disabled', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: threeAgents } })
    // Disable a2 (the current default) via its enabled switch (2nd row).
    const checks = w.findAll('[data-testid="agent-enabled-switch"]')
    await checks[1].setValue(false)
    const sel = w.find('[data-testid="default-agent-select"]')
    expect((sel.element as HTMLSelectElement).value).toBe('a3')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].defaultAgentId).toBe('a3')
  })

  it('falls back to SYSTEM_AGENT_ID when every agent is disabled', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: threeAgents } })
    const checks = w.findAll('[data-testid="agent-enabled-switch"]')
    await checks[0].setValue(false)
    await checks[1].setValue(false)
    await checks[2].setValue(false)
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].defaultAgentId).toBe(SYSTEM_AGENT_ID)
  })
})

describe('SettingsPanel.vue — intent-agent dropdown + fall-through (AC-R23)', () => {
  const mk = (id: string, enabled?: boolean): SystemSettings['agents'][number] => ({
    id,
    vendor: 'claude',
    configMode: 'custom',
    displayName: id,
    ...(enabled === undefined ? {} : { enabled }),
    config: { baseUrl: `https://${id}`, apiKey: 'k', model: '' },
  })
  const threeAgents: SystemSettings = {
    ...baseSettings,
    agents: [mk('a1'), mk('a2'), mk('a3')],
    defaultAgentId: 'a1',
  }

  it('offers a leading "follow default" option plus enabled agents by order', () => {
    const w = mount(SettingsPanel, {
      props: {
        open: true,
        settings: { ...threeAgents, agents: [mk('a1'), mk('a2', false), mk('a3')] },
      },
    })
    const opts = w
      .findAll('[data-testid="intent-agent-select"] option')
      .map((o) => (o.element as HTMLOptionElement).value)
    // '' (follow default) + a1 + a3; a2 (disabled) excluded.
    expect(opts).toEqual(['', 'a1', 'a3'])
  })

  it('seeds the dropdown from settings.intentAgentId and carries it through on save', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...threeAgents, intentAgentId: 'a2' } },
    })
    const sel = w.find('[data-testid="intent-agent-select"]')
    expect((sel.element as HTMLSelectElement).value).toBe('a2')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].intentAgentId).toBe('a2')
  })

  it('keeps an empty intentAgentId empty (follow default) when an agent is disabled', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...threeAgents, intentAgentId: '' } },
    })
    // Disable a2 — an empty ("follow default") intent agent must stay empty.
    const checks = w.findAll('[data-testid="agent-enabled-switch"]')
    await checks[1].setValue(false)
    const sel = w.find('[data-testid="intent-agent-select"]')
    expect((sel.element as HTMLSelectElement).value).toBe('')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].intentAgentId).toBe('')
  })

  it('rewrites a non-empty intentAgentId to the next enabled agent when disabled', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...threeAgents, intentAgentId: 'a2' } },
    })
    // Disable a2 (the current intent agent) → fall through to a3.
    const checks = w.findAll('[data-testid="agent-enabled-switch"]')
    await checks[1].setValue(false)
    const sel = w.find('[data-testid="intent-agent-select"]')
    expect((sel.element as HTMLSelectElement).value).toBe('a3')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].intentAgentId).toBe('a3')
  })
})

describe('SettingsPanel.vue — UI display language', () => {
  it('seeds the language select from server settings', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const select = w.find('[data-testid="settings-ui-lang"]')
    expect(select.exists()).toBe(true)
    expect((select.element as HTMLSelectElement).value).toBe('zh')
  })

  it('defaults the language select to en when settings omit uiLang', () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...baseSettings, uiLang: undefined } },
    })
    const select = w.find('[data-testid="settings-ui-lang"]')
    expect((select.element as HTMLSelectElement).value).toBe('en')
  })

  it('offers en + zh + ja + ko + ru (all human-reviewed)', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const values = w
      .findAll('[data-testid="settings-ui-lang"] option')
      .map((o) => (o.element as HTMLOptionElement).value)
    expect(values).toEqual(['en', 'zh', 'ja', 'ko', 'ru'])
  })

  it('emits set-ui-lang immediately on select change (no Save needed)', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    await w.find('[data-testid="settings-ui-lang"]').setValue('en')
    const emitted = w.emitted('set-ui-lang') as [string][]
    expect(emitted).toBeTruthy()
    expect(emitted[0][0]).toBe('en')
  })

  it('carries the selected language into the Save payload', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    await w.find('[data-testid="settings-ui-lang"]').setValue('en')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].uiLang).toBe('en')
  })
})

describe('SettingsPanel.vue — agent icon emoji picker', () => {
  const withAgent: SystemSettings = {
    ...baseSettings,
    agents: [
      {
        id: SYSTEM_AGENT_ID,
        vendor: 'claude',
        configMode: 'system',
        displayName: 'System',
        config: { baseUrl: '', apiKey: '', model: '' },
      },
      {
        id: 'a1',
        vendor: 'claude',
        configMode: 'custom',
        displayName: 'One',
        icon: '',
        config: { baseUrl: 'https://one', apiKey: 'k', model: '' },
      },
    ],
  }

  it('renders an emoji-picker trigger per agent row', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withAgent } })
    expect(w.findAll('[data-testid="emoji-picker-trigger"]')).toHaveLength(2)
  })

  it('writes the picked emoji back into a.icon and into the Save payload', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withAgent } })
    // Open the second row's picker (the non-system agent), then pick the first emoji.
    const triggers = w.findAll('[data-testid="emoji-picker-trigger"]')
    await triggers[1].trigger('click')
    const cells = w.findAll('[data-testid="emoji-picker-cell"]')
    expect(cells.length).toBeGreaterThan(0)
    const picked = cells[0].text()
    await cells[0].trigger('click')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].agents.find((a) => a.id === 'a1')?.icon).toBe(picked)
  })
})

describe('SettingsPanel.vue — time zone', () => {
  it('seeds the timezone select from server settings', () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...baseSettings, timezone: 'Asia/Shanghai' } },
    })
    const select = w.find('[data-testid="settings-timezone"]')
    expect(select.exists()).toBe(true)
    expect((select.element as HTMLSelectElement).value).toBe('Asia/Shanghai')
  })

  it('defaults the timezone select to the browser zone when settings omit it', () => {
    const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...baseSettings, timezone: undefined } },
    })
    const select = w.find('[data-testid="settings-timezone"]')
    expect((select.element as HTMLSelectElement).value).toBe(browserTz)
  })

  it('carries the selected timezone into the Save payload', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...baseSettings, timezone: 'Asia/Shanghai' } },
    })
    await w.find('[data-testid="settings-timezone"]').setValue('America/New_York')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].timezone).toBe('America/New_York')
  })
})

describe('SettingsPanel.vue — pass-through fields survive Save (2026-06-08-003)', () => {
  // The panel does not edit these fields, but it MUST carry them into the Save
  // payload — dropping them is the "project config vanishes after restart" bug.
  const withPassthrough: SystemSettings = {
    ...baseSettings,
    degradationChain: ['a1', SYSTEM_AGENT_ID],
    socketAutoResume: false,
    projectConfigs: {
      '/proj/a': { devSkill: '/ship', maxRoundsPerStage: 14, maxSpeechChars: 400 },
      '/proj/b': { consensus: { enabled: true, majority: true } },
    },
  }

  it('Save emits the original projectConfigs / degradationChain / socketAutoResume', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withPassthrough } })
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    const saved = emitted[0][0]
    expect(saved.projectConfigs).toEqual(withPassthrough.projectConfigs)
    expect(saved.degradationChain).toEqual(['a1', SYSTEM_AGENT_ID])
    expect(saved.socketAutoResume).toBe(false)
  })

  it('keeps pass-through fields even when an edited field also changes', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withPassthrough } })
    await w.find('[data-testid="settings-timezone"]').setValue('America/New_York')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.timezone).toBe('America/New_York')
    expect(saved.projectConfigs).toEqual(withPassthrough.projectConfigs)
  })

  it('deep-copies pass-through fields (emitted is a distinct object, not aliased)', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withPassthrough } })
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = (w.emitted('save') as [SystemSettings][])[0][0]
    // Same content, but a fresh copy — edits to the draft never mutate server state.
    expect(emitted.projectConfigs).not.toBe(withPassthrough.projectConfigs)
    expect(emitted.projectConfigs).toEqual(withPassthrough.projectConfigs)
  })
})

describe('SettingsPanel.vue — authentication (ADR-0023)', () => {
  // Settings with a fully-configured basic admin (username + a non-empty hash).
  const withAdmin: SystemSettings = {
    ...baseSettings,
    auth: {
      enabled: false,
      provider: { kind: 'basic', username: 'admin', passwordHash: '$scrypt$ln=15,r=8,p=1$s$h' },
      session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_KEY' },
    },
  }

  it('renders the auth section with basic selectable and oauth/sso greyed out', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const opts = w.findAll('[data-testid="settings-auth-provider"] option')
    expect(opts.map((o) => (o.element as HTMLOptionElement).value)).toEqual([
      'basic',
      'oauth',
      'sso',
    ])
    expect((opts[0].element as HTMLOptionElement).disabled).toBe(false)
    expect((opts[1].element as HTMLOptionElement).disabled).toBe(true)
    expect((opts[2].element as HTMLOptionElement).disabled).toBe(true)
  })

  it('disables the enable + exposure toggles until an admin is configured', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const enable = w.find('[data-testid="settings-auth-enable"]').element as HTMLInputElement
    const exposure = w.find('[data-testid="settings-auth-exposure"]').element as HTMLInputElement
    expect(enable.disabled).toBe(true)
    expect(exposure.disabled).toBe(true)
  })

  it('enables the toggles once an admin (username + stored hash) exists', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withAdmin } })
    const enable = w.find('[data-testid="settings-auth-enable"]').element as HTMLInputElement
    const exposure = w.find('[data-testid="settings-auth-exposure"]').element as HTMLInputElement
    expect(enable.disabled).toBe(false)
    expect(exposure.disabled).toBe(false)
  })

  it('never pre-fills the password input from the stored hash (write-only)', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withAdmin } })
    const newPw = w.find('[data-testid="settings-auth-new-password"]').element as HTMLInputElement
    expect(newPw.value).toBe('')
    expect(newPw.type).toBe('password')
  })

  it('bootstrap: emits set-password without a current password and clears the field', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    await w.find('[data-testid="settings-auth-username"]').setValue('root')
    const newPw = w.find('[data-testid="settings-auth-new-password"]')
    await newPw.setValue('s3cret!')
    await w.find('[data-testid="settings-auth-set-password"]').trigger('click')
    const emitted = w.emitted('set-password') as [
      { username: string; password: string; currentPassword?: string },
    ][]
    expect(emitted[0][0]).toEqual({
      username: 'root',
      password: 's3cret!',
      currentPassword: undefined,
    })
    // Plaintext is wiped from the input after submit.
    expect((newPw.element as HTMLInputElement).value).toBe('')
  })

  it('change: includes the current password once an admin exists', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withAdmin } })
    await w.find('[data-testid="settings-auth-current-password"]').setValue('oldpass')
    await w.find('[data-testid="settings-auth-new-password"]').setValue('newpass1')
    await w.find('[data-testid="settings-auth-set-password"]').trigger('click')
    const emitted = w.emitted('set-password') as [
      { username: string; password: string; currentPassword?: string },
    ][]
    expect(emitted[0][0]).toEqual({
      username: 'admin',
      password: 'newpass1',
      currentPassword: 'oldpass',
    })
  })

  it('carries an edited exposure bindAddress through on save', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withAdmin } })
    await w.find('[data-testid="settings-auth-exposure"]').setValue(true)
    await w.find('[data-testid="settings-save"]').trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.auth?.exposure?.bindAddress).toBe('0.0.0.0')
  })

  it('shows the default 30-day session lifetime when no auth block exists yet', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const ttl = w.find('[data-testid="settings-auth-ttl"]').element as HTMLInputElement
    expect(ttl.value).toBe('30')
  })

  it('carries an edited session lifetime (days → seconds) through on save', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withAdmin } })
    await w.find('[data-testid="settings-auth-ttl"]').setValue('45')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.auth?.session.ttlSeconds).toBe(45 * 24 * 60 * 60)
  })
})

describe('SettingsPanel.vue — host-CLI diagnostics (ADR-0012)', () => {
  const hostStatus = [
    {
      vendor: 'claude' as const,
      present: true,
      binary: 'claude',
      path: '/usr/local/bin/claude',
      installHint: '',
    },
    {
      vendor: 'codex' as const,
      present: false,
      binary: 'codex',
      path: null,
      installHint: 'install codex',
    },
  ]

  it('shows the resolved absolute path for an installed binary, none for a missing one', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings, hostStatus } })
    const paths = w.findAll('[data-testid="settings-diagnostics"] .diagnostics-path')
    // Only the present vendor renders a path row.
    expect(paths).toHaveLength(1)
    expect(paths[0].text()).toBe('/usr/local/bin/claude')
  })
})

// Skill-repo tests moved to WorkspaceSetting.test.ts (ADR-0016/0017 migration)

describe('SettingsPanel.vue — drag-to-reorder agents (order_seq)', () => {
  const threeAgents: SystemSettings = {
    ...baseSettings,
    agents: [
      {
        id: SYSTEM_AGENT_ID,
        vendor: 'claude',
        configMode: 'system',
        displayName: 'System',
        config: { baseUrl: '', apiKey: '', model: '' },
      },
      {
        id: 'a1',
        vendor: 'claude',
        configMode: 'custom',
        displayName: 'One',
        enabled: true,
        config: { baseUrl: 'https://one', apiKey: 'k', model: '' },
      },
      {
        id: 'a2',
        vendor: 'claude',
        configMode: 'custom',
        displayName: 'Two',
        enabled: true,
        config: { baseUrl: 'https://two', apiKey: 'k', model: '' },
      },
    ],
  }

  it('dropping a row into a new slot persists the new order + dense order_seq on Save', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: threeAgents } })
    const rows = w.findAll('[data-testid="agent-card"]')
    // Grab the 3rd row (a2) and drop it onto the 1st slot.
    await rows[2].find('[data-testid="agent-drag"]').trigger('dragstart')
    await rows[0].trigger('dragover')
    await rows[0].trigger('drop')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents.map((a) => a.id)).toEqual(['a2', SYSTEM_AGENT_ID, 'a1'])
    expect(saved.agents.map((a) => a.order_seq)).toEqual([0, 1, 2])
  })

  it('Save stamps order_seq from array order even without any drag', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: threeAgents } })
    await w.find('[data-testid="settings-save"]').trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents.map((a) => a.order_seq)).toEqual([0, 1, 2])
  })
})
