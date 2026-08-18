/**
 * Runtime log (`c3.log`) wire model — the read-only view of the server's live
 * log file the console renders.
 *
 * Only the live file is modeled: dated archives and the daemon log are out of
 * the contract. Content is opaque text (already timestamp-prefixed by the
 * logger), transferred as byte-offset slices so a poller ships only what grew.
 */

/** One byte-offset slice of the live runtime log. */
export interface RuntimeLogChunk {
  /** Byte offset `text` starts at in the file. */
  offset: number
  /** Byte offset to send back on the next poll to continue from here. */
  nextOffset: number
  /** Current size of the live log file in bytes. */
  size: number
  /** UTF-8 text of the slice; empty when nothing grew (or no log file exists). */
  text: string
  /**
   * `true` when this slice does NOT continue the requested offset — the first
   * read of a poller, or the file having been rotated/truncated under it. The
   * client replaces its buffer with `text` instead of appending.
   */
  reset: boolean
  /** `false` when no live log file exists (file logging degraded to off). */
  available: boolean
}
