import { describe, it, expect } from 'vitest'
import { stringifyToolResult } from './format.js'

describe('stringifyToolResult', () => {
  it('returns plain strings unchanged', () => {
    expect(stringifyToolResult('hello')).toBe('hello')
    expect(stringifyToolResult('')).toBe('')
  })

  it('joins text blocks with newlines', () => {
    const content = [
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
    ]
    expect(stringifyToolResult(content)).toBe('line one\nline two')
  })

  it('JSON-stringifies non-text blocks within an array', () => {
    const img = { type: 'image', source: { data: 'abc' } }
    const content = [{ type: 'text', text: 'caption' }, img]
    expect(stringifyToolResult(content)).toBe(`caption\n${JSON.stringify(img)}`)
  })

  it('treats a text block missing its text field as a non-text block', () => {
    const block = { type: 'text' }
    expect(stringifyToolResult([block])).toBe(JSON.stringify(block))
  })

  it('JSON-stringifies non-string, non-array content', () => {
    expect(stringifyToolResult({ ok: true })).toBe('{"ok":true}')
    expect(stringifyToolResult(42)).toBe('42')
    expect(stringifyToolResult(null)).toBe('null')
  })

  it('returns an empty string for an empty array', () => {
    expect(stringifyToolResult([])).toBe('')
  })
})
