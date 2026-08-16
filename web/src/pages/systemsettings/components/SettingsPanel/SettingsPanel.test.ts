import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import SettingsPanel from './SettingsPanel.vue'
import { SYSTEM_AGENT_ID, VENDOR_IDS } from '@ccc/shared/protocol'
import type { SystemSettings, VendorId, VendorRuntimeStatus } from '@ccc/shared/protocol'
import { useAuth } from '@/composables/useAuth'
import { VENDOR_COLOR } from '@/lib/vendor'

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
  specReviewAgentId: '',
  automationAgentId: '',
  defaultMode: 'default',
  consensus: { enabled: false },
  voiceLang: 'zh-CN',
  showToolSessions: false,
  showSessionsPage: false,
  devSkill: '',
  maxRoundsPerStage: 14,
  maxSpeechChars: 400,
}

// The tab whose Save button drives each config block after the Tab grouping
// refactor (2026-07-11-001). Every panel is rendered (v-show), so a control and
// its tab's Save button are always in the DOM — a test can drive either without
// activating the tab first.
const SAVE = {
  agent: '[data-testid="settings-save-agent"]',
  runtime: '[data-testid="settings-save-runtime"]',
  security: '[data-testid="settings-save-security"]',
  general: '[data-testid="settings-save-general"]',
} as const

describe('SettingsPanel.vue — sessions page switch', () => {
  afterEach(() => useAuth().setIsAdmin(true))

  it('renders the accessible switch and saves the dirty General field', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const toggle = w.find('[data-testid="settings-show-sessions-page"]')
    expect(toggle.attributes('role')).toBe('switch')
    expect((toggle.element as HTMLInputElement).checked).toBe(false)
    expect(w.text()).toContain('Show sessions page')

    await toggle.setValue(true)
    expect(w.find('[data-testid="settings-tab-dirty-general"]').exists()).toBe(true)
    await w.find(SAVE.general).trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].showSessionsPage).toBe(true)
  })

  it('ships matching English and Chinese copy and disables the switch for non-admins', () => {
    const en = JSON.parse(readFileSync(resolve(__dirname, '../../../../locales/en.json'), 'utf8'))
    const zh = JSON.parse(readFileSync(resolve(__dirname, '../../../../locales/zh.json'), 'utf8'))
    expect(en.settings.display.showSessionsPage.label).toBe('Show sessions page')
    expect(zh.settings.display.showSessionsPage.label).toBe('显示会话页')
    useAuth().setIsAdmin(false)
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const toggle = w.find('[data-testid="settings-show-sessions-page"]')
    expect(toggle.attributes()).toHaveProperty('disabled')
  })
})

// `@vue/test-utils` `isVisible()` is unreliable for nested v-show in this env, but
// v-show writes `display: none` inline — read that directly to check tab visibility.
function panelHidden(w: ReturnType<typeof mount>, testid: string): boolean {
  return (w.find(`[data-testid="${testid}"]`).attributes('style') ?? '').includes('display: none')
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

  it('system-mode codex — model input visible, baseUrl/apiKey/wireApi hidden', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: systemClaude } })
    await w.find('[data-testid="agent-vendor-tab-btn-codex"]').trigger('click')
    const sysRow = w.find('[data-agent-id="system-codex"]')
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
    await w.find(SAVE.agent).trigger('click')
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
    await w.find(SAVE.agent).trigger('click')
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
    await w.find(SAVE.agent).trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].defaultAgentId).toBe('a3')
  })

  it('falls back to SYSTEM_AGENT_ID when every agent is disabled', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: threeAgents } })
    const checks = w.findAll('[data-testid="agent-enabled-switch"]')
    await checks[0].setValue(false)
    await checks[1].setValue(false)
    await checks[2].setValue(false)
    await w.find(SAVE.agent).trigger('click')
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
    await w.find(SAVE.agent).trigger('click')
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
    await w.find(SAVE.agent).trigger('click')
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
    await w.find(SAVE.agent).trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].intentAgentId).toBe('a3')
  })

  it('seeds the spec dropdown from settings.specAgentId and carries it through on save', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...threeAgents, specAgentId: 'a2' } },
    })
    const sel = w.find('[data-testid="spec-agent-select"]')
    expect((sel.element as HTMLSelectElement).value).toBe('a2')
    await w.find(SAVE.agent).trigger('click')
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
    await w.find(SAVE.agent).trigger('click')
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
    await w.find(SAVE.agent).trigger('click')
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
    await w.find(SAVE.agent).trigger('click')
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
    await w.find(SAVE.agent).trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].automationAgentId).toBe('')
  })

  it('renders no sandbox-role block — sandbox runs share the unified role config', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: threeAgents } })
    expect(w.find('[data-testid="sandbox-roles-head"]').exists()).toBe(false)
    for (const role of ['default', 'tool', 'intent', 'spec', 'automation']) {
      expect(w.find(`[data-testid="sandbox-${role}-agent-select"]`).exists()).toBe(false)
    }
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0] as unknown as Record<
      string,
      unknown
    >
    for (const key of [
      'sandboxDefaultAgentId',
      'sandboxToolAgentId',
      'sandboxIntentAgentId',
      'sandboxSpecAgentId',
      'sandboxAutomationAgentId',
    ]) {
      expect(saved[key]).toBeUndefined()
    }
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
    await w.find(SAVE.agent).trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].automationAgentId).toBe('a3')
  })
})

describe('SettingsPanel.vue — display language moved out of system settings', () => {
  it('does not render a display-language control on any tab', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    expect(w.find('[data-testid="settings-ui-lang"]').exists()).toBe(false)
    expect(w.text()).not.toContain('Display language')
  })

  it('keeps the other General fields loading and saving', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const voice = w.find<HTMLSelectElement>('[data-testid="settings-voice-lang"]')
    expect(voice.element.value).toBe('zh-CN')
    await voice.setValue('en-US')
    await w.find(SAVE.general).trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].voiceLang).toBe('en-US')
    expect(emitted[0][0].timezone).toBeTruthy()
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
    await w.find(SAVE.agent).trigger('click')
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

  it('carries the selected timezone into the General Save payload', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...baseSettings, timezone: 'Asia/Shanghai' } },
    })
    await w.find('[data-testid="settings-timezone"]').setValue('America/New_York')
    await w.find(SAVE.general).trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted[0][0].timezone).toBe('America/New_York')
  })
})

