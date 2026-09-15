/**
 * The three upstream dialects the speed test speaks, each reduced to two things:
 * how to phrase the calibrated request, and how to read its stream.
 *
 * The dialect is DERIVED from the saved provider, never chosen by the operator —
 * `anthropic` slot ⇒ Messages; `openai` slot ⇒ Responses or Chat Completions
 * strictly per the saved `wireApi`, which is exactly how an agent's traffic would
 * be routed. The test never downgrades Responses to Chat because a parameter was
 * rejected: a refusal IS the measurement's answer, and is recorded as the HTTP
 * status it really was.
 *
 * Reading a stream comes down to three questions, and every dialect answers all
 * three or the sample is a failure:
 *
 *  - **When did visible text first appear?** Only a text delta with a non-empty
 *    string starts the clock. Role prefaces, heartbeats, reasoning events, tool
 *    events and usage-only tails are not text, so they never fake a fast TTFT.
 *  - **How many output tokens were produced?** The protocol's own terminal usage
 *    wins. Only when it is missing do we fall back to counting delta events, and
 *    that fallback is labelled `delta_estimate` everywhere it surfaces.
 *  - **Did the stream END, or merely STOP?** Each dialect has a specific
 *    terminator. Without it — or with an in-band error — the request failed, even
 *    if plenty of text had already arrived.
 *
 * No key, URL or generated text leaves this module; it deals in parsed events.
 */
import {
  SPEED_TEST_MAX_OUTPUT_TOKENS,
  SPEED_TEST_PROMPT,
  SPEED_TEST_TEMPERATURE,
  type ModelProvider,
  type ProtocolType,
  type SpeedTestApiDialect,
} from '@ccc/shared/protocol'
import {
  anthropicMessagesUrl,
  chatCompletionsUrl,
  responsesUrl,
} from '../../../kernel/relay/endpoints.js'
import { SSE_DONE } from './sse.js'

/**
 * Which dialect a saved provider's chosen slot speaks. `wireApi` is consulted ONLY
 * for the openai slot (it is an OpenAI-side concept); anything other than an
 * explicit `'responses'` — including absent — means Chat Completions, matching the
 * third-party-gateway default the rest of c3 assumes.
 */
export function apiDialectFor(
  provider: Pick<ModelProvider, 'wireApi'>,
  protocolType: ProtocolType,
): SpeedTestApiDialect {
  if (protocolType === 'anthropic') return 'messages'
  return provider.wireApi === 'responses' ? 'responses' : 'chat'
}

/** The fully-formed upstream call for one calibrated request. */
export interface DialectRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * Phrase the calibrated request for one dialect. Carries no conversation history,
 * no system prompt, no tools, no reasoning configuration and no store/conversation
 * linkage — a request whose shape varies is a request whose timings cannot be
 * compared.
 */
export function buildRequest(
  dialect: SpeedTestApiDialect,
  baseUrl: string,
  apiKey: string,
  model: string,
): DialectRequest {
  const json = { 'content-type': 'application/json', accept: 'text/event-stream' }
  switch (dialect) {
    case 'chat':
      return {
        url: chatCompletionsUrl(baseUrl),
        headers: { ...json, authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          stream: true,
          // Ask for the terminal usage block explicitly: without it most Chat
          // gateways send none and every sample degrades to a delta estimate.
          stream_options: { include_usage: true },
          temperature: SPEED_TEST_TEMPERATURE,
          max_tokens: SPEED_TEST_MAX_OUTPUT_TOKENS,
          messages: [{ role: 'user', content: SPEED_TEST_PROMPT }],
        }),
      }
    case 'responses':
      return {
        url: responsesUrl(baseUrl),
        headers: { ...json, authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          stream: true,
          temperature: SPEED_TEST_TEMPERATURE,
          max_output_tokens: SPEED_TEST_MAX_OUTPUT_TOKENS,
          // A measurement must not leave a conversation artifact behind upstream.
          store: false,
          input: [{ role: 'user', content: SPEED_TEST_PROMPT }],
        }),
      }
    case 'messages':
      return {
        url: anthropicMessagesUrl(baseUrl),
        headers: {
          ...json,
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          stream: true,
          temperature: SPEED_TEST_TEMPERATURE,
          max_tokens: SPEED_TEST_MAX_OUTPUT_TOKENS,
          messages: [{ role: 'user', content: SPEED_TEST_PROMPT }],
        }),
      }
  }
}

/** What one SSE payload meant to a dialect reader. */
export type StreamSignal =
  /** Nothing relevant (heartbeat, role preface, reasoning, unparsable noise). */
  | { kind: 'ignore' }
  /** A text delta with a non-empty string — the only thing that starts the TTFT clock. */
  | { kind: 'text' }
  /** The stream ended properly. `usageTokens` is the terminal count, when supplied. */
  | { kind: 'end'; usageTokens: number | null }
  /** The stream reported failure in-band. */
  | { kind: 'error' }

/**
 * Stateful reader for one request's stream. `push` is called with each `data:`
 * payload in arrival order; the caller times the first `text` signal and stops at
 * the first `end` or `error`.
 */
export interface StreamReader {
  push(data: string): StreamSignal
  /** Non-empty text delta EVENTS seen so far — the `delta_estimate` fallback. */
  readonly deltaCount: number
}

