/**
 * Codex prompt-image temp-file lifecycle tests (2026-06-16). Covers the
 * write→decode→cleanup pair the driver leans on so a turn's images land on disk
 * as `--image` targets and leave no residue when the turn ends.
 */
import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import type { PromptImage } from '@ccc/shared/protocol'
import { writeImageTempFiles, cleanupImageTempFiles } from './image-files.js'

function img(mediaType: string, text: string): PromptImage {
  return { mediaType, data: Buffer.from(text).toString('base64') }
}

describe('writeImageTempFiles', () => {
  it('returns null for an absent or empty image list (no temp dir, nothing to clean)', () => {
    expect(writeImageTempFiles(undefined)).toBeNull()
    expect(writeImageTempFiles([])).toBeNull()
  })

  it('decodes each base64 image to a temp file with a media-type extension', () => {
    const handle = writeImageTempFiles([
      img('image/png', 'PNGBYTES'),
      img('image/jpeg', 'JPGBYTES'),
    ])
    try {
      expect(handle).not.toBeNull()
      expect(handle!.paths).toHaveLength(2)
      // Extensions track the media type (png/jpg), so codex can sniff the kind.
      expect(handle!.paths[0].endsWith('.png')).toBe(true)
      expect(handle!.paths[1].endsWith('.jpg')).toBe(true)
      // The bytes round-trip from base64 to disk.
      expect(readFileSync(handle!.paths[0]).toString()).toBe('PNGBYTES')
      expect(readFileSync(handle!.paths[1]).toString()).toBe('JPGBYTES')
      // Both files live under the one temp dir the handle owns.
      expect(readdirSync(handle!.dir)).toHaveLength(2)
    } finally {
      cleanupImageTempFiles(handle)
    }
  })

  it('maps gif/webp/unknown media types to the right extension', () => {
    const handle = writeImageTempFiles([
      img('image/gif', 'g'),
      img('image/webp', 'w'),
      img('application/octet-stream', 'x'),
    ])
    try {
      expect(handle!.paths[0].endsWith('.gif')).toBe(true)
      expect(handle!.paths[1].endsWith('.webp')).toBe(true)
      // An unexpected type (should be rejected upstream) falls back to .bin.
      expect(handle!.paths[2].endsWith('.bin')).toBe(true)
    } finally {
      cleanupImageTempFiles(handle)
    }
  })
})

describe('cleanupImageTempFiles', () => {
  it('removes the temp dir and every written file', () => {
    const handle = writeImageTempFiles([img('image/png', 'a'), img('image/png', 'b')])!
    expect(existsSync(handle.dir)).toBe(true)
    cleanupImageTempFiles(handle)
    expect(existsSync(handle.dir)).toBe(false)
    for (const p of handle.paths) expect(existsSync(p)).toBe(false)
  })

  it('is a no-op for a null handle and idempotent on a removed dir', () => {
    expect(() => cleanupImageTempFiles(null)).not.toThrow()
    const handle = writeImageTempFiles([img('image/png', 'a')])!
    cleanupImageTempFiles(handle)
    // A second cleanup of an already-removed dir does not throw (force).
    expect(() => cleanupImageTempFiles(handle)).not.toThrow()
  })
})
