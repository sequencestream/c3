/**
 * Responses ⇄ Chat Completions translation core for the in-process codex relay
 * (ADR-0014). Codex 0.137 speaks ONLY the OpenAI **Responses API** on the wire
 * (`wire_api = "chat"` was removed upstream — discussion #7782), so a codex agent
 * pointed at a Chat-Completions-only provider (DeepSeek, Kimi, MiMo, MiniMax, …)
 * cannot talk to it directly. This module is the pure, vendor-SDK-free translator
 * the relay handler wraps: it rewrites a codex Responses request into a Chat
 * Completions request, and rewrites the upstream Chat SSE stream back into the
 * Responses SSE events codex's parser consumes.
 *
 * The shapes here were pinned against the REAL wire contract, not guesses:
 *  - the request shape is a captured codex 0.137 `POST /v1/responses` body
 *    (`__fixtures__/responses-request.real.json`);
 *  - the response event contract is codex's own Rust parser
 *    (`codex-rs/codex-api/src/sse/responses.rs` @ rust-v0.137.0): it keys off the
 *    JSON `type` field, IGNORES unknown events, and a turn is correct as long as
 *    every output item arrives as a full `ResponseItem` in
 *    `response.output_item.done` and the stream ends with `response.completed`
 *    (which carries a required `id` + optional `usage`). The granular
 *    `response.output_text.delta` events are display-only; `response.completed`
 *    is mandatory or codex errors "stream closed before response.completed".
 *
 * No `@openai/codex-sdk` (or any vendor SDK) type is imported — only plain JSON
 * shapes cross this boundary (ADR-0009 / ADR-0011). The relay HTTP plumbing lives
 * in `./index.ts`; this file is pure and unit-tested.
 */

// ---------------------------------------------------------------------------
// Minimal structural types (NOT vendor SDK types — plain JSON faces)
// ---------------------------------------------------------------------------

/** A codex Responses request body (the subset the translator reads). */
export interface ResponsesRequest {
  model?: string
  instructions?: string
  input?: ResponsesInputItem[]
  tools?: ResponsesTool[]
  tool_choice?: unknown
  parallel_tool_calls?: boolean
  stream?: boolean
  // Responses-only fields the translator drops: reasoning, store, include,
  // prompt_cache_key, client_metadata, …
  [k: string]: unknown
}

/** One item in the Responses `input` array. */
export interface ResponsesInputItem {
  type: string
  id?: string
  role?: string
  content?: ResponsesContentPart[]
  // function_call
  name?: string
  arguments?: string
  call_id?: string
  // function_call_output
  output?: unknown
  [k: string]: unknown
}

export interface ResponsesContentPart {
  type: string
  text?: string
  image_url?: string
  [k: string]: unknown
}

/** A Responses tool: either a flat function or a codex `namespace` group. */
export interface ResponsesTool {
  type: string
  name?: string
  description?: string
  parameters?: unknown
  strict?: boolean
  tools?: ResponsesTool[] // namespace children
  [k: string]: unknown
}

/** A Chat Completions request body (the subset the translator writes). */
export interface ChatRequest {
  model?: string
  messages: ChatMessage[]
  tools?: ChatTool[]
  tool_choice?: unknown
  parallel_tool_calls?: boolean
  stream: true
  stream_options: { include_usage: true }
}

export interface ChatMessage {
  role: string
  content: string | ChatContentPart[] | null
  tool_calls?: ChatToolCall[]
  tool_call_id?: string
}

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatTool {
  type: 'function'
  function: { name: string; description?: string; parameters?: unknown; strict?: boolean }
}