/** Parse a payload, or `null` when it is not JSON we can read. */
function parse(data: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(data)
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A usage count is only usable when it is a finite, non-negative integer. */
function usageCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

/**
 * OpenAI Chat Completions. Text is `choices[0].delta.content`; usage rides a late
 * chunk (whose `choices` is empty) and is remembered until `[DONE]` closes the
 * stream — hence usage first, terminator second, exactly as the wire sends them.
 */
class ChatReader implements StreamReader {
  deltaCount = 0
  private usage: number | null = null

  push(data: string): StreamSignal {
    if (data === SSE_DONE) return { kind: 'end', usageTokens: this.usage }
    const event = parse(data)
    if (!event) return { kind: 'ignore' }
    if (event.error !== undefined && event.error !== null) return { kind: 'error' }

    const usage = asRecord(event.usage)
    if (usage) {
      const tokens = usageCount(usage.completion_tokens)
      if (tokens !== null) this.usage = tokens
    }

    const choices = Array.isArray(event.choices) ? event.choices : []
    const delta = asRecord(asRecord(choices[0])?.delta)
    const content = delta?.content
    if (typeof content === 'string' && content.length > 0) {
      this.deltaCount++
      return { kind: 'text' }
    }
    return { kind: 'ignore' }
  }
}

/**
 * OpenAI Responses. Only `response.output_text.delta` is visible text — `created`,
 * `in_progress`, reasoning and tool events are not, so a reasoning model's long
 * think time is correctly charged to TTFT instead of hidden by it.
 *
 * `response.completed` closes with `response.usage.output_tokens`. A
 * `response.incomplete` is a normal close ONLY when it stopped at the output
 * ceiling and text was actually produced — that is the calibration working as
 * designed; every other incomplete reason, `response.failed` and `error` are
 * failures, however much text already arrived.
 *
 * Note the ceiling and that usage INCLUDE reasoning tokens. TTFT still counts only
 * visible text, so TPOT and tokens/sec on a reasoning model describe total upstream
 * output, not visible-text speed.
 */
class ResponsesReader implements StreamReader {
  deltaCount = 0

  push(data: string): StreamSignal {
    const event = parse(data)
    if (!event) return { kind: 'ignore' }
    const type = typeof event.type === 'string' ? event.type : ''

    if (type === 'response.output_text.delta') {
      const delta = event.delta
      if (typeof delta === 'string' && delta.length > 0) {
        this.deltaCount++
        return { kind: 'text' }
      }
      return { kind: 'ignore' }
    }
    if (type === 'response.completed') {
      return { kind: 'end', usageTokens: this.outputTokens(event) }
    }
    if (type === 'response.incomplete') {
      const response = asRecord(event.response)
      const reason = asRecord(response?.incomplete_details)?.reason
      const hitCeiling = reason === 'max_output_tokens'
      // Text produced is checked by the caller via the run's own TTFT; here we
      // only distinguish "stopped because it filled the budget" from every other
      // incomplete, which is a genuine failure.
      return hitCeiling ? { kind: 'end', usageTokens: this.outputTokens(event) } : { kind: 'error' }
    }
    if (type === 'response.failed' || type === 'error') return { kind: 'error' }
    return { kind: 'ignore' }
  }

  private outputTokens(event: Record<string, unknown>): number | null {
    return usageCount(asRecord(asRecord(event.response)?.usage)?.output_tokens)
  }
}

/**
 * Anthropic Messages. Text is a `content_block_delta` carrying a `text_delta`;
 * `message_delta` carries a CUMULATIVE `usage.output_tokens`, so each one replaces
 * the last rather than adding to it — summing them would multiply the count and
 * silently deflate TPOT. `message_stop` closes the stream.
 */
class MessagesReader implements StreamReader {
  deltaCount = 0
  private usage: number | null = null

  push(data: string): StreamSignal {
    const event = parse(data)
    if (!event) return { kind: 'ignore' }
    const type = typeof event.type === 'string' ? event.type : ''

    if (type === 'error') return { kind: 'error' }
    if (type === 'message_stop') return { kind: 'end', usageTokens: this.usage }

    if (type === 'message_start' || type === 'message_delta') {
      const usage = asRecord(event.usage) ?? asRecord(asRecord(event.message)?.usage)
      const tokens = usageCount(usage?.output_tokens)
      // Cumulative: take the latest value, never accumulate.
      if (tokens !== null) this.usage = tokens
      return { kind: 'ignore' }
    }
    if (type === 'content_block_delta') {
      const delta = asRecord(event.delta)
      if (delta?.type === 'text_delta') {
        const text = delta.text
        if (typeof text === 'string' && text.length > 0) {
          this.deltaCount++
          return { kind: 'text' }
        }
      }
      return { kind: 'ignore' }
    }
    return { kind: 'ignore' }
  }
}

/** A fresh stream reader for one request of the given dialect. */
export function createStreamReader(dialect: SpeedTestApiDialect): StreamReader {
  switch (dialect) {
    case 'chat':
      return new ChatReader()
    case 'responses':
      return new ResponsesReader()
    case 'messages':
      return new MessagesReader()
  }
}
