/**
 * Runtime log wire messages.
 *
 * Each type is one arm of `ClientToServer` / `ServerToClient`; the unions are
 * assembled in `../protocol.ts`, which is their only definition site. These arm
 * types are internal to the partition and are NOT part of the public
 * `@ccc/shared/protocol` surface.
 */

import type { RuntimeLogChunk } from './log.js'

/**
 * Read the live runtime log. Omitting `offset` asks for the tail (the newest
 * bytes, so a freshly opened viewer shows recent history rather than a blank
 * page); passing the previous reply's `nextOffset` continues from there.
 * `maxBytes` caps one reply and is clamped server-side. Server replies with
 * `runtime_log`.
 */
export type ClientReadRuntimeLog = { type: 'read_runtime_log'; offset?: number; maxBytes?: number }

/** One slice of the live runtime log, answering `read_runtime_log`. */
export type ServerRuntimeLog = { type: 'runtime_log'; chunk: RuntimeLogChunk }