export interface ChatToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** A parsed Chat Completions streaming chunk (the subset we read). */
export interface ChatStreamChunk {
  id?: string
  choices?: Array<{
    index?: number
    delta?: {
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: ChatUsage | null
}

export interface ChatUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** A Responses SSE event object (serialized as one `data:` JSON line). */
export type ResponsesEvent = { type: string } & Record<string, unknown>

// ---------------------------------------------------------------------------
// Request translation: Responses → Chat Completions
// ---------------------------------------------------------------------------

/**
 * Rewrite a codex Responses request into a Chat Completions request.
 *  - `instructions` → a leading `system` message.
 *  - `input[]` → `messages[]`: `developer` role folds to `system`; adjacent
 *    `function_call` items merge into one assistant message's `tool_calls`;
 *    `function_call_output` → a `tool` message.
 *  - `tools[]` → Chat function tools; a codex `namespace` group is flattened to
 *    its child functions (best-effort — most turns never call them).
 *  - Responses-only fields (reasoning/store/include/…) are dropped.
 *  - `stream` is forced on with `stream_options.include_usage` so the upstream
 *    reports token usage we can fold into `response.completed`.
 */
export function responsesRequestToChat(req: ResponsesRequest): ChatRequest {
  const messages: ChatMessage[] = []
  if (typeof req.instructions === 'string' && req.instructions.length > 0) {
    messages.push({ role: 'system', content: req.instructions })
  }

  for (const item of req.input ?? []) {
    const mapped = mapInputItem(item)
    if (!mapped) continue
    // Merge an assistant tool-call message into the previous assistant tool-call
    // message so parallel calls in one turn become one assistant turn (what Chat
    // providers expect), rather than N separate assistant messages.
    const prev = messages[messages.length - 1]
    if (
      mapped.role === 'assistant' &&
      mapped.tool_calls &&
      prev &&
      prev.role === 'assistant' &&
      prev.tool_calls &&
      (prev.content === null || prev.content === '')
    ) {
      prev.tool_calls.push(...mapped.tool_calls)
    } else {
      messages.push(mapped)
    }
  }

  const tools = flattenTools(req.tools ?? [])

  const chat: ChatRequest = {
    ...(req.model !== undefined ? { model: req.model } : {}),
    messages,
    stream: true,
    stream_options: { include_usage: true },
  }
  if (tools.length > 0) chat.tools = tools
  if (req.tool_choice !== undefined) chat.tool_choice = normalizeToolChoice(req.tool_choice)
  if (typeof req.parallel_tool_calls === 'boolean')
    chat.parallel_tool_calls = req.parallel_tool_calls
  return chat
}

function mapInputItem(item: ResponsesInputItem): ChatMessage | null {
  switch (item.type) {
    case 'message': {
      const role = item.role === 'developer' ? 'system' : (item.role ?? 'user')
      return { role, content: contentPartsToChat(item.content ?? []) }
    }
    case 'function_call': {
      // The assistant proposing a tool call. `arguments` is already a JSON string.
      const call: ChatToolCall = {
        id: item.call_id ?? item.id ?? 'call_0',
        type: 'function',
        function: { name: item.name ?? '', arguments: item.arguments ?? '{}' },
      }
      return { role: 'assistant', content: null, tool_calls: [call] }
    }
    case 'function_call_output': {
      return {
        role: 'tool',
        tool_call_id: item.call_id ?? '',
        content: outputToString(item.output),
      }
    }
    default:
      // reasoning / other items carry no Chat analogue; drop them.
      return null
  }
}

/** Fold Responses content parts into a Chat `content` (string when text-only). */
function contentPartsToChat(parts: ResponsesContentPart[]): string | ChatContentPart[] {
  const hasImage = parts.some((p) => p.type === 'input_image')
  if (!hasImage) {
    return parts
      .filter((p) => p.type === 'input_text' || p.type === 'output_text')
      .map((p) => p.text ?? '')
      .join('\n')
  }
  const out: ChatContentPart[] = []
  for (const p of parts) {
    if (p.type === 'input_image' && typeof p.image_url === 'string') {
      out.push({ type: 'image_url', image_url: { url: p.image_url } })
    } else if ((p.type === 'input_text' || p.type === 'output_text') && p.text) {
      out.push({ type: 'text', text: p.text })
    }
  }
  return out
}

/** A `function_call_output.output` is a string or structured content items. */
function outputToString(output: unknown): string {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output
      .map((p) =>
        p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '',
      )
      .join('')
  }
  if (output && typeof output === 'object') {
    const o = output as { content?: unknown; output?: unknown }
    if (typeof o.content === 'string') return o.content
    if (typeof o.output === 'string') return o.output
    return JSON.stringify(output)
  }
  return output === undefined || output === null ? '' : String(output)
}

/** Flatten codex tools into Chat function tools (namespaces → child functions). */
function flattenTools(tools: ResponsesTool[]): ChatTool[] {
  const out: ChatTool[] = []
  for (const t of tools) {
    if (t.type === 'function' && t.name) {
      out.push({
        type: 'function',
        function: {
          name: t.name,
          ...(t.description !== undefined ? { description: t.description } : {}),
          ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
          ...(typeof t.strict === 'boolean' ? { strict: t.strict } : {}),
        },
      })
    } else if (t.type === 'namespace' && Array.isArray(t.tools)) {
      out.push(...flattenTools(t.tools))
    }
  }
  return out
}

/** Responses tool_choice → Chat tool_choice (object choices degrade to "auto"). */
function normalizeToolChoice(choice: unknown): unknown {
  if (choice === 'auto' || choice === 'none' || choice === 'required') return choice
  return 'auto'
}

// ---------------------------------------------------------------------------
// Response translation: Chat Completions SSE → Responses SSE events
// ---------------------------------------------------------------------------

interface PendingToolCall {
  id: string
  name: string
  args: string
}

/**
 * Stateful converter from a Chat Completions stream into Responses events. Fed
 * one parsed Chat chunk at a time; emits the Responses events codex consumes.
 *
 * Strategy (grounded in codex's parser): stream `response.output_text.delta` for
 * live text (and keep the connection warm against codex's idle timeout), then at
 * the end materialize each output as a full `ResponseItem` in
 * `response.output_item.done` (the assistant message and one per tool call), and
 * always close with `response.completed` (required, carries `id` + usage).
 */
export class ChatToResponsesConverter {
  private startedEmitted = false
  private messageItemOpened = false
  private text = ''
  private reasoning = ''
  private readonly toolCalls = new Map<number, PendingToolCall>()
  private usage: ChatUsage | null = null
  private responseId = ''
  private finished = false

