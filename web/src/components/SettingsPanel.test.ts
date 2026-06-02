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
