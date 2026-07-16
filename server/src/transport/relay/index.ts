/**
 * In-process, vendor-neutral provider relay. Every vendor CLI's provider traffic
 * is routed to a loopback endpoint on c3's own Hono server instead of connecting
 * upstream directly, so the real provider key never reaches the vendor subprocess
 * / sandbox — the CLI only ever holds a per-run opaque token.
 *
 * Design (see {@link createRelay}):
 *  - Per run, the launch site `register()`s an ORDERED CANDIDATE LIST (each entry a
 *    real upstream `{baseUrl, apiKey, model, wireApi?}`) and gets back a token; it
 *    passes the token to the vendor CLI as its API key. The CLI then sends
 *    `Authorization: Bearer <token>` (codex) / `x-api-key: <token>` (claude) to the
 *    relay, which looks the binding up by token — so the relay stays decoupled from
 *    agent-config and the real key never reaches the subprocess.
 *  - A request tries candidates in priority order. Failover happens ONLY before the
 *    first response byte reaches the CLI (connection error / upstream 5xx / 429 ⇒
 *    next candidate; other 4xx ⇒ surface). Once streaming starts, an upstream break
 *    ends the request as an error — no mid-stream candidate switch.
 *  - The relay overrides each request's `model` with the hit candidate's real model,
 *    so failover across candidates with different models is transparent to the CLI.
 *
 * Per-vendor endpoints (the wire protocols differ; the token mechanism is shared):
 *  - codex:  `POST /internal/relay/v1/codex/responses`  (+ legacy alias
 *            `POST /internal/codex-relay/v1/responses`)  — Responses↔Chat translate
 *            (`wireApi=chat`) or passthrough (`responses`).
 *  - claude: `POST /internal/relay/v1/anthropic/v1/messages` — anthropic-compat
 *            passthrough (auth swap + model override).
 *
 * No vendor SDK type crosses this module (ADR-0009): only JSON shapes and the pure
 * codex translator. The kernel-facing handle ({@link Relay}) is the inert
 * register/unregister/endpoint contract in `kernel/relay/contract.ts`; the HTTP
 * handlers are added here (transport may touch Hono + serialization, kernel may
 * not). The routes are mounted in `server.ts` BEFORE the static catch-all.
 */
import type { Context } from 'hono'
import type { VendorId } from '@ccc/shared/protocol'
import type { Relay, RelayCandidate } from '../../kernel/relay/contract.js'
import { isDegradableError } from '../../kernel/agent-config/errors.js'
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
  type Relay,
  type RelayCandidate,
} from '../../kernel/relay/contract.js'

/** The served relay: the kernel handle plus the HTTP handlers the composition root mounts. */
export interface ServedRelay extends Relay {
  /** The Hono handler for the codex endpoint (`POST <CODEX>/responses`). */
  codexHandler(c: Context): Promise<Response>
  /** The Hono handler for the anthropic endpoint (`POST <ANTHROPIC>/v1/messages`). */
  anthropicHandler(c: Context): Promise<Response>
}

/** Loopback path prefix for the vendor-neutral relay endpoints. */
export const RELAY_PATH_PREFIX = '/internal/relay/v1'
/** codex endpoint base: the CLI's provider `base_url`; codex POSTs `<base>/responses`. */
export const RELAY_CODEX_PATH = `${RELAY_PATH_PREFIX}/codex`
/** claude endpoint base: `ANTHROPIC_BASE_URL`; the SDK POSTs `<base>/v1/messages`. */
export const RELAY_ANTHROPIC_PATH = `${RELAY_PATH_PREFIX}/anthropic`
/** Legacy codex alias kept for one transition window (was the codex-only relay path). */
export const CODEX_RELAY_LEGACY_PATH = '/internal/codex-relay/v1'

/**
 * Build the relay. `origin` is c3's own loopback origin (`http://127.0.0.1:<port>`).
 * `makeToken` is injected for tests; it defaults to `crypto.randomUUID`.
 */