  /** Events to emit before any chunk (the `response.created` preamble). */
  start(): ResponsesEvent[] {
    if (this.startedEmitted) return []
    this.startedEmitted = true
    return [{ type: 'response.created', response: {} }]
  }

  /** Consume one parsed Chat streaming chunk; returns events to forward now. */
  consume(chunk: ChatStreamChunk): ResponsesEvent[] {
    const events: ResponsesEvent[] = []
    if (!this.startedEmitted) events.push(...this.start())
    if (chunk.id && !this.responseId) this.responseId = chunk.id
    if (chunk.usage) this.usage = chunk.usage

    const choice = chunk.choices?.[0]
    const delta = choice?.delta
    if (delta?.content) {
      // Open the message item before its first text delta — codex logs
      // "OutputTextDelta without active item" otherwise (non-fatal, but noisy).
      if (!this.messageItemOpened) {
        this.messageItemOpened = true
        events.push({
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', role: 'assistant', content: [] },
        })
      }
      this.text += delta.content
      events.push({
        type: 'response.output_text.delta',
        item_id: this.itemId(),
        output_index: 0,
        content_index: 0,
        delta: delta.content,
      })
    }
    if (delta?.reasoning_content) {
      this.reasoning += delta.reasoning_content
      events.push({
        type: 'response.reasoning_text.delta',
        item_id: this.itemId(),
        content_index: 0,
        delta: delta.reasoning_content,
      })
    }
    for (const tc of delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0
      const existing = this.toolCalls.get(idx) ?? { id: '', name: '', args: '' }
      if (tc.id) existing.id = tc.id
      if (tc.function?.name) existing.name = tc.function.name
      if (tc.function?.arguments) existing.args += tc.function.arguments
      this.toolCalls.set(idx, existing)
      // codex IGNORES function_call_arguments.delta, but emitting it keeps the SSE
      // stream warm against the idle timeout while a tool-only turn accumulates.
      if (tc.function?.arguments) {
        events.push({
          type: 'response.function_call_arguments.delta',
          item_id: existing.id || `call_${idx}`,
          output_index: 0,
          delta: tc.function.arguments,
        })
      }
    }
    return events
  }

  /** Terminal events: each output item as `output_item.done`, then `completed`. */
  done(): ResponsesEvent[] {
    if (this.finished) return []
    this.finished = true
    const events: ResponsesEvent[] = []
    if (!this.startedEmitted) events.push(...this.start())

    // The assistant message item (only when there is text; a pure tool-call turn
    // emits no message item).
    if (this.text.length > 0) {
      events.push({
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: this.text }],
        },
      })
    }

    // One function_call item per accumulated tool call, in call order.
    const ordered = [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0])
    ordered.forEach(([idx, tc]) => {
      events.push({
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          name: tc.name,
          arguments: tc.args || '{}',
          call_id: tc.id || `call_${idx}`,
        },
      })
    })

    events.push({
      type: 'response.completed',
      response: {
        id: this.responseId || 'resp_relay',
        ...(this.usage ? { usage: mapUsage(this.usage) } : { usage: null }),
      },
    })
    return events
  }

  /** A failure mid-stream → a `response.failed` codex maps to a retryable error. */
  fail(message: string): ResponsesEvent[] {
    if (this.finished) return []
    this.finished = true
    return [
      {
        type: 'response.failed',
        response: {
          id: this.responseId || 'resp_relay',
          error: { code: 'upstream_error', message },
        },
      },
    ]
  }

  private itemId(): string {
    return this.responseId || 'msg_relay'
  }
}

/** Chat usage → the `ResponseCompletedUsage` shape codex's parser requires. */
function mapUsage(u: ChatUsage): Record<string, unknown> {
  const input = u.prompt_tokens ?? 0
  const output = u.completion_tokens ?? 0
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: u.total_tokens ?? input + output,
    ...(u.prompt_tokens_details?.cached_tokens !== undefined
      ? { input_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens } }
      : {}),
    ...(u.completion_tokens_details?.reasoning_tokens !== undefined
      ? {
          output_tokens_details: { reasoning_tokens: u.completion_tokens_details.reasoning_tokens },
        }
      : {}),
  }
}

// ---------------------------------------------------------------------------
// SSE framing helpers
// ---------------------------------------------------------------------------

/** Serialize one Responses event as an SSE frame codex's eventsource parses. */
export function serializeSse(event: ResponsesEvent): string {
  // codex reads the JSON `type`; the `event:` line is ignored but kept for parity
  // with the real OpenAI stream.
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * Incremental SSE line parser for the upstream Chat stream. Feed raw decoded text
 * chunks; yields the JSON payloads of each `data:` line (excluding `[DONE]`).
 */
export class SseChunkParser {
  private buffer = ''

  push(textChunk: string): string[] {
    this.buffer += textChunk
    const out: string[] = []
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '')
      this.buffer = this.buffer.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '' || data === '[DONE]') continue
      out.push(data)
    }
    return out
  }
}
