import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import SettingsPanel from './SettingsPanel.vue'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { SystemSettings } from '@ccc/shared/protocol'
import { useAuth } from '@/composables/useAuth'

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
  specAgentId: '',
  automationAgentId: '',
  defaultMode: 'default',
  consensus: { enabled: false },
  voiceLang: 'zh-CN',
  uiLang: 'zh',
  showToolSessions: false,
  devSkill: '',
  maxRoundsPerStage: 14,
  maxSpeechChars: 400,
}

describe('SettingsPanel.vue — model input visibility by configMode (2026-07-02-001)', () => {
  const systemClaude: SystemSettings = {
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
        id: 'custom-claude',
        vendor: 'claude',
        configMode: 'custom',
        displayName: 'Custom Claude',
        enabled: true,
        config: { baseUrl: 'https://cust', apiKey: 'k', model: 'm' },
      },
      {
        id: 'system-codex',
        vendor: 'codex',
        configMode: 'system',
        displayName: 'Sys Codex',
        enabled: true,
        config: { baseUrl: '', apiKey: '', model: '', wireApi: 'chat' },
      },
    ],
  }

  it('system-mode claude — model input visible, baseUrl/apiKey hidden', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: systemClaude } })
    const agentRows = w.findAll('[data-testid="agent-card"]')
    // First row is system claude
    const sysRow = agentRows[0]
    expect(sysRow.find('.agent-model').exists()).toBe(true)
    expect(sysRow.find('.agent-url').exists()).toBe(false)
    expect(sysRow.find('.agent-key').exists()).toBe(false)
    // wireApi also hidden for claude
    expect(sysRow.find('.agent-wireapi').exists()).toBe(false)
  })

  it('system-mode codex — model input visible, baseUrl/apiKey/wireApi hidden', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: systemClaude } })
    const agentRows = w.findAll('[data-testid="agent-card"]')
    // Third row is system codex
    const sysRow = agentRows[2]
    expect(sysRow.find('.agent-model').exists()).toBe(true)
    expect(sysRow.find('.agent-url').exists()).toBe(false)
    expect(sysRow.find('.agent-key').exists()).toBe(false)
    expect(sysRow.find('.agent-wireapi').exists()).toBe(false)
  })

  it('custom-mode claude — model, baseUrl, apiKey all visible', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: systemClaude } })
    const agentRows = w.findAll('[data-testid="agent-card"]')
    // Second row is custom claude
    const custRow = agentRows[1]
    expect(custRow.find('.agent-model').exists()).toBe(true)
    expect(custRow.find('.agent-url').exists()).toBe(true)
    expect(custRow.find('.agent-key').exists()).toBe(true)
  })

  it('model input is editable in system mode', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: systemClaude } })
    const modelInput = w.findAll('.agent-model')[0] // first row = system
    await modelInput.setValue('claude-sonnet-5')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    const savedAgent = emitted[0][0].agents.find((a) => a.id === SYSTEM_AGENT_ID)
    expect(savedAgent?.config.model).toBe('claude-sonnet-5')
  })
})

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

  it('seeds the spec dropdown from settings.specAgentId and carries it through on save', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...threeAgents, specAgentId: 'a2' } },
    })
    const sel = w.find('[data-testid="spec-agent-select"]')
    expect((sel.element as HTMLSelectElement).value).toBe('a2')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].specAgentId).toBe('a2')
  })

  it('keeps an empty specAgentId empty (follow default) when an agent is disabled', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...threeAgents, specAgentId: '' } },
    })
    // Disable a2 — an empty ("follow default") spec agent must stay empty.
    const checks = w.findAll('[data-testid="agent-enabled-switch"]')
    await checks[1].setValue(false)
    const sel = w.find('[data-testid="spec-agent-select"]')
    expect((sel.element as HTMLSelectElement).value).toBe('')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].specAgentId).toBe('')
  })

  it('rewrites a non-empty specAgentId to the next enabled agent when disabled', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...threeAgents, specAgentId: 'a2' } },
    })
    // Disable a2 (the current spec agent) → fall through to a3.
    const checks = w.findAll('[data-testid="agent-enabled-switch"]')
    await checks[1].setValue(false)
    const sel = w.find('[data-testid="spec-agent-select"]')
    expect((sel.element as HTMLSelectElement).value).toBe('a3')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].specAgentId).toBe('a3')
  })

  it('offers a leading "follow default" option plus enabled agents by order for the automation picker', () => {
    const w = mount(SettingsPanel, {
      props: {
        open: true,
        settings: { ...threeAgents, agents: [mk('a1'), mk('a2', false), mk('a3')] },
      },
    })
    const opts = w
      .findAll('[data-testid="automation-agent-select"] option')
      .map((o) => (o.element as HTMLOptionElement).value)
    // '' (follow default) + a1 + a3; a2 (disabled) excluded.
    expect(opts).toEqual(['', 'a1', 'a3'])
  })

  it('seeds the automation dropdown from settings.automationAgentId and carries it through on save', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...threeAgents, automationAgentId: 'a2' } },
    })
    const sel = w.find('[data-testid="automation-agent-select"]')
    expect((sel.element as HTMLSelectElement).value).toBe('a2')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].automationAgentId).toBe('a2')
  })

  it('keeps an empty automationAgentId empty (follow default) when an agent is disabled', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...threeAgents, automationAgentId: '' } },
    })
    // Disable a2 — an empty ("follow default") automation agent must stay empty.
    const checks = w.findAll('[data-testid="agent-enabled-switch"]')
    await checks[1].setValue(false)
    const sel = w.find('[data-testid="automation-agent-select"]')
    expect((sel.element as HTMLSelectElement).value).toBe('')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].automationAgentId).toBe('')
  })

  it('rewrites a non-empty automationAgentId to the next enabled agent when disabled', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...threeAgents, automationAgentId: 'a2' } },
    })
    // Disable a2 (the current automation agent) → fall through to a3.
    const checks = w.findAll('[data-testid="agent-enabled-switch"]')
    await checks[1].setValue(false)
    const sel = w.find('[data-testid="automation-agent-select"]')
    expect((sel.element as HTMLSelectElement).value).toBe('a3')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].automationAgentId).toBe('a3')
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

