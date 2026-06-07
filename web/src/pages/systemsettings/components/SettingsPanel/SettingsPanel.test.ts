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

  it('only offers en + zh in the current phase (ja/ko/ru reserved)', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const values = w
      .findAll('[data-testid="settings-ui-lang"] option')
      .map((o) => (o.element as HTMLOptionElement).value)
    expect(values).toEqual(['en', 'zh'])
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

describe('SettingsPanel.vue — external skill repos (ADR-0016/0017)', () => {
  const settingsWithSkillRepos: SystemSettings = {
    ...baseSettings,
    skillRepos: [
      {
        id: 'my-skills',
        repo: 'https://github.com/owner/repo',
        ref: 'main',
        subpath: 'skills/my-skill',
        vendor: 'claude',
        trust: 'review-on-update',
      },
      {
        id: 'pinned-skills',
        repo: 'https://github.com/owner/pinned',
        ref: 'v1.0',
        vendor: 'all',
        trust: 'pinned',
        pinCommit: 'abcdef1234567890abcdef1234567890abcdef12',
      },
    ],
  }

  it('renders a row per skill repo when settings carry skillRepos', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: settingsWithSkillRepos } })
    const rows = w.findAll('[data-testid="skill-repo-row"]')
    expect(rows).toHaveLength(2)
  })

  it('shows an empty hint when skillRepos is empty', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    expect(w.text()).toContain('No external skill repositories configured.')
  })

  it('adds a new row on + Add skill repo', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    await w.find('[data-testid="settings-add-skill-repo"]').trigger('click')
    const rows = w.findAll('[data-testid="skill-repo-row"]')
    expect(rows).toHaveLength(1)
  })

  it('removes a row on click', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: settingsWithSkillRepos } })
    const removes = w.findAll('[data-testid="skill-repo-remove"]')
    expect(removes).toHaveLength(2)
    await removes[0].trigger('click')
    expect(w.findAll('[data-testid="skill-repo-row"]')).toHaveLength(1)
  })

  it('shows ref required error when ref is empty', () => {
    const w = mount(SettingsPanel, {
      props: {
        open: true,
        settings: {
          ...baseSettings,
          skillRepos: [{ id: 's', repo: '', ref: '', vendor: 'claude', trust: 'unreviewed' }],
        },
      },
    })
    const errors = w.findAll('[data-testid="skill-repo-ref-error"]')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].text()).toBeTruthy()
  })

  it('shows pin required error when trust is pinned but pinCommit is missing', () => {
    const w = mount(SettingsPanel, {
      props: {
        open: true,
        settings: {
          ...baseSettings,
          skillRepos: [{ id: 's', repo: '', ref: 'main', vendor: 'claude', trust: 'pinned' }],
        },
      },
    })
    const errors = w.findAll('[data-testid="skill-repo-pin-error"]')
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0].text()).toBeTruthy()
  })

  it('no pin error when trust is pinned and pinCommit is present', () => {
    const w = mount(SettingsPanel, {
      props: {
        open: true,
        settings: {
          ...baseSettings,
          skillRepos: [
            {
              id: 's',
              repo: '',
              ref: 'main',
              vendor: 'claude',
              trust: 'pinned',
              pinCommit: 'abcdef1234567890abcdef1234567890abcdef12',
            },
          ],
        },
      },
    })
    expect(w.findAll('[data-testid="skill-repo-pin-error"]')).toHaveLength(0)
  })

  it('carries the edited skillRepos into the Save payload', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: settingsWithSkillRepos } })
    const inputs = w.findAll('[data-testid="skill-repo-ref"]')
    await inputs[0].setValue('develop')
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].skillRepos?.[0]?.ref).toBe('develop')
  })
})
