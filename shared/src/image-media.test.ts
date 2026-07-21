import { describe, it, expect } from 'vitest'
import { IMAGE_MEDIA_TYPES } from './protocol.js'
import { isImageMediaType } from './image-media.js'

describe('isImageMediaType — prompt-image boundary guard (2026-06-16)', () => {
  it('accepts every declared image media type', () => {
    for (const t of IMAGE_MEDIA_TYPES) expect(isImageMediaType(t)).toBe(true)
  })

  it('rejects non-image media types (the server refuses these attachments)', () => {
    expect(isImageMediaType('application/pdf')).toBe(false)
    expect(isImageMediaType('text/plain')).toBe(false)
    expect(isImageMediaType('image/svg+xml')).toBe(false) // not in the allowlist
    expect(isImageMediaType('')).toBe(false)
  })
})