describe('SettingsPanel.vue — authentication (ADR-0023, multi-account)', () => {
  const H = '$scrypt$ln=15,r=8,p=1$s$h'
  // Settings with one configured account, designated admin (effectively enabled).
  const withAdmin: SystemSettings = {
    ...baseSettings,
    auth: {
      enabled: true,
      provider: {
        kind: 'basic',
        accounts: [{ username: 'admin', passwordHash: H }],
        adminUsername: 'admin',
      },
      session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_KEY' },
    },
  }
  // Two accounts, admin = alice.
  const withTwo: SystemSettings = {
    ...baseSettings,
    auth: {
      enabled: true,
      provider: {
        kind: 'basic',
        accounts: [
          { username: 'alice', passwordHash: H },
          { username: 'bob', passwordHash: H },
        ],
        adminUsername: 'alice',
      },
      session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_KEY' },
    },
  }

  it('renders three selectable provider options: none, basic, oauth', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const opts = w.findAll('[data-testid="settings-auth-provider"] option')
    expect(opts.map((o) => (o.element as HTMLOptionElement).value)).toEqual([
      'none',
      'basic',
      'oauth',
    ])
    expect(opts.every((o) => !(o.element as HTMLOptionElement).disabled)).toBe(true)
  })

  it('defaults the provider dropdown to "none" when no auth block exists', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const sel = w.find('[data-testid="settings-auth-provider"]').element as HTMLSelectElement
    expect(sel.value).toBe('none')
    expect(w.find('[data-testid="settings-auth-accounts"]').exists()).toBe(false)
    expect(w.find('[data-testid="settings-auth-oauth"]').exists()).toBe(false)
    expect(w.find('[data-testid="settings-auth-none-hint"]').exists()).toBe(true)
  })

  it('disables the exposure toggle until an admin is configured', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const exposure = w.find('[data-testid="settings-auth-exposure"]').element as HTMLInputElement
    expect(exposure.disabled).toBe(true)
  })

  it('enables the exposure toggle once an admin account exists', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withAdmin } })
    const exposure = w.find('[data-testid="settings-auth-exposure"]').element as HTMLInputElement
    expect(exposure.disabled).toBe(false)
  })

  it('reveals the account editor only after selecting the basic provider', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    expect(w.find('[data-testid="settings-auth-accounts"]').exists()).toBe(false)
    await w.find('[data-testid="settings-auth-provider"]').setValue('basic')
    expect(w.find('[data-testid="settings-auth-accounts"]').exists()).toBe(true)
    // The add form lives in a modal — only its trigger shows until opened.
    expect(w.find('[data-testid="settings-auth-add-account-open"]').exists()).toBe(true)
    expect(w.find('[data-testid="settings-auth-add-username"]').exists()).toBe(false)
    // Basic chosen but no accounts yet ⇒ the "set an admin first" hint, not "active".
    expect(w.find('[data-testid="settings-auth-need-admin"]').exists()).toBe(true)
    expect(w.find('[data-testid="settings-auth-active"]').exists()).toBe(false)
  })

  it('renders one row per account with the admin radio reflecting the designation', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withTwo } })
    const rows = w.findAll('[data-testid="settings-auth-account-row"]')
    expect(rows).toHaveLength(2)
    const radios = w.findAll('[data-testid="settings-auth-admin-radio"]')
    expect((radios[0].element as HTMLInputElement).checked).toBe(true) // alice
    expect((radios[1].element as HTMLInputElement).checked).toBe(false) // bob
  })

  it('saves enabled:false + provider.kind "none" when no authentication is selected', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withAdmin } })
    await w.find('[data-testid="settings-auth-provider"]').setValue('none')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.auth?.enabled).toBe(false)
    expect(saved.auth?.provider.kind).toBe('none')
  })

  it('saves enabled:true for basic once an admin is configured', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withAdmin } })
    await w.find('[data-testid="settings-save"]').trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.auth?.enabled).toBe(true)
    expect(saved.auth?.provider.kind).toBe('basic')
    expect(w.find('[data-testid="settings-auth-active"]').exists()).toBe(true)
  })

  it('keeps oauth disabled (runtime pending) — saves enabled:false', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withAdmin } })
    await w.find('[data-testid="settings-auth-provider"]').setValue('oauth')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.auth?.enabled).toBe(false)
    expect(saved.auth?.provider.kind).toBe('oauth')
    expect(w.find('[data-testid="settings-auth-oauth-pending"]').exists()).toBe(true)
  })

  it('renders the oauth adminEmail input and patches it', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    await w.find('[data-testid="settings-auth-provider"]').setValue('oauth')
    const input = w.find('[data-testid="settings-auth-oauth-admin-email"]')
    expect(input.exists()).toBe(true)
    await input.setValue('alice@example.com')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    if (saved.auth?.provider.kind !== 'oauth') throw new Error('expected oauth')
    expect(saved.auth.provider.adminEmail).toBe('alice@example.com')
  })

  it('never pre-fills the add-password input (write-only)', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withAdmin } })
    await w.find('[data-testid="settings-auth-add-account-open"]').trigger('click')
    const pw = w.find('[data-testid="settings-auth-add-password"]').element as HTMLInputElement
    expect(pw.value).toBe('')
    expect(pw.type).toBe('password')
  })

  it('add account: emits set-password without a current password and closes the modal', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    await w.find('[data-testid="settings-auth-provider"]').setValue('basic')
    await w.find('[data-testid="settings-auth-add-account-open"]').trigger('click')
    await w.find('[data-testid="settings-auth-add-username"]').setValue('root')
    await w.find('[data-testid="settings-auth-add-password"]').setValue('s3cret!')
    await w.find('[data-testid="settings-auth-add-account"]').trigger('click')
    const emitted = w.emitted('set-password') as [
      { username: string; password: string; currentPassword?: string },
    ][]
    expect(emitted[0][0]).toEqual({ username: 'root', password: 's3cret!' })
    // The modal closes after a successful add.
    expect(w.find('[data-testid="settings-auth-add-modal"]').exists()).toBe(false)
  })

  it('blocks adding an account whose username already exists (AC2.1)', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withTwo } })
    await w.find('[data-testid="settings-auth-add-account-open"]').trigger('click')
    await w.find('[data-testid="settings-auth-add-username"]').setValue('alice')
    await w.find('[data-testid="settings-auth-add-password"]').setValue('whatever')
    expect(w.find('[data-testid="settings-auth-add-duplicate"]').exists()).toBe(true)
    const btn = w.find('[data-testid="settings-auth-add-account"]').element as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    await w.find('[data-testid="settings-auth-add-account"]').trigger('click')
    expect(w.emitted('set-password')).toBeUndefined()
  })

  it('change password: opens the modal and includes the current password', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withAdmin } })
    await w.find('[data-testid="settings-auth-account-change"]').trigger('click')
    expect(w.find('[data-testid="settings-auth-change-password"]').exists()).toBe(true)
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
    // The modal closes after submitting.
    expect(w.find('[data-testid="settings-auth-change-password"]').exists()).toBe(false)
  })

  it('remove button opens a confirm modal; only the confirm emits remove-account', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withTwo } })
    const removes = w.findAll('[data-testid="settings-auth-account-remove"]')
    await removes[1].trigger('click') // bob
    // Clicking Remove only opens the confirmation — nothing emitted yet.
    expect(w.emitted('remove-account')).toBeUndefined()
    expect(w.find('[data-testid="settings-auth-remove-confirm"]').exists()).toBe(true)
    await w.find('[data-testid="settings-auth-remove-confirm-btn"]').trigger('click')
    const emitted = w.emitted('remove-account') as [{ username: string }][]
    expect(emitted[0][0]).toEqual({ username: 'bob' })
    expect(w.find('[data-testid="settings-auth-remove-confirm"]').exists()).toBe(false)
  })

  it('remove confirm modal: cancel dismisses without emitting', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withTwo } })
    const removes = w.findAll('[data-testid="settings-auth-account-remove"]')
    await removes[1].trigger('click') // bob
    await w.find('[data-testid="settings-auth-remove-cancel"]').trigger('click')
    expect(w.emitted('remove-account')).toBeUndefined()
    expect(w.find('[data-testid="settings-auth-remove-confirm"]').exists()).toBe(false)
  })

  it('admin radio emits set-admin-account when picking another account', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withTwo } })
    const radios = w.findAll('[data-testid="settings-auth-admin-radio"]')
    await radios[1].trigger('change') // pick bob as admin
    const emitted = w.emitted('set-admin-account') as [{ username: string }][]
    expect(emitted[0][0]).toEqual({ username: 'bob' })
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

