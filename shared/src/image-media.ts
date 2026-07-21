/**
 * Prompt-image boundary guard shared by the server ingress and the web composer.
 * The accepted media-type list itself is wire contract ({@link IMAGE_MEDIA_TYPES}
 * in `protocol.ts`); the narrowing rule lives here.
 */
import type { ImageMediaType } from './protocol.js'
import { IMAGE_MEDIA_TYPES } from './protocol.js'

/** Narrow an arbitrary media type to an accepted {@link ImageMediaType}. */
export function isImageMediaType(mediaType: string): mediaType is ImageMediaType {
  return (IMAGE_MEDIA_TYPES as readonly string[]).includes(mediaType)
}