describe('SettingsPanel.vue — pass-through fields survive Save (2026-06-08-003)', () => {
  // The panel does not edit these fields, but every tab's Save MUST carry them into
  // the payload — dropping them is the "project config vanishes after restart" bug.
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
    await w.find(SAVE.agent).trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    const saved = emitted[0][0]
    expect(saved.projectConfigs).toEqual(withPassthrough.projectConfigs)
    expect(saved.degradationChain).toEqual(['a1', SYSTEM_AGENT_ID])
    expect(saved.socketAutoResume).toBe(false)
  })

  it('keeps pass-through fields even when an edited field also changes', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withPassthrough } })
    await w.find('[data-testid="settings-timezone"]').setValue('America/New_York')
    await w.find(SAVE.general).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.timezone).toBe('America/New_York')
    expect(saved.projectConfigs).toEqual(withPassthrough.projectConfigs)
  })

  it('deep-copies pass-through fields (emitted is a distinct object, not aliased)', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withPassthrough } })
    await w.find(SAVE.agent).trigger('click')
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

  it('renders two selectable provider options: none, basic', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const opts = w.findAll('[data-testid="settings-auth-provider"] option')
    expect(opts.map((o) => (o.element as HTMLOptionElement).value)).toEqual(['none', 'basic'])
    expect(opts.every((o) => !(o.element as HTMLOptionElement).disabled)).toBe(true)
  })

  it('defaults the provider dropdown to "none" when no auth block exists', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const sel = w.find('[data-testid="settings-auth-provider"]').element as HTMLSelectElement
    expect(sel.value).toBe('none')
    expect(w.find('[data-testid="settings-auth-accounts"]').exists()).toBe(false)
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
    await w.find(SAVE.security).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.auth?.enabled).toBe(false)
    expect(saved.auth?.provider.kind).toBe('none')
  })

  it('saves enabled:true for basic once an admin is configured', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withAdmin } })
    await w.find(SAVE.security).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.auth?.enabled).toBe(true)
    expect(saved.auth?.provider.kind).toBe('basic')
    expect(w.find('[data-testid="settings-auth-active"]').exists()).toBe(true)
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
    await w.find(SAVE.security).trigger('click')
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
    await w.find(SAVE.security).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.auth?.session.ttlSeconds).toBe(45 * 24 * 60 * 60)
  })

  it('a normal Security Save never carries draft account mutations (accounts flow through dedicated messages)', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: withTwo } })
    // Editing the TTL makes Security dirty, but the account set must round-trip
    // untouched — account CRUD is owned by the server via dedicated messages.
    await w.find('[data-testid="settings-auth-ttl"]').setValue('10')
    await w.find(SAVE.security).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.auth?.provider).toEqual(withTwo.auth?.provider)
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

  it('shows the sandbox driver state and resolved arapuca path', () => {
    const w = mount(SettingsPanel, {
      props: {
        open: true,
        settings: baseSettings,
        hostStatus,
        sandboxStatus: {
          present: true,
          binary: 'arapuca',
          path: '/opt/homebrew/bin/arapuca',
        },
      },
    })
    const row = w.get('[data-testid="sandbox-diagnostics"]')
    expect(row.text()).toContain('arapuca')
    expect(row.get('.diagnostics-path').text()).toBe('/opt/homebrew/bin/arapuca')
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
    await w.find(SAVE.runtime).trigger('click')
    const saveEmit = w.emitted('save')
    expect(saveEmit).toBeTruthy()
    const emitted = (saveEmit![0][0] as SystemSettings).vendorCliVersions
    expect(emitted?.claude).toBe('1.0.0')
  })

  it('selecting auto clears the vendor pin in the emitted save payload', async () => {
    const settings: SystemSettings = { ...baseSettings, vendorCliVersions: { claude: '1.0.0' } }
    const w = mount(SettingsPanel, { props: { open: true, settings, hostStatus } })
    await w.get('[data-testid="vendor-cli-auto-claude"]').trigger('change')
    await w.find(SAVE.runtime).trigger('click')
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

  it('dropping a row onto another slot inside the same container reorders it', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: threeAgents } })
    const rows = w.findAll('[data-testid="agent-card"]')
    // Grab the 3rd row (a2) and drop it onto the 2nd slot (a1).
    await rows[2].find('[data-testid="agent-drag"]').trigger('dragstart')
    await rows[1].trigger('dragover')
    await rows[1].trigger('drop')
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents.map((a) => a.id)).toEqual([SYSTEM_AGENT_ID, 'a2', 'a1'])
    expect(saved.agents.map((a) => a.order_seq)).toEqual([0, 1, 2])
  })

  it('a drop targeting the System agent lands after it — the server pins it to order_seq 0', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: threeAgents } })
    const rows = w.findAll('[data-testid="agent-card"]')
    await rows[2].find('[data-testid="agent-drag"]').trigger('dragstart')
    await rows[0].trigger('dragover')
    await rows[0].trigger('drop')
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents.map((a) => a.id)).toEqual([SYSTEM_AGENT_ID, 'a2', 'a1'])
  })

  it('Save stamps order_seq from array order even without any drag', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: threeAgents } })
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents.map((a) => a.order_seq)).toEqual([0, 1, 2])
  })
})

describe('SettingsPanel.vue — agent group containers (ADR-0029)', () => {
  const grouped: SystemSettings = {
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
        group: 'pool',
        config: { baseUrl: 'https://one', apiKey: 'k', model: '' },
      },
      {
        id: 'a2',
        vendor: 'claude',
        configMode: 'custom',
        displayName: 'Two',
        enabled: true,
        group: 'pool',
        config: { baseUrl: 'https://two', apiKey: 'k', model: '' },
      },
      {
        id: 'cx',
        vendor: 'codex',
        configMode: 'custom',
        displayName: 'CX',
        enabled: true,
        config: { baseUrl: 'https://cx', apiKey: 'k', model: '', wireApi: 'chat' },
      },
    ],
  }

  const boxes = (w: ReturnType<typeof mount>) => w.findAll('[data-testid="agent-group-box"]')
  const groupNames = (w: ReturnType<typeof mount>) =>
    boxes(w).map((b) => b.attributes('data-group-name'))

  it('renders one container per group plus the default bucket, ordered by first member', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: grouped } })
    // Claude tab: System in default, `pool` follows. Codex agent is on its own tab.
    expect(groupNames(w)).toEqual(['', 'pool'])
    const rowsOf = (box: number) =>
      boxes(w)
        [box].findAll('[data-testid="agent-card"]')
        .map((r) => r.attributes('data-agent-id'))
    expect(rowsOf(0)).toEqual([SYSTEM_AGENT_ID])
    expect(rowsOf(1)).toEqual(['a1', 'a2'])

    await w.find('[data-testid="agent-vendor-tab-btn-codex"]').trigger('click')
    expect(groupNames(w)).toEqual([''])
    expect(
      boxes(w)[0]
        .findAll('[data-testid="agent-card"]')
        .map((r) => r.attributes('data-agent-id')),
    ).toEqual(['cx'])
  })

  it('the in-group arrow swaps two members and Save keeps the new failover order', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: grouped } })
    const pool = boxes(w)[1]
    // a2 is second in `pool`; move it up so it becomes the first candidate.
    await pool.findAll('[data-testid="agent-move-up"]')[1].trigger('click')
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents.filter((a) => a.group === 'pool').map((a) => a.id)).toEqual(['a2', 'a1'])
    expect(saved.agents.map((a) => a.order_seq)).toEqual([0, 1, 2, 3])
  })

  it('the first member cannot move up and the last cannot move down', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: grouped } })
    const pool = boxes(w)[1]
    const ups = pool.findAll('[data-testid="agent-move-up"]')
    const downs = pool.findAll('[data-testid="agent-move-down"]')
    expect(ups[0].attributes('disabled')).toBeDefined()
    expect(downs[1].attributes('disabled')).toBeDefined()
    expect(ups[1].attributes('disabled')).toBeUndefined()
  })

  it('the System agent is pinned: it can neither move down nor be passed by a sibling', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: grouped } })
    const def = boxes(w)[0]
    expect(def.findAll('[data-testid="agent-move-down"]')[0].attributes('disabled')).toBeDefined()
    // On the Claude tab the default bucket only holds System (codex lives on its tab).
    expect(def.findAll('[data-testid="agent-card"]')).toHaveLength(1)
  })

  it('dragging a row onto another vendor’s container is refused and leaves group untouched', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: grouped } })
    await w.find('[data-testid="agent-vendor-tab-btn-codex"]').trigger('click')
    const cxRow = w.find('[data-agent-id="cx"]')
    await cxRow.find('[data-testid="agent-drag"]').trigger('dragstart')
    // Switch mid-drag: the Claude `pool` group must still refuse a codex agent.
    await w.find('[data-testid="agent-vendor-tab-btn-claude"]').trigger('click')
    const pool = boxes(w).find((b) => b.attributes('data-group-name') === 'pool')
    expect(pool).toBeTruthy()
    await pool!.trigger('drop')
    expect(w.find('[data-testid="agent-group-notice"]').text()).toContain('one agent type')
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents.find((a) => a.id === 'cx')?.group).toBe('')
    expect(saved.agents.find((a) => a.id === 'cx')?.vendor).toBe('codex')
  })

  it('a system-config agent may join a group — it is a legitimate first hop', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: grouped } })
    await w
      .find(`[data-agent-id="${SYSTEM_AGENT_ID}"]`)
      .find('[data-testid="agent-drag"]')
      .trigger('dragstart')
    await boxes(w)[1].trigger('drop')
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents.find((a) => a.id === SYSTEM_AGENT_ID)?.group).toBe('pool')
    // The container holding the System agent must render (and save) first.
    expect(saved.agents.map((a) => a.id)).toEqual(['a1', 'a2', SYSTEM_AGENT_ID, 'cx'])
  })

  it('dragging the last member out keeps the emptied container visible', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: grouped } })
    for (const id of ['a1', 'a2']) {
      await w
        .find(`[data-agent-id="${id}"]`)
        .find('[data-testid="agent-drag"]')
        .trigger('dragstart')
      await boxes(w)[0].trigger('drop')
    }
    expect(groupNames(w)).toContain('pool')
    expect(
      boxes(w)
        .find((b) => b.attributes('data-group-name') === 'pool')
        ?.text(),
    ).toContain('Drag an agent here')
  })

  it('renaming a container rewrites every member’s group', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: grouped } })
    const name = boxes(w)[1].find('[data-testid="agent-group-name"]')
    await name.setValue('backup')
    await name.trigger('change')
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents.filter((a) => a.group === 'backup').map((a) => a.id)).toEqual(['a1', 'a2'])
  })

  it('a rename to the reserved group-ref prefix is refused and rolled back', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: grouped } })
    const name = boxes(w)[1].find('[data-testid="agent-group-name"]')
    await name.setValue('_c3_claude_x')
    await name.trigger('change')
    expect(w.find('[data-testid="agent-group-notice"]').exists()).toBe(true)
    expect((name.element as HTMLInputElement).value).toBe('pool')
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents.filter((a) => a.group === 'pool')).toHaveLength(2)
  })

  it('dissolving a container drops every member back to default without deleting them', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: grouped } })
    await boxes(w)[1].find('[data-testid="agent-group-remove"]').trigger('click')
    expect(groupNames(w)).toEqual([''])
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents).toHaveLength(4)
    expect(saved.agents.every((a) => (a.group ?? '') === '')).toBe(true)
  })

  it('a newly created container is empty and is not saved until it has a member', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: grouped } })
    await w.find('[data-testid="settings-add-group"]').trigger('click')
    expect(groupNames(w)).toHaveLength(3)
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents.map((a) => a.group ?? '')).toEqual(['', '', 'pool', 'pool'])
    expect(w.find('[data-testid="agent-group-notice"]').text()).toContain('not saved')
  })

  it('retyping a grouped agent’s vendor moves it out of the group instead of splitting the pool', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: grouped, vendorAvailability: availability() },
    })
    await w.find('[data-agent-id="a1"]').find('[data-testid="agent-vendor"]').setValue('codex')
    expect(w.find('[data-testid="agent-group-notice"]').exists()).toBe(true)
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    const a1 = saved.agents.find((a) => a.id === 'a1')
    expect(a1?.vendor).toBe('codex')
    expect(a1?.group).toBe('')
  })
})