describe('SettingsPanel.vue — sandbox column header', () => {
  const withSandbox: SystemSettings = {
    ...baseSettings,
    sandboxes: [{ name: 'default', type: 'docker', image: 'node:20', seccomp: '', cpuLimit: 1 }],
  }

  it('renders a column-title header with six localized labels when a sandbox exists', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withSandbox } })
    const header = w.find('[data-testid="sandbox-row-header"]')
    expect(header.exists()).toBe(true)
    const labels = header.findAll('.agent-field')
    expect(labels).toHaveLength(6)
    // Default locale is en in tests: Name / Type / Image / Seccomp profile / Memory limit / CPU limit.
    expect(labels.map((l) => l.text())).toEqual([
      'Name',
      'Type',
      'Image',
      'Seccomp profile',
      'Memory limit',
      'CPU limit (cores)',
    ])
  })

  it('omits the header when there are no sandbox definitions', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    expect(w.find('[data-testid="sandbox-row-header"]').exists()).toBe(false)
  })

  it('renders the type-column select with the mode-select class the layout rule targets', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withSandbox } })
    const typeSelect = w.find('[data-testid="sandbox-type"]')
    expect(typeSelect.exists()).toBe(true)
    // The alignment fix hangs off `.sandbox-row .mode-select`; the select must keep this class.
    expect(typeSelect.classes()).toContain('mode-select')
  })

  it('aligns the type-column select via the shared sandbox flex rule on desktop and resets it on mobile', () => {
    const css = readFileSync(resolve(process.cwd(), 'web/src/style.css'), 'utf8')
    // Desktop: `.sandbox-row .mode-select` shares the `.agent-field` flex column so the
    // "Type" input's left/right edges line up under its header label.
    expect(css).toMatch(
      /\.sandbox-row \.agent-field,\s*\.sandbox-row \.mode-select \{[^}]*min-width:\s*80px;[^}]*flex:\s*1 0 120px;/,
    )
    // Mobile (<=767px): the same select is reset so it stacks full-width like the other fields.
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*\.sandbox-row \.mode-select,/)
  })

  it('drops blank-name sandbox rows on save so they never reach the server registry', async () => {
    const withBlankRow: SystemSettings = {
      ...baseSettings,
      sandboxes: [
        { name: 'docker-node', type: 'docker', image: 'node:20', seccomp: '', cpuLimit: 1 },
        { name: '  ', type: 'docker', image: '', seccomp: '', cpuLimit: 1 },
      ],
    }
    const w = mount(SettingsPanel, { props: { open: true, settings: withBlankRow } })
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].sandboxes).toEqual([
      { name: 'docker-node', type: 'docker', image: 'node:20', seccomp: '', cpuLimit: 1 },
    ])
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

