import { describe, it, expect } from 'vitest'
import type { RuntimeLogChunk } from '@ccc/shared/protocol'
import {
  applyLogChunk,
  createLogViewState,
  logViewText,
  type LogViewLimits,
  type LogViewState,
} from './log-view'
import { isNearBottom } from './chat-scroll'

function chunk(text: string, over: Partial<RuntimeLogChunk> = {}): RuntimeLogChunk {
  return {
    text,
    offset: 0,
    nextOffset: text.length,
    size: text.length,
    reset: false,
    available: true,
    ...over,
  }
}

/** Fold a series of chunks from a fresh state. */
function fold(chunks: RuntimeLogChunk[], limits?: LogViewLimits): LogViewState {
  return chunks.reduce((s, c) => applyLogChunk(s, c, limits), createLogViewState())
}

describe('applyLogChunk', () => {
  it('appends whole lines from a continuing chunk', () => {
    const state = fold([chunk('one\ntwo\n', { reset: true }), chunk('three\n', { nextOffset: 14 })])
    expect(state.lines).toEqual(['one', 'two', 'three'])
    expect(state.partial).toBe('')
    expect(state.nextOffset).toBe(14)
  })

  it('joins a line split across two polls instead of showing it twice', () => {
    const state = fold([chunk('half of a li', { reset: true }), chunk('ne\ndone\n')])
    expect(state.lines).toEqual(['half of a line', 'done'])
    expect(logViewText(state)).toBe('half of a line\ndone')
  })

  it('shows a not-yet-terminated line as it arrives', () => {
    const state = fold([chunk('finished\nin progres', { reset: true })])
    expect(state.lines).toEqual(['finished'])
    expect(state.partial).toBe('in progres')
    expect(logViewText(state)).toBe('finished\nin progres')
  })

  it('replaces the buffer on a reset chunk (rotation / first read)', () => {
    const state = fold([chunk('old\n', { reset: true }), chunk('fresh\n', { reset: true })])
    expect(state.lines).toEqual(['fresh'])
  })

  it('leaves the buffer untouched when nothing grew', () => {
    const before = fold([chunk('a\n', { reset: true })])
    const after = applyLogChunk(before, chunk('', { nextOffset: before.nextOffset }))
    expect(after.lines).toEqual(['a'])
    expect(after.nextOffset).toBe(before.nextOffset)
  })

  it('drops the oldest lines past the line cap and flags it', () => {
    const limits = { maxLines: 3, maxChars: 10_000 }
    const state = fold([chunk('1\n2\n3\n4\n5\n', { reset: true })], limits)
    expect(state.lines).toEqual(['3', '4', '5'])
    expect(state.dropped).toBe(true)
  })

  it('drops the oldest lines past the character cap', () => {
    const limits = { maxLines: 1_000, maxChars: 12 }
    const state = fold([chunk('aaaa\nbbbb\ncccc\n', { reset: true })], limits)
    expect(state.lines).toEqual(['bbbb', 'cccc'])
    expect(state.dropped).toBe(true)
  })

  it('keeps a long-open tab bounded across many polls', () => {
    const limits = { maxLines: 50, maxChars: 10_000 }
    let state = createLogViewState()
    for (let i = 0; i < 500; i++) {
      state = applyLogChunk(state, chunk(`line ${i}\n`), limits)
    }
    expect(state.lines).toHaveLength(50)
    expect(state.lines.at(-1)).toBe('line 499')
  })

  it('keeps the dropped flag once history has been thrown away', () => {
    const limits = { maxLines: 2, maxChars: 10_000 }
    const trimmed = fold([chunk('1\n2\n3\n', { reset: true })], limits)
    const later = applyLogChunk(trimmed, chunk('4\n'), limits)
    expect(later.dropped).toBe(true)
  })

  it('keeps the newest tail of an over-long partial and flags it', () => {
    const limits = { maxLines: 100, maxChars: 5 }
    const state = fold([chunk('abcdefgh', { reset: true })], limits)
    expect(state.lines).toEqual([])
    expect(state.partial).toBe('defgh')
    expect(state.dropped).toBe(true)
    expect(logViewText(state)).toBe('defgh')
  })

  it('bounds a partial that never hits a newline across many polls', () => {
    const limits = { maxLines: 100, maxChars: 10 }
    let state = createLogViewState()
    for (let i = 0; i < 200; i++) {
      state = applyLogChunk(state, chunk('x'), limits)
    }
    expect(state.lines).toHaveLength(0)
    expect(state.partial).toHaveLength(10)
    expect(state.dropped).toBe(true)
  })

  it('shares one char budget between complete lines and the partial', () => {
    const limits = { maxLines: 1_000, maxChars: 10 }
    // Nearly maxChars of complete lines followed by nearly maxChars of a
    // not-yet-terminated line: the rendered text must stay within maxChars,
    // not close to 2×maxChars.
    const state = fold([chunk('123456789\nabcdefghij', { reset: true })], limits)
    expect(logViewText(state).length).toBeLessThanOrEqual(limits.maxChars)
    // The newest tail wins — the partial is newer than every complete line.
    expect(state.lines).toEqual([])
    expect(state.partial).toBe('abcdefghij')
    expect(logViewText(state)).toBe('abcdefghij')
  })

  it('splits the shared budget when both lines and partial are present', () => {
    const limits = { maxLines: 1_000, maxChars: 15 }
    const state = fold([chunk('aaaaaa\nbbbbbb\ncccc', { reset: true })], limits)
    expect(logViewText(state).length).toBeLessThanOrEqual(limits.maxChars)
    expect(logViewText(state)).toBe('bbbbbb\ncccc')
    expect(state.dropped).toBe(true)
  })

  it('keeps the rendered text within the budget across many polls', () => {
    const limits = { maxLines: 1_000, maxChars: 100 }
    let state = createLogViewState()
    for (let i = 0; i < 300; i++) {
      state = applyLogChunk(state, chunk(`${'x'.repeat(40)}\npartial-${i}`), limits)
    }
    expect(logViewText(state).length).toBeLessThanOrEqual(limits.maxChars)
  })

  it('empties the view when the server has no live log file', () => {
    const before = fold([chunk('a\n', { reset: true })])
    const after = applyLogChunk(before, chunk('', { available: false, reset: true }))
    expect(after.available).toBe(false)
    expect(after.lines).toEqual([])
    expect(logViewText(after)).toBe('')
  })
})

describe('following the tail', () => {
  it('follows while the viewport sits at the bottom, stops once scrolled up', () => {
    expect(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 })).toBe(true)
    expect(isNearBottom({ scrollTop: 200, scrollHeight: 1000, clientHeight: 100 })).toBe(false)
  })
})
