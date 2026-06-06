/**
 * In-process Responses→Chat relay for codex (ADR-0014). Codex 0.137 speaks only
 * the OpenAI Responses API on the wire, so a codex agent pointed at a
 * Chat-Completions-only provider (DeepSeek, Kimi, MiMo, MiniMax, …) cannot reach
 * it. Rather than make the user run an external proxy, c3 hosts the translation
 * itself: the codex driver points the CLI's `openai_base_url` at a loopback
 * endpoint on c3's own Hono server, and this relay rewrites the traffic both ways
 * using the pure translator in `./translate.ts`.
 *
 * Design (see {@link createCodexRelay}):
 *  - Per run, the driver `register()`s the REAL upstream `{baseUrl, apiKey}` and
 *    gets back an opaque token; it passes the token to the codex CLI as its API
 *    key (`CODEX_API_KEY`). Codex then sends `Authorization: Bearer <token>` to
 *    the relay, which looks the binding up by token — so the relay stays decoupled
 *    from agent-config and the real key never reaches the codex subprocess.
 *  - The token is a UUID secret; unknown tokens are rejected (defence in depth on
 *    top of loopback binding). The binding is evicted on run end.
 *
 * No vendor SDK type crosses this module (ADR-0009): only JSON shapes and the
 * pure translator. The kernel-facing handle (`CodexRelay`) is the inert
 * register/unregister/baseUrl contract in `kernel/.../relay-contract.ts`; the
 * HTTP `handler` is added here (transport may touch Hono + serialization, kernel
 * may not). The route is mounted in `server.ts` BEFORE the static catch-all.
 */
import type { Context } from 'hono'
import type { CodexRelay, RelayUpstream } from '../../kernel/agent/adapters/codex/relay-contract.js'
import {
  responsesRequestToChat,
  ChatToResponsesConverter,
  SseChunkParser,
  serializeSse,
  type ResponsesRequest,
  type ChatStreamChunk,
} from './translate.js'

export {
  CODEX_RELAY_PROVIDER,
  type CodexRelay,
  type RelayUpstream,
} from '../../kernel/agent/adapters/codex/relay-contract.js'

/** The served relay: the kernel handle plus the HTTP handler the composition root mounts. */
export interface ServedCodexRelay extends CodexRelay {
  /** The Hono handler for `POST <PATH>/responses`. */
  handler(c: Context): Promise<Response>
}

/** The loopback path the relay route is mounted at. */
export const CODEX_RELAY_PATH = '/internal/codex-relay/v1'

/**
 * Build the relay. `origin` is c3's own loopback origin (`http://127.0.0.1:<port>`),
 * so codex's `openai_base_url` becomes `<origin>${CODEX_RELAY_PATH}` and it POSTs
 * to `<origin>${CODEX_RELAY_PATH}/responses`. `makeToken` is injected for tests;
 * it defaults to `crypto.randomUUID`.
 */
export function createCodexRelay(
  origin: string,
  makeToken: () => string = () => crypto.randomUUID(),
): ServedCodexRelay {
  const bindings = new Map<string, RelayUpstream>()
  const baseUrl = `${origin.replace(/\/$/, '')}${CODEX_RELAY_PATH}`

  return {
    baseUrl,
    register(upstream) {
      const token = makeToken()
      bindings.set(token, upstream)
      return token
    },
    unregister(token) {
      bindings.delete(token)
    },
    async handler(c) {
      const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
      const upstream = bindings.get(token)
      if (!upstream) {
        return c.json(
          { error: { message: 'unknown or expired relay token', type: 'c3_relay' } },
          401,
        )
      }

      let reqBody: ResponsesRequest
      try {
        reqBody = (await c.req.json()) as ResponsesRequest
      } catch {
        return c.json({ error: { message: 'invalid JSON body', type: 'c3_relay' } }, 400)
      }

      const chat = responsesRequestToChat(reqBody)
      const url = chatCompletionsUrl(upstream.baseUrl)

      let resp: Response
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'text/event-stream',
            authorization: `Bearer ${upstream.apiKey}`,
          },
          body: JSON.stringify(chat),
          signal: c.req.raw.signal,
        })
      } catch (e) {
        return sseError(c, `upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`)
      }

      if (!resp.ok || !resp.body) {
        const detail = await resp.text().catch(() => '')
        return sseError(c, `upstream ${resp.status}: ${detail.slice(0, 2000)}`)
      }

      const stream = translateStream(resp.body)
      return c.body(stream, 200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
    },
  }
}

/**
 * Resolve a provider base URL to its Chat Completions endpoint. The user
 * configures an OpenAI-style base (`https://api.deepseek.com/`,
 * `https://api.moonshot.ai/v1`, …); normalize to `<base>/chat/completions`,
 * inserting `/v1` only when the base does not already carry a version segment.
 */
export function chatCompletionsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(trimmed)) return trimmed
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

/** Pipe an upstream Chat SSE body through the converter into a Responses SSE body. */
function translateStream(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const parser = new SseChunkParser()
  const conv = new ChatToResponsesConverter()
  const reader = upstream.getReader()
  let preludeSent = false

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let emitted = 0
      const emit = (events: Array<{ type: string } & Record<string, unknown>>) => {
        for (const ev of events) controller.enqueue(encoder.encode(serializeSse(ev)))
        emitted += events.length
      }
      if (!preludeSent) {
        preludeSent = true
        emit(conv.start())
      }
      try {
        // Read until this pull has produced at least one frame (or the stream
        // ends). A chunk that yields no Responses event (a finish-only Chat chunk,
        // `[DONE]`, a keepalive) must NOT return an empty pull — that stalls the
        // consumer, which only re-pulls once the queue drains.
        while (emitted === 0) {
          const { done, value } = await reader.read()
          if (done) {
            emit(conv.done())
            controller.close()
            return
          }
          for (const data of parser.push(decoder.decode(value, { stream: true }))) {
            let chunk: ChatStreamChunk & { error?: { message?: string } }
            try {
              chunk = JSON.parse(data)
            } catch {
              continue // a non-JSON keepalive/comment line; ignore.
            }
            if (chunk.error) {
              emit(conv.fail(chunk.error.message ?? 'upstream error'))
              controller.close()
              return
            }
            emit(conv.consume(chunk))
          }
        }
      } catch (e) {
        emit(conv.fail(e instanceof Error ? e.message : String(e)))
        controller.close()
      }
    },
    cancel() {
      void reader.cancel()
    },
  })
}

/** Return a one-shot Responses SSE body carrying `response.failed` (surfaces the cause to codex). */
function sseError(c: Context, message: string): Response {
  const conv = new ChatToResponsesConverter()
  const frames = [...conv.start(), ...conv.fail(message)]
  const body = frames.map(serializeSse).join('')
  return c.body(body, 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  })
}
