/**
 * Codex prompt-image temp-file lifecycle (2026-06-16). Codex consumes images as
 * filesystem PATHS (`codex exec --image <FILE>`), not inline bytes — so the
 * base64 image data a user attaches must be decoded to disk for the turn, then
 * removed when it ends. This module isolates that write/cleanup pair so the
 * driver stays focused on the event stream and the cleanup is unit-testable.
 *
 * Non-goal: persistence. The files live only for the turn; {@link cleanupImageTempFiles}
 * runs in the driver's `finally` (success, error, or abort) so nothing leaks.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PromptImage } from '@ccc/shared/protocol'

/**
 * Accepted image media type → file extension. Codex sniffs the type partly from
 * the extension, so a faithful suffix helps; an unknown type (should not reach
 * here — the server rejects non-images) falls back to `bin`.
 */
const MEDIA_TYPE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** A written batch of prompt images: the owning temp dir + the per-image paths. */
export interface ImageTempFiles {
  /** The temp directory holding the images (removed wholesale by {@link cleanupImageTempFiles}). */
  readonly dir: string
  /** Absolute paths of the written image files, in input order. */
  readonly paths: string[]
}

/**
 * Decode each prompt image's base64 data into a fresh temp directory and return
 * the directory + the written paths. Returns `null` for an absent/empty image
 * list so the caller can skip both the `--image` args and the cleanup.
 */
export function writeImageTempFiles(images: PromptImage[] | undefined): ImageTempFiles | null {
  if (!images || images.length === 0) return null
  const dir = mkdtempSync(join(tmpdir(), 'c3-codex-img-'))
  const paths = images.map((img, i) => {
    const ext = MEDIA_TYPE_EXT[img.mediaType] ?? 'bin'
    const path = join(dir, `image-${i}.${ext}`)
    writeFileSync(path, Buffer.from(img.data, 'base64'))
    return path
  })
  return { dir, paths }
}

/**
 * Remove the temp directory created by {@link writeImageTempFiles}. Best-effort
 * and idempotent: a `null` handle (no images) is a no-op, and an already-missing
 * dir does not throw (`force`). Safe to call exactly once per turn end.
 */
export function cleanupImageTempFiles(handle: ImageTempFiles | null): void {
  if (!handle) return
  rmSync(handle.dir, { recursive: true, force: true })
}