describe('SettingsPanel.vue — vendor CLI multi-version selection', () => {
  const hostStatus = [
    {
      vendor: 'claude' as const,
      present: true,
      binary: 'claude',
      path: '/usr/local/bin/claude',
      source: 'managed',
      installHint: '',
      activeVersion: '1.0.0',
      downloadTargetVersion: '1.3.0',
      lastRemoteCheckAt: '2026-07-09T00:00:00.000Z',
      installedVersions: [
        { version: '1.0.0', status: 'installed' as const, installedAt: '2026-07-01T00:00:00.000Z' },
        { version: '1.3.0', status: 'installed' as const, installedAt: '2026-07-09T00:00:00.000Z' },
      ],
    },
    {
      vendor: 'codex' as const,
      present: false,
      binary: 'codex',
      path: null,
      installHint: 'install codex',
      lastError: 'active 0.140.0 not installed/incompatible',
    },
  ]

  it('renders installed versions as radio options and excludes failed/missing ones', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings, hostStatus } })
    const rows = w.findAll('[data-testid="vendor-cli-row"]')
    expect(rows).toHaveLength(2)
    // Claude: auto + 2 installed versions = 3 radio inputs.
    const claudeRadios = w.findAll('[data-testid="vendor-cli-version-claude"]')
    expect(claudeRadios).toHaveLength(2)
    // Codex has no installedVersions ⇒ only the auto radio, no version radios.
    expect(w.findAll('[data-testid="vendor-cli-version-codex"]')).toHaveLength(0)
  })

  it('shows the active version, download target, and last check status', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings, hostStatus } })
    expect(w.get('[data-testid="vendor-cli-active-claude"]').text()).toBe('1.0.0')
    expect(w.get('[data-testid="vendor-cli-target-claude"]').text()).toBe('1.3.0')
    expect(w.get('[data-testid="vendor-cli-error-codex"]').text()).toContain('0.140.0')
  })

  it('selecting an installed version emits save with the new vendorCliVersions and no sync message', async () => {
    const settings: SystemSettings = { ...baseSettings, vendorCliVersions: {} }
    const w = mount(SettingsPanel, { props: { open: true, settings, hostStatus } })
    const radios = w.findAll('[data-testid="vendor-cli-version-claude"]')
    // 1.0.0 is the first installed-version radio.
    await radios[0].trigger('change')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const saveEmit = w.emitted('save')
    expect(saveEmit).toBeTruthy()
    const emitted = (saveEmit![0][0] as SystemSettings).vendorCliVersions
    expect(emitted?.claude).toBe('1.0.0')
  })

  it('selecting auto clears the vendor pin in the emitted save payload', async () => {
    const settings: SystemSettings = { ...baseSettings, vendorCliVersions: { claude: '1.0.0' } }
    const w = mount(SettingsPanel, { props: { open: true, settings, hostStatus } })
    await w.get('[data-testid="vendor-cli-auto-claude"]').trigger('change')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = (w.emitted('save')![0][0] as SystemSettings).vendorCliVersions
    expect(emitted?.claude).toBeUndefined()
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

describe('SettingsPanel.vue — non-admin is read-only (ADR-0023 authz)', () => {
  const auth = useAuth()
  // useAuth is a module singleton; restore the default (admin) after each case so
  // the flag never leaks into other suites.
  afterEach(() => auth.setIsAdmin(true))

  it('admin (default): no read-only notice and Save is enabled', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    expect(w.find('[data-testid="settings-readonly-notice"]').exists()).toBe(false)
    expect(w.find('[data-testid="settings-save"]').attributes('disabled')).toBeUndefined()
  })

  it('non-admin: shows the read-only notice and disables Save', () => {
    auth.setIsAdmin(false)
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    expect(w.find('[data-testid="settings-readonly-notice"]').exists()).toBe(true)
    expect(w.find('[data-testid="settings-save"]').attributes('disabled')).toBeDefined()
  })

  it('non-admin: clicking Save emits nothing (the handler is guarded too)', async () => {
    auth.setIsAdmin(false)
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    await w.find('[data-testid="settings-save"]').trigger('click')
    expect(w.emitted('save')).toBeUndefined()
  })
})
