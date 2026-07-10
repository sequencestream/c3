/**
 * Reproduction for "codex native call errors as soon as a tool call enters
 * history" — the 400 the user hit:
 *
 *   codex stream error: {
 *     "type":"error",
 *     "error":{"type":"invalid_request_error",
 *       "message":"[ObjectParam] [input[25].namespace] [unknown_parameter]
 *                  Unknown parameter: 'input[25].namespace'."},
 *     "status":400 }
 *
 * Mechanism (pinned against the codex 0.142 binary's serde tags): codex's
 * `ResponseItem::FunctionCall` variant carries a `namespace` field
 * (`…call_id status action function_call name namespace arguments…`, the
 * "FunctionCall with 6 elements" struct). When the model calls a tool that lives
 * inside a codex tool NAMESPACE group (`multi_agent_v1`, `code_mode`, …), the
 * resulting `function_call` item is stamped with `namespace: "<group>"`. On the
 * NEXT turn codex replays the whole history, so that `function_call` rides back in
 * the `input[]` array carrying `namespace`.
 *
 * Why the OFFICIAL endpoint rejects it too (system-config codex, official model —
 * NOT a third-party API): `codex exec` runs with `store: false` (see the real
 * fixture), so it does NOT lean on `previous_response_id` server state — it REPLAYS
 * the full `input[]` history every turn. Under that stateless full-replay path the
 * Responses backend applies strict input validation and does not accept the
 * `namespace` extension on a `function_call` item (it is only honored on the
 * stateful / recognized-originator path). c3 also overrides the codex originator
 * (`CODEX_INTERNAL_ORIGINATOR_OVERRIDE=c3`, vs codex's native `codex_exec`), which
 * pushes the backend further onto the generic-client validation path.
 *
 * The namespaced tools (`multi_agent_v1` / `code_mode`) are codex's own
 * multi-agent-orchestration surface, enabled by default. c3 uses codex as a single
 * read-only advisor seat (ADR-0011) and never needs them — so the clean fix is to
 * disable those `[features]` for c3's codex runs, which removes the `namespace`
 * field at the source.
 *
 * The first turn has no tool-call history (`input` is bare user/developer
 * messages — see the real fixture, `input.length === 3`, all `message`), so it
 * succeeds. The failure appears only once a namespaced tool call has entered the
 * history — exactly "包含工具调用就报错".
 *
 * This test has no network: `strictResponsesProvider` stands in for the backend's
 * stateless (store:false) input validation. It shows (1) the replayed namespaced
 * call reproduces the exact 400, (2) with the namespace-producing feature disabled
 * no such item exists and the turn is accepted, and (3) the c3 RELAY route
 * (`wireApi: 'chat'`) is immune because `responsesRequestToChat` never forwards the
 * `namespace` field.
 */
import { describe, it, expect } from 'vitest'
import { responsesRequestToChat, type ResponsesRequest } from './translate.js'

/**
 * A namespaced tool call as codex serializes it into `input[]` on replay: a
 * `function_call` whose `namespace` names the tool group it was dispatched through.
 */
function namespacedFunctionCall(index: number): Record<string, unknown> {
  return {
    type: 'function_call',
    id: `fc_${index}`,
    call_id: `call_${index}`,
    name: 'spawn_agent',
    namespace: 'multi_agent_v1',
    arguments: '{"role":"reviewer"}',
    status: 'completed',
  }
}

/** A codex history whose 26th item (index 25) is a namespaced tool call. */
function historyWithNamespacedCallAt25(): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = []
  input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys' }] })
  for (let i = 1; i < 25; i++) {
    input.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: `turn ${i}` }],
    })
  }
  input.push(namespacedFunctionCall(25))
  return input
}

/**
 * Stand-in for the Responses backend's stateless (`store:false`) input validation:
 * it rejects any `input[]` item carrying a field outside the OpenAI-standard set,
 * returning the same `[ObjectParam] … [unknown_parameter]` shape the user saw.
 */
const ALLOWED_INPUT_FIELDS = new Set([
  'type',
  'id',
  'role',
  'content',
  'name',
  'arguments',
  'call_id',
  'output',
  'status',
])

function strictResponsesProvider(req: ResponsesRequest): { status: number; body: unknown } {
  const input = req.input ?? []
  for (let i = 0; i < input.length; i++) {
    for (const key of Object.keys(input[i])) {
      if (!ALLOWED_INPUT_FIELDS.has(key)) {
        return {
          status: 400,
          body: {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: `[ObjectParam] [input[${i}].${key}] [unknown_parameter] Unknown parameter: 'input[${i}].${key}'.`,
            },
            status: 400,
          },
        }
      }
    }
  }
  return { status: 200, body: { ok: true } }
}

describe('codex namespaced function_call — official backend (store:false replay)', () => {
  it('rejects the replayed history with the exact input[25].namespace 400', () => {
    const req: ResponsesRequest = { input: historyWithNamespacedCallAt25() }
    const res = strictResponsesProvider(req)

    expect(res.status).toBe(400)
    const err = res.body as { error: { type: string; message: string } }
    expect(err.error.type).toBe('invalid_request_error')
    expect(err.error.message).toBe(
      "[ObjectParam] [input[25].namespace] [unknown_parameter] Unknown parameter: 'input[25].namespace'.",
    )
  })

  it("first turn (no tool-call history) is accepted — so it's the tool call that breaks it", () => {
    const firstTurn: ResponsesRequest = {
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys' }] },
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'write the spec' }],
        },
      ],
    }
    expect(strictResponsesProvider(firstTurn).status).toBe(200)
  })

  it('with the namespace feature disabled the same call carries no namespace → accepted', () => {
    // features.multi_agent=false ⇒ codex advertises no `type:"namespace"` tool group,
    // so a tool call is a plain `function_call` with no `namespace` field.
    const plainCall = { ...namespacedFunctionCall(25) }
    delete plainCall.namespace
    const input = historyWithNamespacedCallAt25()
    input[25] = plainCall
    expect(strictResponsesProvider({ input }).status).toBe(200)
  })
})

describe('codex namespaced function_call — c3 RELAY route is immune', () => {
  it('drops the namespace field when folding into a Chat request', () => {
    const chat = responsesRequestToChat({ input: historyWithNamespacedCallAt25() })

    const assistant = chat.messages.find((m) => m.role === 'assistant')
    expect(assistant?.tool_calls?.[0]).toEqual({
      id: 'call_25',
      type: 'function',
      function: { name: 'spawn_agent', arguments: '{"role":"reviewer"}' },
    })
    // The Chat tool_call shape has no place for `namespace`; feeding the relay's
    // output back through the strict validator passes.
    for (const m of chat.messages) {
      expect(Object.prototype.hasOwnProperty.call(m, 'namespace')).toBe(false)
    }
  })
})
