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
    const saveBtn = w.findAll('.settings-foot button').find((b) => b.text() === 'Save')!
    await saveBtn.trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted).toBeTruthy()
    expect(emitted[0][0].maxRoundsPerStage).toBe(20)
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
    const saveBtn = w.findAll('.settings-foot button').find((b) => b.text() === 'Save')!
    await saveBtn.trigger('click')
    const emitted = w.emitted('save') as [SystemSettings][]
    expect(emitted).toBeTruthy()
    expect(emitted[0][0].maxSpeechChars).toBe(600)
  })
})
