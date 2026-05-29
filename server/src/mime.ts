/**
 * Static-asset MIME type resolution by file extension.
 * Kept dependency-free so it can be unit-tested in isolation.
 */
import { extname } from 'node:path'

export const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

export const DEFAULT_MIME = 'application/octet-stream'

/** Resolve a Content-Type for a path; falls back to octet-stream for unknown extensions. */
export function mimeFor(path: string): string {
  return MIME_BY_EXT[extname(path)] ?? DEFAULT_MIME
}
