import { describe, it, expect } from 'vitest'
import { normalizeTranscriptText, stringifyToolResult } from './format.js'

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

describe('normalizeTranscriptText', () => {
  it('leaves plain text without wrapper tags unchanged', () => {
    expect(normalizeTranscriptText('just a normal message')).toBe('just a normal message')
    expect(normalizeTranscriptText('a < b and c > d')).toBe('a < b and c > d')
  })

  it('collapses a slash-command invocation to a single line', () => {
    const text =
      '<command-name>/clear</command-name>\n' +
      '            <command-message>clear</command-message>\n' +
      '            <command-args></command-args>'
    expect(normalizeTranscriptText(text)).toBe('/clear')
  })

  it('keeps command args on the synthesized line', () => {
    const text =
      '<command-name>/init</command-name>\n' +
      '<command-message>init</command-message>\n' +
      '<command-args>--force</command-args>'
    expect(normalizeTranscriptText(text)).toBe('/init --force')
  })

  it('unwraps local-command stdout, keeping the inner text', () => {
    const text =
      '<command-name>/foo</command-name>\n' +
      '<command-args></command-args>\n' +
      '<local-command-stdout>line one\nline two</local-command-stdout>'
    expect(normalizeTranscriptText(text)).toBe('/foo\nline one\nline two')
  })

  it('strips caveat and system-reminder blocks', () => {
    const text =
      '<local-command-caveat>Caveat: ignore this.</local-command-caveat>\n' +
      '<command-name>/clear</command-name>'
    expect(normalizeTranscriptText(text)).toBe('/clear')
  })

  it('returns an empty string when only noise blocks remain', () => {
    expect(
      normalizeTranscriptText('<local-command-caveat>Caveat: nothing here.</local-command-caveat>'),
    ).toBe('')
    expect(normalizeTranscriptText('<system-reminder>be nice</system-reminder>')).toBe('')
  })
})