describe('SettingsPanel.vue — non-admin is read-only (ADR-0023 authz)', () => {
  const auth = useAuth()
  // useAuth is a module singleton; restore the default (admin) after each case so
  // the flag never leaks into other suites.
  afterEach(() => auth.setIsAdmin(true))

  it('admin (default): no read-only notice and every tab Save is enabled', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    expect(w.find('[data-testid="settings-readonly-notice"]').exists()).toBe(false)
    for (const sel of Object.values(SAVE)) {
      expect(w.find(sel).attributes('disabled')).toBeUndefined()
    }
  })

  it('non-admin: shows the read-only notice and disables every tab Save', () => {
    auth.setIsAdmin(false)
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    expect(w.find('[data-testid="settings-readonly-notice"]').exists()).toBe(true)
    for (const sel of Object.values(SAVE)) {
      expect(w.find(sel).attributes('disabled')).toBeDefined()
    }
  })

  it('non-admin: clicking any tab Save emits nothing (handlers are guarded too)', async () => {
    auth.setIsAdmin(false)
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    for (const sel of Object.values(SAVE)) {
      await w.find(sel).trigger('click')
    }
    expect(w.emitted('save')).toBeUndefined()
  })

  it('non-admin: account-management controls are disabled', () => {
    auth.setIsAdmin(false)
    const withBasic: SystemSettings = {
      ...baseSettings,
      auth: {
        enabled: true,
        provider: {
          kind: 'basic',
          accounts: [{ username: 'admin', passwordHash: '$scrypt$x' }],
          adminUsername: 'admin',
        },
        session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_KEY' },
      },
    }
    const w = mount(SettingsPanel, { props: { open: true, settings: withBasic } })
    expect(
      (w.find('[data-testid="settings-auth-add-account-open"]').element as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(
      (w.find('[data-testid="settings-auth-admin-radio"]').element as HTMLInputElement).disabled,
    ).toBe(true)
  })
})

describe('SettingsPanel.vue — Tab grouping (2026-07-11-001)', () => {
  it('renders five tabs in order for an administrator, ending with Users and access', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const labels = w
      .findAll('[data-testid="settings-tabs"] .settings-tab span')
      .map((s) => s.text())
    // Each tab has a label span (and an optional dirty dot span); take the label texts.
    const tabButtons = w.findAll('[data-testid^="settings-tab-btn-"]')
    expect(tabButtons).toHaveLength(5)
    expect(labels.slice(0, 5)).toEqual([
      'Agent',
      'Runtime',
      'Security',
      'General',
      'Users and access',
    ])
  })

  it('hides the access tab from a non-admin, whose every access request the server would refuse', () => {
    useAuth().setIsAdmin(false)
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const labels = w
      .findAll('[data-testid="settings-tabs"] .settings-tab span')
      .map((s) => s.text())
    expect(w.findAll('[data-testid^="settings-tab-btn-"]')).toHaveLength(4)
    expect(labels).not.toContain('Users and access')
    useAuth().setIsAdmin(true)
  })

  it('assigns every config block to exactly one tab panel', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    // Marker testids that uniquely identify each config block, and the panel each
    // must live under.
    const membership: Record<string, string> = {
      'settings-add-agent': 'settings-tab-agent',
      'default-agent-select': 'settings-tab-agent',
      'settings-diagnostics': 'settings-tab-runtime',
      'settings-vendor-cli': 'settings-tab-runtime',
      'settings-proxy': 'settings-tab-runtime',
      'settings-session-cleanup': 'settings-tab-runtime',
      'settings-auth': 'settings-tab-security',
      'settings-voice-lang': 'settings-tab-general',
      'settings-timezone': 'settings-tab-general',
      'settings-base-url': 'settings-tab-general',
    }
    for (const [block, panel] of Object.entries(membership)) {
      // Appears exactly once across the whole panel (no duplication).
      expect(w.findAll(`[data-testid="${block}"]`)).toHaveLength(1)
      // And it lives under its designated tab panel.
      expect(w.find(`[data-testid="${panel}"] [data-testid="${block}"]`).exists()).toBe(true)
    }
  })

  it('defaults to the Agent tab and switches to a clean tab without confirmation', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    // Agent panel visible; others hidden (v-show).
    expect(panelHidden(w, 'settings-tab-agent')).toBe(false)
    expect(panelHidden(w, 'settings-tab-runtime')).toBe(true)
    await w.find('[data-testid="settings-tab-btn-runtime"]').trigger('click')
    // No dirty edits ⇒ immediate switch, no confirm dialog.
    expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(false)
    expect(panelHidden(w, 'settings-tab-runtime')).toBe(false)
    expect(panelHidden(w, 'settings-tab-agent')).toBe(true)
  })

  it('the tab bar scrolls horizontally so all tabs stay reachable on mobile', () => {
    const css = readFileSync(resolve(process.cwd(), 'web/src/style.css'), 'utf8')
    expect(css).toMatch(/\.settings-tabs \{[^}]*overflow-x:\s*auto;/)
  })
})

