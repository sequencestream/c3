import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import EmojiPicker from './EmojiPicker.vue'

describe('EmojiPicker.vue', () => {
  it('renders the trigger glyph from modelValue, falling back when empty', () => {
    const filled = mount(EmojiPicker, { props: { modelValue: '🦊' } })
    expect(filled.find('[data-testid="emoji-picker-trigger"]').text()).toBe('🦊')

    const empty = mount(EmojiPicker, { props: { modelValue: '' } })
    // Empty value shows a non-empty fallback glyph (so the button is never blank).
    expect(empty.find('[data-testid="emoji-picker-trigger"]').text().length).toBeGreaterThan(0)
  })

  it('starts closed and opens the panel on trigger click', async () => {
    const w = mount(EmojiPicker, { props: { modelValue: '' } })
    expect(w.find('.emoji-panel').exists()).toBe(false)
    await w.find('[data-testid="emoji-picker-trigger"]').trigger('click')
    expect(w.find('.emoji-panel').exists()).toBe(true)
  })

  it('emits update:modelValue with the picked emoji and closes', async () => {
    const w = mount(EmojiPicker, { props: { modelValue: '' } })
    await w.find('[data-testid="emoji-picker-trigger"]').trigger('click')
    const cells = w.findAll('[data-testid="emoji-picker-cell"]')
    expect(cells.length).toBeGreaterThan(0)
    const picked = cells[0].text()
    await cells[0].trigger('click')
    const emitted = w.emitted('update:modelValue') as [string][]
    expect(emitted).toBeTruthy()
    expect(emitted[0][0]).toBe(picked)
    // Panel closes after a pick.
    expect(w.find('.emoji-panel').exists()).toBe(false)
  })

  it('filters by keyword and shows the empty hint when nothing matches', async () => {
    const w = mount(EmojiPicker, { props: { modelValue: '' } })
    await w.find('[data-testid="emoji-picker-trigger"]').trigger('click')

    await w.find('[data-testid="emoji-picker-search"]').setValue('fox')
    const foxCells = w.findAll('[data-testid="emoji-picker-cell"]')
    expect(foxCells.length).toBeGreaterThan(0)
    expect(foxCells.some((c) => c.text() === '🦊')).toBe(true)

    await w.find('[data-testid="emoji-picker-search"]').setValue('zzzznomatch')
    expect(w.findAll('[data-testid="emoji-picker-cell"]')).toHaveLength(0)
    expect(w.find('.emoji-empty').exists()).toBe(true)
  })

  it('closes on Escape', async () => {
    const w = mount(EmojiPicker, { props: { modelValue: '' } })
    await w.find('[data-testid="emoji-picker-trigger"]').trigger('click')
    expect(w.find('.emoji-panel').exists()).toBe(true)
    await w.find('.emoji-picker').trigger('keydown', { key: 'Escape' })
    expect(w.find('.emoji-panel').exists()).toBe(false)
  })
})
