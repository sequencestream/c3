/*
 * textarea — shared, DOM-less geometry helpers for auto-growing textareas.
 *
 * Used by any composer/form textarea that should grow with its content up to a
 * pixel cap and then scroll internally (the bottom MessageInput composer, the
 * discussion create-form Goal/Context fields, …). Kept pure so it is unit-tested
 * without a DOM; the component reads `scrollHeight` (after resetting `height` to
 * `auto`) and applies the returned `height`/`overflowY`.
 */

/**
 * Auto-grow geometry for a textarea: given its natural content height
 * (`scrollHeight`, measured after resetting `height` to `auto`) and a pixel cap,
 * return the height to apply and whether an inner scrollbar is needed. The
 * textarea grows with its content up to `maxPx`; beyond that it stays fixed and
 * scrolls internally.
 */
export interface AutoGrowStyle {
  height: number
  overflowY: 'auto' | 'hidden'
}

export function autoGrowHeight(scrollHeight: number, maxPx: number): AutoGrowStyle {
  return {
    height: Math.min(scrollHeight, maxPx),
    overflowY: scrollHeight > maxPx ? 'auto' : 'hidden',
  }
}