describe('SettingsPanel.vue — per-tab dirty state (2026-07-11-001)', () => {
  it('marks only the edited tab dirty, and clears it after that tab saves', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    // Clean at first: no dirty dots anywhere.
    expect(w.find('[data-testid="settings-tab-dirty-general"]').exists()).toBe(false)
    // Edit a General field.
    await w.find('[data-testid="settings-timezone"]').setValue('America/New_York')
    expect(w.find('[data-testid="settings-tab-dirty-general"]').exists()).toBe(true)
    // Other tabs stay clean.
    expect(w.find('[data-testid="settings-tab-dirty-agent"]').exists()).toBe(false)
    expect(w.find('[data-testid="settings-tab-dirty-runtime"]').exists()).toBe(false)
    // Save General, then simulate the server echo (settings pushback).
    await w.find(SAVE.general).trigger('click')
    await w.setProps({ settings: { ...baseSettings, timezone: 'America/New_York' } })
    expect(w.find('[data-testid="settings-tab-dirty-general"]').exists()).toBe(false)
  })

  it('detects structural edits (adding an agent) as dirty', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    expect(w.find('[data-testid="settings-tab-dirty-agent"]').exists()).toBe(false)
    await w.find('[data-testid="settings-add-agent"]').trigger('click')
    expect(w.find('[data-testid="settings-tab-dirty-agent"]').exists()).toBe(true)
  })

  it('detects a live proxy toggle (Runtime) as dirty', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    expect(w.find('[data-testid="settings-tab-dirty-runtime"]').exists()).toBe(false)
    await w.find('[data-testid="settings-proxy-enabled"]').setValue(true)
    expect(w.find('[data-testid="settings-tab-dirty-runtime"]').exists()).toBe(true)
  })
})

describe('SettingsPanel.vue — session cleanup (system-wide)', () => {
  const CLEANUP = '[data-testid="settings-session-cleanup-enabled"]'
  const RETENTION = '[data-testid="settings-session-cleanup-retention"]'

  it('renders off with the default window when the server has no cleanup config', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const toggle = w.find(CLEANUP)
    expect(toggle.attributes('role')).toBe('switch')
    expect((toggle.element as HTMLInputElement).checked).toBe(false)
    expect((w.find(RETENTION).element as HTMLInputElement).value).toBe('30')
    // The window is not editable until cleanup is switched on.
    expect(w.find(RETENTION).attributes('disabled')).toBeDefined()
  })

  it('round-trips a persisted switch and window', () => {
    const w = mount(SettingsPanel, {
      props: {
        open: true,
        settings: { ...baseSettings, sessionCleanup: { enabled: true, retentionDays: 14 } },
      },
    })
    expect((w.find(CLEANUP).element as HTMLInputElement).checked).toBe(true)
    expect((w.find(RETENTION).element as HTMLInputElement).value).toBe('14')
    expect(w.find(RETENTION).attributes('disabled')).toBeUndefined()
  })

  it('marks the Runtime tab dirty and saves the enabled switch', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    expect(w.find('[data-testid="settings-tab-dirty-runtime"]').exists()).toBe(false)
    await w.find(CLEANUP).setValue(true)
    expect(w.find('[data-testid="settings-tab-dirty-runtime"]').exists()).toBe(true)

    await w.find(SAVE.runtime).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.sessionCleanup).toEqual({ enabled: true, retentionDays: 30 })
  })

  it('saves an edited retention window, flooring sub-day input up to 1', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    await w.find(CLEANUP).setValue(true)
    await w.find(RETENTION).setValue('7')
    await w.find(SAVE.runtime).trigger('click')
    expect((w.emitted('save') as [SystemSettings][])[0][0].sessionCleanup).toEqual({
      enabled: true,
      retentionDays: 7,
    })

    await w.find(RETENTION).setValue('0')
    await w.find(SAVE.runtime).trigger('click')
    expect((w.emitted('save') as [SystemSettings][])[1][0].sessionCleanup).toEqual({
      enabled: true,
      retentionDays: 1,
    })
  })

  it('carries cleanup untouched when another tab saves', async () => {
    const w = mount(SettingsPanel, {
      props: {
        open: true,
        settings: { ...baseSettings, sessionCleanup: { enabled: true, retentionDays: 14 } },
      },
    })
    await w.find('[data-testid="settings-timezone"]').setValue('America/New_York')
    await w.find(SAVE.general).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.sessionCleanup).toEqual({ enabled: true, retentionDays: 14 })
  })
})

describe('SettingsPanel.vue — independent per-tab save (2026-07-11-001)', () => {
  it('saving one tab emits only that tab’s new values; the other tab uses the committed value', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...baseSettings, timezone: 'Asia/Shanghai' } },
    })
    // Edit BOTH the Agent tab (add an agent) and the General tab (timezone).
    await w.find('[data-testid="settings-add-agent"]').trigger('click')
    await w.find('[data-testid="settings-timezone"]').setValue('America/New_York')
    // Save only General.
    await w.find(SAVE.general).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    // General's new value is present…
    expect(saved.timezone).toBe('America/New_York')
    // …but the Agent draft (2 agents) is NOT committed — the payload keeps the
    // committed single agent.
    expect(saved.agents).toHaveLength(1)
    expect(saved.agents[0].id).toBe(SYSTEM_AGENT_ID)
  })

  it('after the saved tab’s server echo, the other dirty tab keeps its draft and dirty flag', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...baseSettings, timezone: 'Asia/Shanghai' } },
    })
    await w.find('[data-testid="settings-add-agent"]').trigger('click')
    await w.find('[data-testid="settings-timezone"]').setValue('America/New_York')
    expect(w.findAll('[data-testid="agent-card"]')).toHaveLength(2)

    await w.find(SAVE.general).trigger('click')
    // Server echoes the General save (timezone applied, agents unchanged).
    await w.setProps({ settings: { ...baseSettings, timezone: 'America/New_York' } })

    // General is now clean…
    expect(w.find('[data-testid="settings-tab-dirty-general"]').exists()).toBe(false)
    // …while the Agent tab keeps its unsaved draft (still 2 agents) and stays dirty.
    expect(w.findAll('[data-testid="agent-card"]')).toHaveLength(2)
    expect(w.find('[data-testid="settings-tab-dirty-agent"]').exists()).toBe(true)
  })

  it('saving a second tab before the first save echoes does not revert the first save', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...baseSettings, timezone: 'Asia/Shanghai' } },
    })
    // Save the General tab with an edited timezone…
    await w.find('[data-testid="settings-timezone"]').setValue('America/New_York')
    await w.find(SAVE.general).trigger('click')
    // …then, WITHOUT the server echo arriving, edit + save the Agent tab.
    await w.find('[data-testid="settings-add-agent"]').trigger('click')
    await w.find(SAVE.agent).trigger('click')
    // The second payload must carry the first save's timezone (not the stale
    // committed one), or the second save would silently revert the first.
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted).toHaveLength(2)
    expect(emitted[1][0].timezone).toBe('America/New_York')
    expect(emitted[1][0].agents).toHaveLength(2)
    // And the saved General tab's dirty flag clears optimistically (no lingering
    // "unsaved" dot before the echo).
    expect(w.find('[data-testid="settings-tab-dirty-general"]').exists()).toBe(false)
  })

  it('an account-operation pushback refreshes accounts without reseeding other tabs’ drafts', async () => {
    const H = '$scrypt$x'
    const withOne: SystemSettings = {
      ...baseSettings,
      auth: {
        enabled: true,
        provider: {
          kind: 'basic',
          accounts: [{ username: 'a', passwordHash: H }],
          adminUsername: 'a',
        },
        session: { ttlSeconds: 3600, signingKeyRef: 'C3_AUTH_KEY' },
      },
    }
    const w = mount(SettingsPanel, { props: { open: true, settings: withOne } })
    // Dirty the Agent tab.
    await w.find('[data-testid="settings-add-agent"]').trigger('click')
    expect(w.findAll('[data-testid="agent-card"]')).toHaveLength(2)
    // A dedicated account message adds 'b' → the server pushes updated settings.
    const withTwo: SystemSettings = {
      ...withOne,
      auth: {
        ...withOne.auth!,
        provider: {
          kind: 'basic',
          accounts: [
            { username: 'a', passwordHash: H },
            { username: 'b', passwordHash: H },
          ],
          adminUsername: 'a',
        },
      },
    }
    await w.setProps({ settings: withTwo })
    // Security reflects the new account list…
    expect(w.findAll('[data-testid="settings-auth-account-row"]')).toHaveLength(2)
    // …and the Agent draft survives the pushback (not reseeded back to 1 agent).
    expect(w.findAll('[data-testid="agent-card"]')).toHaveLength(2)
    expect(w.find('[data-testid="settings-tab-dirty-agent"]').exists()).toBe(true)
  })
})

