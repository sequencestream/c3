import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { PersonalizedSettings } from '@ccc/shared/protocol'
import PersonalizedSetting from './PersonalizedSetting.vue'
import { useAuth } from '@/composables/useAuth'

function mountPage(settings: PersonalizedSettings = { uiLang: 'zh' }) {
  return mount(PersonalizedSetting, { props: { open: true, settings } })
}

describe('PersonalizedSetting.vue — display language', () => {
  it('seeds the select from the resolved settings', () => {
    const select = mountPage().find<HTMLSelectElement>('[data-testid="personalized-ui-lang"]')
    expect(select.exists()).toBe(true)
    expect(select.element.value).toBe('zh')
  })

  it('defaults to en when no language is resolved yet', () => {
    const select = mountPage({}).find<HTMLSelectElement>('[data-testid="personalized-ui-lang"]')
    expect(select.element.value).toBe('en')
  })

  it('offers the same language list the settings panel used to (all human-reviewed)', () => {
    const values = mountPage()
      .findAll('[data-testid="personalized-ui-lang"] option')
      .map((o) => (o.element as HTMLOptionElement).value)
    expect(values).toEqual(['en', 'zh', 'ja', 'ko', 'ru'])
  })

  it('emits set-ui-lang immediately on change (no Save button exists)', async () => {
    const w = mountPage()
    await w.find('[data-testid="personalized-ui-lang"]').setValue('en')
    expect(w.emitted('set-ui-lang')).toEqual([['en']])
    expect(w.find('[data-testid="personalized-setting-save"]').exists()).toBe(false)
  })
})

describe('PersonalizedSetting.vue — reachability', () => {
  it('renders nothing while closed', () => {
    const w = mount(PersonalizedSetting, { props: { open: false, settings: { uiLang: 'zh' } } })
    expect(w.find('[data-testid="personalized-setting-page"]').exists()).toBe(false)
  })

  it('stays fully editable for a non-admin (this domain has no admin gate)', () => {
    useAuth().setIsAdmin(false)
    try {
      const w = mountPage()
      expect(w.find('[data-testid="personalized-setting-page"]').exists()).toBe(true)
      const select = w.find('[data-testid="personalized-ui-lang"]')
      expect(select.attributes()).not.toHaveProperty('disabled')
    } finally {
      useAuth().setIsAdmin(true)
    }
  })

  it('emits close from both the header and the footer control', async () => {
    const w = mountPage()
    await w.find('.settings-head .icon-btn').trigger('click')
    await w.find('[data-testid="personalized-setting-close"]').trigger('click')
    expect(w.emitted('close')).toHaveLength(2)
  })
})

describe('PersonalizedSetting.vue — copy', () => {
  it('ships matching English and Chinese copy for the moved language setting', () => {
    const base = resolve(__dirname, '../../locales')
    const en = JSON.parse(readFileSync(resolve(base, 'en.json'), 'utf8'))
    const zh = JSON.parse(readFileSync(resolve(base, 'zh.json'), 'utf8'))
    expect(en.personalizedSetting.displayLang.title.label).toBe('Display language')
    expect(zh.personalizedSetting.displayLang.title.label).toBe('显示语言')
    // The system-settings namespace no longer owns the display language.
    expect(en.settings.displayLang).toBeUndefined()
    expect(zh.settings.displayLang).toBeUndefined()
  })
})
