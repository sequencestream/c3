/**
 * Minimal SSE reader for the speed test. Pure and incremental: text chunks in,
 * complete `data:` payloads out.
 *
 * Deliberately NOT the relay's `SseChunkParser`. That one drops `[DONE]` because
 * the relay re-emits its own terminator; here the terminator is evidence — "the
 * stream ended properly" versus "the connection just stopped" is the difference
 * between a success sample and a `stream` failure, and a parser that swallows it
 * cannot tell them apart.
 *
 * What it must survive, because real upstreams do all of it: one event split
 * across TCP chunks, several events in one chunk, `:` comment heartbeats, `event:`
 * / `id:` / `retry:` fields, blank keep-alive lines, and CRLF line endings. Field
 * names other than `data` are dropped: every dialect this capability speaks puts
 * its own discriminator inside the JSON payload, so the `event:` line carries no
 * information the payload does not.
 */

/** The sentinel an OpenAI-style stream sends to close: `data: [DONE]`. */
export const SSE_DONE = '[DONE]'

/**
 * Incremental `data:` extractor. Feed it decoded text; it returns the payloads
 * that became complete, in order, and buffers any partial trailing line.
 */
export class SseDataReader {
  private buffer = ''

  /**
   * Consume one decoded chunk. A payload is returned once its line is terminated,
   * so a `data:` line split mid-JSON is held until the rest arrives rather than
   * being parsed as garbage.
   *
   * Empty `data:` lines are dropped (they carry nothing); `[DONE]` is kept.
   */
  push(chunk: string): string[] {
    this.buffer += chunk
    const out: string[] = []
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '')
      this.buffer = this.buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '') continue
      out.push(data)
    }
    return out
  }
}