describe('SettingsPanel.vue — dirty-tab switch confirmation (2026-07-11-001)', () => {
  it('cancelling the confirm keeps the current tab and its draft', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    await w.find('[data-testid="settings-add-agent"]').trigger('click') // dirty Agent
    await w.find('[data-testid="settings-tab-btn-general"]').trigger('click')
    // Confirm appears; still on Agent.
    expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(true)
    expect(panelHidden(w, 'settings-tab-agent')).toBe(false)
    await w.find('[data-testid="confirm-cancel"]').trigger('click')
    // Stayed on Agent, draft intact.
    expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(false)
    expect(panelHidden(w, 'settings-tab-agent')).toBe(false)
    expect(w.findAll('[data-testid="agent-card"]')).toHaveLength(2)
  })

  it('confirming switches tabs and preserves the leaving tab’s draft for later editing', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    await w.find('[data-testid="settings-add-agent"]').trigger('click') // dirty Agent
    await w.find('[data-testid="settings-tab-btn-general"]').trigger('click')
    await w.find('[data-testid="confirm-accept"]').trigger('click')
    // Switched to General.
    expect(panelHidden(w, 'settings-tab-general')).toBe(false)
    expect(panelHidden(w, 'settings-tab-agent')).toBe(true)
    // Agent draft neither saved nor discarded: it is still dirty and editable.
    expect(w.find('[data-testid="settings-tab-dirty-agent"]').exists()).toBe(true)
    expect(w.emitted('save')).toBeUndefined()
    // Returning to Agent (clean General ⇒ no confirm) shows the retained draft.
    await w.find('[data-testid="settings-tab-btn-agent"]').trigger('click')
    expect(w.findAll('[data-testid="agent-card"]')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Cursor vendor in the agent config panel (2026-08-03-002)
// ---------------------------------------------------------------------------

/** 全部 vendor 可用的中立可用性表;`unavailable` 里的按其原因码判为不可用。 */
function availability(
  unavailable: Partial<Record<VendorId, VendorRuntimeStatus>> = {},
): Record<VendorId, VendorRuntimeStatus> {
  const out = {} as Record<VendorId, VendorRuntimeStatus>
  for (const vendor of VENDOR_IDS) {
    out[vendor] = unavailable[vendor] ?? { vendor, available: true, runtime: 'host-cli' }
  }
  return out
}

const CURSOR_UNAVAILABLE: VendorRuntimeStatus = {
  vendor: 'cursor',
  available: false,
  runtime: 'host-cli',
  runtimeId: 'cursor-agent',
  reason: 'host-cli-missing',
}

function vendorOptions(w: ReturnType<typeof mount>) {
  return w.find('[data-testid="agent-vendor"]').findAll('option')
}

describe('SettingsPanel.vue — Cursor vendor in the agent config panel', () => {
  it('offers every registered vendor, Cursor included', () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: baseSettings, vendorAvailability: availability() },
    })
    expect(vendorOptions(w).map((o) => o.element.value)).toEqual([...VENDOR_IDS])
  })

  it('switching an agent to cursor rebuilds the config as system + {apiKey, model}, no baseUrl', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: baseSettings, vendorAvailability: availability() },
    })
    await w.find('[data-testid="agent-vendor"]').setValue('cursor')
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    const agent = saved.agents[0]
    expect(agent.vendor).toBe('cursor')
    expect(agent.configMode).toBe('system')
    expect(agent.config).toEqual({ apiKey: '', model: '' })
    expect(agent.config).not.toHaveProperty('baseUrl')
  })

  it('a cursor agent offers only the system config mode, and shows apiKey + model', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: baseSettings, vendorAvailability: availability() },
    })
    await w.find('[data-testid="agent-vendor"]').setValue('cursor')
    const modes = w
      .find('[data-testid="agent-configmode"]')
      .findAll('option')
      .map((o) => o.element.value)
    expect(modes).toEqual(['system'])
    expect(w.find('.agent-key').exists()).toBe(true)
    expect(w.find('.agent-model').exists()).toBe(true)
    // No path produces a baseUrl input for cursor.
    expect(w.find('.agent-url').exists()).toBe(false)
  })

  it('carries a typed cursor apiKey and model into the Save payload', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: baseSettings, vendorAvailability: availability() },
    })
    await w.find('[data-testid="agent-vendor"]').setValue('cursor')
    await w.find('.agent-key').setValue('key-abc')
    await w.find('.agent-model').setValue('claude-4.5-sonnet')
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents[0].config).toEqual({ apiKey: 'key-abc', model: 'claude-4.5-sonnet' })
  })

  it('disables an unavailable vendor option and states the reason next to it', () => {
    const w = mount(SettingsPanel, {
      props: {
        open: true,
        settings: baseSettings,
        vendorAvailability: availability({ cursor: CURSOR_UNAVAILABLE }),
      },
    })
    const cursorOption = vendorOptions(w).find((o) => o.element.value === 'cursor')!
    expect(cursorOption.attributes('disabled')).toBeDefined()
    expect(cursorOption.text()).toContain('vendor CLI not found on this host')
    // …and the same reason is repeated under the roster, so it is visible without
    // opening the dropdown.
    expect(w.find('[data-testid="agent-vendor-notes"]').text()).toContain(
      'vendor CLI not found on this host',
    )
  })

  it('refuses to switch an agent to an unavailable vendor', async () => {
    const w = mount(SettingsPanel, {
      props: {
        open: true,
        settings: baseSettings,
        vendorAvailability: availability({ cursor: CURSOR_UNAVAILABLE }),
      },
    })
    await w.find('[data-testid="agent-vendor"]').setValue('cursor')
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents[0].vendor).toBe('claude')
  })

  it('keeps an already-configured cursor agent selectable even when its runtime is gone', async () => {
    const withCursor: SystemSettings = {
      ...baseSettings,
      agents: [
        {
          id: 'cursor-a',
          vendor: 'cursor',
          configMode: 'system',
          displayName: 'Cursor A',
          config: { apiKey: '', model: '' },
        },
      ],
      defaultAgentId: 'cursor-a',
    }
    const w = mount(SettingsPanel, {
      props: {
        open: true,
        settings: withCursor,
        vendorAvailability: availability({ cursor: CURSOR_UNAVAILABLE }),
      },
    })
    await w.find('[data-testid="agent-vendor-tab-btn-cursor"]').trigger('click')
    const cursorOption = vendorOptions(w).find((o) => o.element.value === 'cursor')!
    expect(cursorOption.attributes('disabled')).toBeUndefined()
  })

  it('lists a Cursor runtime diagnostics row with its SDK id, status and reason', () => {
    const w = mount(SettingsPanel, {
      props: {
        open: true,
        settings: baseSettings,
        vendorAvailability: availability({ cursor: CURSOR_UNAVAILABLE }),
        hostStatus: [
          {
            vendor: 'claude',
            present: true,
            binary: 'claude',
            path: '/usr/local/bin/claude',
            installHint: '',
          },
        ],
      },
    })
    const rows = w.findAll('[data-testid="diagnostics-row"]')
    expect(rows).toHaveLength(VENDOR_IDS.length)
    const cursorRow = rows.find((r) => r.attributes('data-vendor') === 'cursor')!
    expect(cursorRow.text()).toContain('cursor-agent')
    // 原因文案要可行动,而不只是"不可用"。
    expect(cursorRow.text()).toContain('vendor CLI not found')
    // 解析不到时没有来源可讲,不渲染来源/位置列。
    expect(cursorRow.find('.diagnostics-path').exists()).toBe(false)
    // 宿主 CLI 行照旧显示解析到的绝对路径。
    const claudeRow = rows.find((r) => r.attributes('data-vendor') === 'claude')!
    expect(claudeRow.find('.diagnostics-path').text()).toBe('/usr/local/bin/claude')
  })

  it('shows where a vendor-distributed CLI resolved from, and which copy will run', () => {
    const w = mount(SettingsPanel, {
      props: {
        open: true,
        settings: baseSettings,
        vendorAvailability: availability({
          cursor: {
            vendor: 'cursor',
            available: true,
            runtime: 'host-cli',
            runtimeId: 'cursor-agent',
            origin: 'host-path',
            location: '/home/u/.local/bin/cursor-agent',
          },
        }),
        hostStatus: [],
      },
    })
    const cursorRow = w
      .findAll('[data-testid="diagnostics-row"]')
      .find((r) => r.attributes('data-vendor') === 'cursor')!
    const origin = cursorRow.get('[data-testid="diagnostics-origin"]')
    expect(origin.text()).toContain('found on PATH')
    expect(origin.text()).toContain('/home/u/.local/bin/cursor-agent')
  })

  it('lists no CLI version panel row for an SDK-backed vendor', () => {
    const w = mount(SettingsPanel, {
      props: {
        open: true,
        settings: baseSettings,
        vendorAvailability: availability(),
        hostStatus: [
          {
            vendor: 'claude',
            present: true,
            binary: 'claude',
            path: '/usr/local/bin/claude',
            installHint: '',
          },
        ],
      },
    })
    expect(w.findAll('[data-testid="vendor-cli-row"]')).toHaveLength(1)
  })

  it('falls back to hostStatus and treats an SDK vendor as unavailable on an older server', () => {
    // No `vendorAvailability` at all — the shape an old server's `settings` leaves.
    const w = mount(SettingsPanel, {
      props: {
        open: true,
        settings: baseSettings,
        hostStatus: [
          {
            vendor: 'claude',
            present: true,
            binary: 'claude',
            path: '/usr/local/bin/claude',
            installHint: '',
          },
        ],
      },
    })
    const rows = w.findAll('[data-testid="diagnostics-row"]')
    const claudeRow = rows.find((r) => r.attributes('data-vendor') === 'claude')!
    const cursorRow = rows.find((r) => r.attributes('data-vendor') === 'cursor')!
    expect(claudeRow.text()).toContain('available')
    expect(cursorRow.text()).toContain('unavailable')
  })
})

