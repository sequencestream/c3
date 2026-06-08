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

  it('renders an On checkbox per agent row, reflecting enabled state', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: twoAgents } })
    const checks = w.findAll('.col-on input[type="checkbox"]')
    expect(checks).toHaveLength(3)
    // System + a1 enabled (absent/true), a2 disabled.
    expect((checks[0].element as HTMLInputElement).checked).toBe(true)
    expect((checks[1].element as HTMLInputElement).checked).toBe(true)
    expect((checks[2].element as HTMLInputElement).checked).toBe(false)
  })

  it('disables the default radio on a disabled row (only enabled agents pickable)', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: twoAgents } })
    const radios = w.findAll('.col-default input[type="radio"]')
    expect((radios[2].element as HTMLInputElement).disabled).toBe(true)
    expect((radios[1].element as HTMLInputElement).disabled).toBe(false)
  })

  it('emits the toggled enabled value on save', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: twoAgents } })
    const checks = w.findAll('.col-on input[type="checkbox"]')
    await checks[1].setValue(false) // disable a1
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].agents.find((a) => a.id === 'a1')?.enabled).toBe(false)
  })

  it('new agents default to enabled', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const addBtn = w.find('[data-testid="settings-add-agent"]')
    expect(addBtn.exists()).toBe(true)
    await addBtn.trigger('click')
    const checks = w.findAll('.col-on input[type="checkbox"]')
    // System row + the freshly added one, both checked.
    expect((checks[checks.length - 1].element as HTMLInputElement).checked).toBe(true)
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
    expect(values).toEqual(['en', 'ja', 'ko', 'ru', 'zh'])
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

// Skill-repo tests moved to ProjectConfig.test.ts (ADR-0016/0017 migration)
