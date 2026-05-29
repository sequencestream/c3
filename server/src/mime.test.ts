import { describe, it, expect } from 'vitest'
import { mimeFor, DEFAULT_MIME } from './mime.js'

describe('mimeFor', () => {
  it('resolves known extensions', () => {
    expect(mimeFor('/index.html')).toBe('text/html; charset=utf-8')
    expect(mimeFor('/assets/app.js')).toBe('application/javascript; charset=utf-8')
    expect(mimeFor('/assets/app.mjs')).toBe('application/javascript; charset=utf-8')
    expect(mimeFor('/assets/style.css')).toBe('text/css; charset=utf-8')
    expect(mimeFor('/logo.svg')).toBe('image/svg+xml; charset=utf-8')
    expect(mimeFor('/data.json')).toBe('application/json; charset=utf-8')
    expect(mimeFor('/app.js.map')).toBe('application/json; charset=utf-8')
  })

  it('falls back to octet-stream for unknown extensions', () => {
    expect(mimeFor('/file.bin')).toBe(DEFAULT_MIME)
    expect(mimeFor('/archive.tar.gz')).toBe(DEFAULT_MIME)
  })

  it('falls back to octet-stream for paths without an extension', () => {
    expect(mimeFor('/no-extension')).toBe(DEFAULT_MIME)
    expect(mimeFor('/')).toBe(DEFAULT_MIME)
  })

  it('matches extensions case-sensitively (lowercase only)', () => {
    // Node's extname preserves case; our table is lowercase.
    expect(mimeFor('/INDEX.HTML')).toBe(DEFAULT_MIME)
  })
})