describe('SettingsPanel.vue — a Cursor agent is a first-class pick in every role selector', () => {
  const withCursor: SystemSettings = {
    ...baseSettings,
    agents: [
      {
        id: SYSTEM_AGENT_ID,
        vendor: 'claude',
        configMode: 'system',
        displayName: 'System',
        enabled: true,
        config: { baseUrl: '', apiKey: '', model: '' },
      },
      {
        id: 'cursor-a',
        vendor: 'cursor',
        configMode: 'system',
        displayName: 'Cursor A',
        enabled: true,
        group: 'squad',
        config: { apiKey: '', model: '' },
      },
    ],
  }

  const ROLE_PICKERS = [
    'default-agent-select',
    'tool-agent-select',
    'intent-agent-select',
    'spec-agent-select',
    'automation-agent-select',
  ] as const

  it('offers the cursor agent in the default and every role picker (no vendor filter)', () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: withCursor, vendorAvailability: availability() },
    })
    for (const testid of ROLE_PICKERS) {
      const values = w
        .find(`[data-testid="${testid}"]`)
        .findAll('option')
        .map((o) => o.element.value)
      expect(values).toContain('cursor-a')
    }
  })

  it('lists the cursor agent’s group as a virtual group agent (degradation chain member)', () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: withCursor, vendorAvailability: availability() },
    })
    const values = w
      .find('[data-testid="default-agent-select"]')
      .findAll('option')
      .map((o) => o.element.value)
    expect(values).toContain('_c3_cursor_squad')
  })

  it('carries a cursor default agent through the Agent tab Save', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: withCursor, vendorAvailability: availability() },
    })
    await w.find('[data-testid="default-agent-select"]').setValue('cursor-a')
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.defaultAgentId).toBe('cursor-a')
  })
})

describe('SettingsPanel.vue — agent list vendor sub-tabs', () => {
  const multi: SystemSettings = {
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
        group: 'pool',
        config: { baseUrl: 'https://one', apiKey: 'k', model: '' },
      },
      {
        id: 'cx',
        vendor: 'codex',
        configMode: 'custom',
        displayName: 'CX',
        enabled: true,
        group: 'cx-pool',
        config: { baseUrl: 'https://cx', apiKey: 'k', model: '', wireApi: 'chat' },
      },
    ],
  }

  const vendorTabBtns = (w: ReturnType<typeof mount>) =>
    w.findAll('[data-testid^="agent-vendor-tab-btn-"]')

  it('offers one sub-tab per registered vendor and no All overview tab', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: multi } })
    const ids = vendorTabBtns(w).map((b) => b.attributes('data-testid'))
    expect(ids).toEqual(VENDOR_IDS.map((v) => `agent-vendor-tab-btn-${v}`))
    expect(w.find('[data-testid="agent-vendor-tab-btn-all"]').exists()).toBe(false)
  })

  it('filters the list to the active vendor’s agents and group containers', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: multi } })
    expect(w.find('[data-agent-id="a1"]').exists()).toBe(true)
    expect(w.find('[data-agent-id="cx"]').exists()).toBe(false)
    expect(
      w.findAll('[data-testid="agent-group-box"]').map((b) => b.attributes('data-group-name')),
    ).toEqual(['', 'pool'])

    await w.find('[data-testid="agent-vendor-tab-btn-codex"]').trigger('click')
    expect(w.find('[data-agent-id="a1"]').exists()).toBe(false)
    expect(w.find('[data-agent-id="cx"]').exists()).toBe(true)
    expect(
      w.findAll('[data-testid="agent-group-box"]').map((b) => b.attributes('data-group-name')),
    ).toEqual(['', 'cx-pool'])
  })

  it('keeps same-vendor group structure visible on its tab', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: multi } })
    const pool = w
      .findAll('[data-testid="agent-group-box"]')
      .find((b) => b.attributes('data-group-name') === 'pool')
    expect(pool?.find('[data-agent-id="a1"]').exists()).toBe(true)
    expect(w.find('[data-testid="agent-group-box"].is-default').exists()).toBe(true)
  })

  it('adds a new agent under the active vendor tab', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: multi, vendorAvailability: availability() },
    })
    await w.find('[data-testid="agent-vendor-tab-btn-codex"]').trigger('click')
    await w.find('[data-testid="settings-add-agent"]').trigger('click')
    const cards = w.findAll('[data-testid="agent-card"]')
    const added = cards[cards.length - 1]
    expect(added.attributes('data-agent-vendor')).toBe('codex')
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    const minted = saved.agents.filter(
      (a) => a.id !== SYSTEM_AGENT_ID && a.id !== 'a1' && a.id !== 'cx',
    )
    expect(minted).toHaveLength(1)
    expect(minted[0].vendor).toBe('codex')
  })
})