export function createRelay(
  origin: string,
  makeToken: () => string = () => crypto.randomUUID(),
): ServedRelay {
  const base = origin.replace(/\/$/, '')
  const bindings = new Map<string, RelayCandidate[]>()

  const endpoint = (vendor: VendorId): string =>
    vendor === 'codex' ? `${base}${RELAY_CODEX_PATH}` : `${base}${RELAY_ANTHROPIC_PATH}`

  const candidatesFor = (c: Context, scheme: 'bearer' | 'x-api-key'): RelayCandidate[] | null => {
    const token =
      scheme === 'x-api-key'
        ? (c.req.header('x-api-key') ?? '').trim() ||
          (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
        : (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    const cands = token ? bindings.get(token) : undefined
    return cands && cands.length > 0 ? cands : null
  }

  return {
    endpoint,
    register(candidates) {
      const token = makeToken()
      bindings.set(token, candidates)
      return token
    },
    unregister(token) {
      bindings.delete(token)
    },

    async codexHandler(c) {
      const candidates = candidatesFor(c, 'bearer')
      if (!candidates) {
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

      const result = await fetchWithFailover(candidates, c.req.raw.signal, (cand) => {
        const headers = {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${cand.apiKey}`,
        }
        // `responses` upstreams serve OpenAI Responses natively ⇒ passthrough the
        // original request (only the model is overridden). `chat` upstreams are
        // Chat-Completions-only ⇒ translate the request to Chat.
        if (cand.wireApi === 'responses') {
          const body = cand.model ? { ...reqBody, model: cand.model } : reqBody
          return {
            url: responsesUrl(cand.baseUrl),
            init: { method: 'POST', headers, body: JSON.stringify(body) },
          }
        }
        const chat = responsesRequestToChat(reqBody)
        if (cand.model) chat.model = cand.model
        return {
          url: chatCompletionsUrl(cand.baseUrl),
          init: { method: 'POST', headers, body: JSON.stringify(chat) },
        }
      })
      if ('error' in result) return codexSseError(c, result.error)

      // `responses` upstream ⇒ stream verbatim; `chat` upstream ⇒ translate its
      // Chat SSE back into the Responses SSE codex expects.
      const stream =
        result.cand.wireApi === 'responses' ? result.resp.body! : translateStream(result.resp.body!)
      return c.body(stream, 200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
    },

    async anthropicHandler(c) {
      const candidates = candidatesFor(c, 'x-api-key')
      if (!candidates) {
        return c.json(
          {
            type: 'error',
            error: { type: 'authentication_error', message: 'unknown or expired relay token' },
          },
          401,
        )
      }

      let reqBody: Record<string, unknown>
      try {
        reqBody = (await c.req.json()) as Record<string, unknown>
      } catch {
        return c.json(
          { type: 'error', error: { type: 'invalid_request_error', message: 'invalid JSON body' } },
          400,
        )
      }
      const version = c.req.header('anthropic-version') ?? '2023-06-01'
      const beta = c.req.header('anthropic-beta')

      const result = await fetchWithFailover(candidates, c.req.raw.signal, (cand) => {
        const body = cand.model ? { ...reqBody, model: cand.model } : reqBody
        const headers: Record<string, string> = {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'anthropic-version': version,
          'x-api-key': cand.apiKey,
          authorization: `Bearer ${cand.apiKey}`,
        }
        if (beta) headers['anthropic-beta'] = beta
        return {
          url: anthropicMessagesUrl(cand.baseUrl),
          init: { method: 'POST', headers, body: JSON.stringify(body) },
        }
      })
      if ('error' in result) return anthropicSseError(c, result.error)

      // Anthropic-compat passthrough: stream the upstream SSE body verbatim.
      return c.body(result.resp.body!, 200, {
        'content-type':
          result.resp.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
    },
  }
}

/**
 * Try each candidate in priority order; return the first upstream `Response` that
 * is OK with a body, or an `{ error }` when every candidate is exhausted. Failover
 * before the first byte only: a connection error (thrown fetch) and an upstream
 * `5xx`/`429` advance to the next candidate; any other `4xx` (400/401/403 — a
 * request-level or credential problem no sibling can fix) surfaces immediately.
 * The single "what counts as a switchable failure" verdict is kept aligned with
 * the agent-config degradation rule via {@link isDegradableError} for thrown errors.
 */
async function fetchWithFailover(
  candidates: RelayCandidate[],
  signal: AbortSignal,
  build: (cand: RelayCandidate) => { url: string; init: RequestInit },
): Promise<{ resp: Response; cand: RelayCandidate } | { error: string }> {
  let lastError = 'relay: no candidates bound'
  for (const cand of candidates) {
    const { url, init } = build(cand)
    let resp: Response
    try {
      resp = await fetch(url, { ...init, signal })
    } catch (e) {
      lastError = `upstream fetch failed: ${e instanceof Error ? e.message : String(e)}`
      // Connection-level failures are switchable — try the next candidate. Keep the
      // verdict aligned with the degradation rule; connection errors match it.
      if (isDegradableError(lastError)) continue
      return { error: lastError }
    }
    if (resp.ok && resp.body) return { resp, cand }
    const detail = await resp.text().catch(() => '')
    lastError = `upstream ${resp.status}: ${detail.slice(0, 2000)}`
    // 5xx / 429 ⇒ capacity/availability, a sibling may serve it. Other 4xx ⇒ the
    // request or this candidate's credential is at fault; no sibling helps.
    if (resp.status === 429 || resp.status >= 500) continue
    return { error: lastError }
  }
  return { error: lastError }
}

/** Resolve a codex-native (Responses) provider base to its `/responses` endpoint. */
export function responsesUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  if (/\/responses$/.test(trimmed)) return trimmed
  return `${trimmed}/responses`
}

/**
 * Resolve a provider base URL to its Chat Completions endpoint. The user configures
 * an OpenAI-style base (`https://api.deepseek.com/`, `https://api.moonshot.ai/v1`,
 * …); normalize to `<base>/chat/completions`, inserting `/v1` only when the base
 * does not already carry a version segment.
 */
export function chatCompletionsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(trimmed)) return trimmed
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`
  return `${trimmed}/v1/chat/completions`
}

/**
 * Resolve an anthropic-compat provider base to its Messages endpoint. The user
 * configures an anthropic gateway base (`https://api.deepseek.com/anthropic`); the
 * claude SDK would POST `<ANTHROPIC_BASE_URL>/v1/messages`, so mirror that shape
 * onto the real base.
 */
export function anthropicMessagesUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  if (/\/v1\/messages$/.test(trimmed)) return trimmed
  return `${trimmed}/v1/messages`
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
        // Read until this pull has produced at least one frame (or the stream ends).
        // A chunk that yields no Responses event (a finish-only Chat chunk, `[DONE]`,
        // a keepalive) must NOT return an empty pull — that stalls the consumer,
        // which only re-pulls once the queue drains.
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
function codexSseError(c: Context, message: string): Response {
  const conv = new ChatToResponsesConverter()
  const frames = [...conv.start(), ...conv.fail(message)]
  const body = frames.map(serializeSse).join('')
  return c.body(body, 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  })
}

/** Return a one-shot Anthropic SSE body carrying an `error` event (surfaces the cause to claude). */
function anthropicSseError(c: Context, message: string): Response {
  const payload = JSON.stringify({ type: 'error', error: { type: 'api_error', message } })
  const body = `event: error\ndata: ${payload}\n\n`
  return c.body(body, 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
  })
}
