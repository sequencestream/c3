import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SettingsPanel from './SettingsPanel.vue'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import type { SystemSettings } from '@ccc/shared/protocol'

const baseSettings: SystemSettings = {
  agents: [{ id: SYSTEM_AGENT_ID, name: 'System', baseUrl: '', apiKey: '', model: '' }],
  defaultAgentId: SYSTEM_AGENT_ID,
  defaultMode: 'default',
  consensus: { enabled: false },
  voiceLang: 'zh-CN',
  showToolSessions: false,
  devSkill: '',
  maxRoundsPerStage: 14,
  maxSpeechChars: 400,
}

describe('SettingsPanel.vue — discussion rounds per stage', () => {
  it('seeds the rounds input from server settings', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const input = w.find('.rounds-input')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('14')
  })

  it('defaults the rounds input when settings omit the field', () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...baseSettings, maxRoundsPerStage: undefined } },
    })
    expect((w.find('.rounds-input').element as HTMLInputElement).value).toBe('12')
  })

  it('emits the edited rounds value on save', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    await w.find('.rounds-input').setValue(20)
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted).toBeTruthy()
    expect(emitted[0][0].maxRoundsPerStage).toBe(20)
  })
})

describe('SettingsPanel.vue — agent enable/disable', () => {
  const twoAgents: SystemSettings = {
    ...baseSettings,
    agents: [
      { id: SYSTEM_AGENT_ID, name: 'System', baseUrl: '', apiKey: '', model: '' },
      { id: 'a1', name: 'One', baseUrl: 'https://one', apiKey: 'k', model: '', enabled: true },
      { id: 'a2', name: 'Two', baseUrl: 'https://two', apiKey: 'k', model: '', enabled: false },
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

describe('SettingsPanel.vue — discussion speech character limit', () => {
  it('seeds the speech-chars input from server settings', () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const inputs = w.findAll('.rounds-input')
    // Second .rounds-input belongs to the speech chars field
    expect(inputs.length).toBeGreaterThanOrEqual(2)
    expect((inputs[1].element as HTMLInputElement).value).toBe('400')
  })

  it('defaults the speech-chars input when settings omit the field', () => {
    const w = mount(SettingsPanel, {
      props: { open: true, settings: { ...baseSettings, maxSpeechChars: undefined } },
    })
    const inputs = w.findAll('.rounds-input')
    expect((inputs[1].element as HTMLInputElement).value).toBe('300')
  })

  it('emits the edited speech-chars value on save', async () => {
    const w = mount(SettingsPanel, { props: { open: true, settings: baseSettings } })
    const inputs = w.findAll('.rounds-input')
    await inputs[1].setValue(600)
    await w.find('[data-testid="settings-save"]').trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted).toBeTruthy()
    expect(emitted[0][0].maxSpeechChars).toBe(600)
  })
})