// A group's identity is `(vendor, group)` and the virtual ref `_c3_<vendor>_<group>`
// encodes the vendor, so two vendors may reuse ONE group name and each is its own
// failover pool. Keying containers by the bare name would merge them: one vendor's
// members would vanish from its tab and an edit would rewrite the other side.
describe('SettingsPanel.vue — same group name under two vendors stays two containers', () => {
  const sameName: SystemSettings = {
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
        id: 'cl-1',
        vendor: 'claude',
        configMode: 'custom',
        displayName: 'Claude pool',
        enabled: true,
        group: 'pool',
        config: { baseUrl: 'https://cl', apiKey: 'k', model: '' },
      },
      {
        id: 'cx-1',
        vendor: 'codex',
        configMode: 'custom',
        displayName: 'Codex pool',
        enabled: true,
        group: 'pool',
        config: { baseUrl: 'https://cx', apiKey: 'k', model: '', wireApi: 'chat' },
      },
    ],
  }
  const groupBox = (w: ReturnType<typeof mount>, name: string) =>
    w
      .findAll('[data-testid="agent-group-box"]')
      .find((b) => b.attributes('data-group-name') === name)

  it('shows each vendor its own `pool` container with only its own members', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: sameName } })
    const claudePool = groupBox(w, 'pool')
    expect(claudePool?.attributes('data-group-vendor')).toBe('claude')
    expect(
      claudePool!.findAll('[data-testid="agent-card"]').map((r) => r.attributes('data-agent-id')),
    ).toEqual(['cl-1'])

    await w.find('[data-testid="agent-vendor-tab-btn-codex"]').trigger('click')
    const codexPool = groupBox(w, 'pool')
    expect(codexPool?.attributes('data-group-vendor')).toBe('codex')
    expect(
      codexPool!.findAll('[data-testid="agent-card"]').map((r) => r.attributes('data-agent-id')),
    ).toEqual(['cx-1'])
  })

  it('renaming one vendor’s container leaves the same-named group on the other vendor alone', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: sameName } })
    const input = groupBox(w, 'pool')!.find('[data-testid="agent-group-name"]')
    ;(input.element as HTMLInputElement).value = 'fast'
    await input.trigger('change')
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents.find((a) => a.id === 'cl-1')?.group).toBe('fast')
    expect(saved.agents.find((a) => a.id === 'cx-1')?.group).toBe('pool')
  })

  it('dissolving one vendor’s container keeps the other vendor’s members grouped', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: sameName } })
    await groupBox(w, 'pool')!.find('[data-testid="agent-group-remove"]').trigger('click')
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents.find((a) => a.id === 'cl-1')?.group).toBe('')
    expect(saved.agents.find((a) => a.id === 'cx-1')?.group).toBe('pool')
  })

  it('refuses a drop into the other vendor’s same-named container', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: sameName } })
    await w.find('[data-testid="agent-vendor-tab-btn-codex"]').trigger('click')
    await w.find('[data-agent-id="cx-1"]').find('[data-testid="agent-drag"]').trigger('dragstart')
    await w.find('[data-testid="agent-vendor-tab-btn-claude"]').trigger('click')
    await groupBox(w, 'pool')!.trigger('drop')
    expect(w.find('[data-testid="agent-group-notice"]').text()).toContain('one agent type')
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    expect(saved.agents.find((a) => a.id === 'cx-1')?.vendor).toBe('codex')
    expect(saved.agents.find((a) => a.id === 'cx-1')?.group).toBe('pool')
  })

  it('retyping a member’s vendor onto a vendor that already owns that group name drops it to default', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: sameName, vendorAvailability: availability() },
    })
    await w.find('[data-agent-id="cl-1"]').find('[data-testid="agent-vendor"]').setValue('codex')
    await w.find(SAVE.agent).trigger('click')
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    const moved = saved.agents.find((a) => a.id === 'cl-1')!
    expect(moved.vendor).toBe('codex')
    // It must NOT silently join the codex `pool` the user never dragged it into.
    expect(moved.group).toBe('')
    expect(saved.agents.find((a) => a.id === 'cx-1')?.group).toBe('pool')
  })
})

describe('SettingsPanel.vue — agent row vendor tint', () => {
  const multiVendor: SystemSettings = {
    ...baseSettings,
    agents: [
      {
        id: 'claude-1',
        vendor: 'claude',
        configMode: 'system',
        displayName: 'Claude One',
        config: { baseUrl: '', apiKey: '', model: '' },
      },
      {
        id: 'codex-1',
        vendor: 'codex',
        configMode: 'system',
        displayName: 'Codex One',
        config: { baseUrl: '', apiKey: '', model: '', wireApi: 'responses' },
      },
    ],
  }

  function rowTint(w: ReturnType<typeof mount>, agentId: string): string {
    const el = w.find(`[data-agent-id="${agentId}"]`).element as HTMLElement
    return el.style.getPropertyValue('--agent-vendor-tint')
  }

  it('tints each agent row from its vendor VENDOR_COLOR-derived mix', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: multiVendor, vendorAvailability: availability() },
    })
    const claudeTint = rowTint(w, 'claude-1')
    expect(claudeTint).toContain(VENDOR_COLOR.claude)
    expect(claudeTint).toMatch(/color-mix\(in srgb,/i)

    await w.find('[data-testid="agent-vendor-tab-btn-codex"]').trigger('click')
    const codexTint = rowTint(w, 'codex-1')
    expect(codexTint).toContain(VENDOR_COLOR.codex)
    expect(codexTint).toMatch(/color-mix\(in srgb,/i)
    expect(claudeTint).not.toBe(codexTint)
  })

  it('updates the row tint immediately when the vendor select changes', async () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: multiVendor, vendorAvailability: availability() },
    })
    expect(rowTint(w, 'claude-1')).toContain(VENDOR_COLOR.claude)

    await w
      .find('[data-agent-id="claude-1"]')
      .find('[data-testid="agent-vendor"]')
      .setValue('cursor')
    expect(rowTint(w, 'claude-1')).toContain(VENDOR_COLOR.cursor)
    expect(rowTint(w, 'claude-1')).not.toContain(VENDOR_COLOR.claude)
  })
})

