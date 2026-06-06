import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import EmojiPicker from './EmojiPicker.vue'

describe('EmojiPicker.vue', () => {
  it('renders the current icon value on the trigger button', () => {
    const filled = mount(EmojiPicker, { props: { modelValue: '🦊' } })
    expect(filled.find('[data-testid="emoji-picker-trigger"]').text()).toBe('🦊')

    // Empty value falls back to the placeholder glyph on the button.
    const empty = mount(EmojiPicker, { props: { modelValue: '' } })
    expect(empty.find('[data-testid="emoji-picker-trigger"]').text()).toBe('🤖')
  })

  it('starts closed and opens the modal when the trigger button is clicked', async () => {
    const w = mount(EmojiPicker, { props: { modelValue: '' } })
    expect(w.find('.emoji-panel').exists()).toBe(false)
    await w.find('[data-testid="emoji-picker-trigger"]').trigger('click')
    expect(w.find('.emoji-panel').exists()).toBe(true)
  })

  it('toggles the modal closed on a second trigger click', async () => {
    const w = mount(EmojiPicker, { props: { modelValue: '' } })
    await w.find('[data-testid="emoji-picker-trigger"]').trigger('click')
    expect(w.find('.emoji-panel').exists()).toBe(true)
    await w.find('[data-testid="emoji-picker-trigger"]').trigger('click')
    expect(w.find('.emoji-panel').exists()).toBe(false)
  })

  it('emits update:modelValue on manual typing without closing the modal', async () => {
    const w = mount(EmojiPicker, { props: { modelValue: '' } })
    await w.find('[data-testid="emoji-picker-trigger"]').trigger('click')
    await w.find('[data-testid="emoji-picker-manual"]').setValue('🦊')
    const emitted = w.emitted('update:modelValue') as [string][]
    expect(emitted).toBeTruthy()
    expect(emitted[emitted.length - 1][0]).toBe('🦊')
    // Manual edits keep the modal open.
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
    expect(emitted[emitted.length - 1][0]).toBe(picked)
    // Modal closes after a pick.
    expect(w.find('.emoji-panel').exists()).toBe(false)
  })

  it('exposes a large emoji set (500+)', async () => {
    const w = mount(EmojiPicker, { props: { modelValue: '' } })
    await w.find('[data-testid="emoji-picker-trigger"]').trigger('click')
    expect(w.findAll('[data-testid="emoji-picker-cell"]').length).toBeGreaterThan(500)
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

  it('closes when the backdrop is clicked', async () => {
    const w = mount(EmojiPicker, { props: { modelValue: '' } })
    await w.find('[data-testid="emoji-picker-trigger"]').trigger('click')
    expect(w.find('.emoji-panel').exists()).toBe(true)
    await w.find('[data-testid="emoji-picker-overlay"]').trigger('pointerdown')
    expect(w.find('.emoji-panel').exists()).toBe(false)
  })

  it('closes on Escape', async () => {
    const w = mount(EmojiPicker, { props: { modelValue: '' } })
    await w.find('[data-testid="emoji-picker-trigger"]').trigger('click')
    expect(w.find('.emoji-panel').exists()).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await w.vm.$nextTick()
    expect(w.find('.emoji-panel').exists()).toBe(false)
  })
})