describe('SettingsPanel.vue — one-shot locate target', () => {
  // The jump crosses two reactive hops (arm the target → switch tab → locate on
  // nextTick), so settle the queue before asserting on the located row.
  const settle = async () => {
    await nextTick()
    await nextTick()
    await nextTick()
  }

  const twoAgents: SystemSettings = {
    ...baseSettings,
    agents: [
      ...baseSettings.agents,
      {
        id: 'codex-1',
        vendor: 'codex',
        configMode: 'custom',
        displayName: 'Codex One',
        config: { baseUrl: '', apiKey: '', model: '', wireApi: 'responses' },
      },
    ],
  }

  function row(w: ReturnType<typeof mount>, agentId: string) {
    return w.find(`[data-agent-id="${agentId}"]`)
  }

  it('lands on the Agent tab and highlights the named row', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: twoAgents } })
    await w.find('[data-testid="settings-tab-btn-runtime"]').trigger('click')
    expect(panelHidden(w, 'settings-tab-agent')).toBe(true)

    await w.setProps({ target: { tab: 'agent', vendor: 'codex', agentId: 'codex-1' } })
    await settle()

    expect(panelHidden(w, 'settings-tab-agent')).toBe(false)
    expect(row(w, 'codex-1').classes()).toContain('located')
    expect(w.find('[data-testid="agent-locate-missing"]').exists()).toBe(false)
    expect(w.emitted('target-consumed')).toHaveLength(1)
  })

  it('navigates only — it does not enable, edit or save anything', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: twoAgents } })
    await w.setProps({ target: { tab: 'agent', vendor: 'codex', agentId: 'codex-1' } })
    await settle()

    expect(w.emitted('save')).toBeUndefined()
    // The jump leaves every tab clean: nothing about the config was touched.
    expect(w.find('[data-testid="settings-tab-dirty-agent"]').exists()).toBe(false)
  })

  it('falls back to the vendor’s row with a non-blocking notice when the agent is gone', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: twoAgents } })
    await w.setProps({ target: { tab: 'agent', vendor: 'codex', agentId: 'deleted-agent' } })
    await settle()

    // Still on the Agent tab, still usable — a notice, not a dead end.
    expect(panelHidden(w, 'settings-tab-agent')).toBe(false)
    expect(w.find('[data-testid="agent-locate-missing"]').exists()).toBe(true)
    expect(w.find('.agent-row.located').exists()).toBe(false)
    expect(w.emitted('target-consumed')).toHaveLength(1)
  })

  it('waits for the unsaved-draft confirm instead of discarding the draft', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: twoAgents } })
    await w.find('[data-testid="settings-tab-btn-general"]').trigger('click')
    await w.find('[data-testid="settings-timezone"]').setValue('America/New_York')

    await w.setProps({ target: { tab: 'agent', vendor: 'codex', agentId: 'codex-1' } })
    await nextTick()

    // Held at the confirm: the General draft is still there and still dirty.
    expect(w.find('[data-testid="confirm-overlay"]').exists()).toBe(true)
    expect(panelHidden(w, 'settings-tab-agent')).toBe(true)
    expect(w.find('[data-testid="settings-tab-dirty-general"]').exists()).toBe(true)
    expect(w.emitted('target-consumed')).toBeUndefined()

    await w.find('[data-testid="confirm-accept"]').trigger('click')
    await settle()

    expect(panelHidden(w, 'settings-tab-agent')).toBe(false)
    expect(row(w, 'codex-1').classes()).toContain('located')
    // Confirming only switched tabs — the draft was neither saved nor discarded.
    expect(w.emitted('save')).toBeUndefined()
    expect(w.find('[data-testid="settings-tab-dirty-general"]').exists()).toBe(true)
  })

  it('drops the jump when the user declines to leave the dirty tab', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: twoAgents } })
    await w.find('[data-testid="settings-tab-btn-general"]').trigger('click')
    await w.find('[data-testid="settings-timezone"]').setValue('America/New_York')
    await w.setProps({ target: { tab: 'agent', vendor: 'codex', agentId: 'codex-1' } })
    await nextTick()

    await w.find('[data-testid="confirm-cancel"]').trigger('click')
    await settle()

    expect(panelHidden(w, 'settings-tab-agent')).toBe(true)
    // The target is released, so a later self-initiated tab switch does not lurch.
    expect(w.emitted('target-consumed')).toHaveLength(1)
    await w.find('[data-testid="settings-tab-btn-agent"]').trigger('click')
    await w.find('[data-testid="confirm-accept"]').trigger('click')
    await settle()
    expect(w.find('.agent-row.located').exists()).toBe(false)
  })
})

describe('SettingsPanel.vue — agent id minting (2026-08-07-007)', () => {
  // Only Date is faked: the panel's own timers (tab transitions, toasts) must keep
  // running on the real clock or mounting would stall.
  const freezeClock = (iso: string) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(iso))
    return Date.now()
  }
  afterEach(() => vi.useRealTimers())

  /** The agents the draft grew on top of the seeded system row. */
  const minted = (w: ReturnType<typeof mount>) => {
    const saved = (w.emitted('save') as [SystemSettings][])[0][0]
    return saved.agents.filter((a) => a.id !== SYSTEM_AGENT_ID).map((a) => a.id)
  }

  it('mints added-agent ids from the current millisecond, free of placeholder words', async () => {
    const now = freezeClock('2026-08-07T01:02:03.456Z')
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    await w.find('[data-testid="settings-add-agent"]').trigger('click')
    await w.find('[data-testid="settings-add-agent"]').trigger('click')
    await w.find(SAVE.agent).trigger('click')

    const ids = minted(w)
    expect(ids).toHaveLength(2)
    for (const id of ids) {
      expect(id).toMatch(new RegExp(`^${now}-\\d+$`))
      expect(id).not.toMatch(/new|copy/i)
    }
    // Same millisecond, still distinct — the numeric suffix carries uniqueness.
    expect(ids[0]).not.toBe(ids[1])
  })

  it('mints a copied agent id the same way instead of a `copy-` prefix', async () => {
    const now = freezeClock('2026-08-07T01:02:03.456Z')
    const w = mount(SettingsPanel, {
      props: {
        open: true,
        settings: {
          ...baseSettings,
          agents: [
            ...baseSettings.agents,
            {
              id: 'a1',
              vendor: 'claude',
              configMode: 'custom',
              displayName: 'A1',
              config: { baseUrl: 'https://a1', apiKey: 'k', model: '' },
            },
          ],
        },
      },
    })
    const copyBtns = w.findAll('[data-testid="agent-copy"]')
    await copyBtns[copyBtns.length - 1].trigger('click')
    await w.find(SAVE.agent).trigger('click')

    const ids = minted(w).filter((id) => id !== 'a1')
    expect(ids).toHaveLength(1)
    expect(ids[0]).toMatch(new RegExp(`^${now}-\\d+$`))
    expect(ids[0]).not.toMatch(/new|copy/i)
  })
})

describe('SettingsPanel.vue — one-click agent bootstrap (cold start)', () => {
  const CTA = '[data-testid="settings-auto-configure-agents"]'
  const BLOCK = '[data-testid="agent-autoconfig"]'

  afterEach(() => useAuth().setIsAdmin(true))

  /** A registry holding only the synthesized fallback — the cold-start state. */
  const onlyFallback: SystemSettings = { ...baseSettings }

  const configured: SystemSettings = {
    ...baseSettings,
    agents: [
      ...baseSettings.agents,
      {
        id: 'codex-1',
        vendor: 'codex',
        configMode: 'system',
        displayName: 'Codex',
        config: { baseUrl: '', apiKey: '', model: '', wireApi: 'chat' },
      },
    ],
  }

  it('offers the CTA while the registry holds only the synthesized fallback', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: onlyFallback } })
    expect(w.find(BLOCK).exists()).toBe(true)
    expect(w.find(CTA).exists()).toBe(true)
  })

  it('offers the CTA when the registry is entirely empty', () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...baseSettings, agents: [] } },
    })
    expect(w.find(CTA).exists()).toBe(true)
  })

  it('hides the CTA once any real agent exists', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: configured } })
    expect(w.find(BLOCK).exists()).toBe(false)
    expect(w.find(CTA).exists()).toBe(false)
  })

  it('emits auto-configure-agents on click — never a settings save', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: onlyFallback } })
    await w.find(CTA).trigger('click')
    expect(w.emitted('auto-configure-agents')).toHaveLength(1)
    // It persists server-side on its own; routing it through the tab draft would
    // make the cold-start user save before they have an agent to save.
    expect(w.emitted('save')).toBeUndefined()
  })

  it('stays visible after an unsaved blank row is added — the registry is still empty', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: onlyFallback } })
    await w.find('[data-testid="settings-add-agent"]').trigger('click')
    expect(w.find(CTA).exists()).toBe(true)
  })

  it('disables the CTA for a non-admin (the server refuses it regardless)', () => {
    useAuth().setIsAdmin(false)
    const w = mount(SettingsPanel, { props: { open: true, settings: onlyFallback } })
    expect(w.find(CTA).attributes()).toHaveProperty('disabled')
  })

  it('ships matching English and Chinese copy for the CTA and its outcomes', () => {
    const en = JSON.parse(readFileSync(resolve(__dirname, '../../../../locales/en.json'), 'utf8'))
    const zh = JSON.parse(readFileSync(resolve(__dirname, '../../../../locales/zh.json'), 'utf8'))
    expect(en.settings.agents.autoConfigure.label).toBe('Auto-configure')
    expect(zh.settings.agents.autoConfigure.label).toBe('一键自动配置')
    // The two zero-created cases must stay distinguishable in every locale.
    for (const cat of [en, zh]) {
      const r = cat.settings.agents.autoConfigure.result
      expect(r.noVendor).not.toBe(r.alreadyConfigured)
      expect(r.created).toContain('{n}')
    }
  })
})
