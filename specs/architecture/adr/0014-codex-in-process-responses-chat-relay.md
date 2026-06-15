# 0014 — In-process Responses→Chat relay for codex Chat-Completions providers

- **Status:** accepted
- **Date:** 2026-06-06

## Context

ADR-0011 made codex a first-class driver-path vendor; AC-R5 maps a `custom` codex agent's
`baseUrl`/`apiKey` onto the codex SDK so a user can point codex at a third-party provider
(DeepSeek, Kimi, MiMo, MiniMax, …). In practice that mapping no longer works for those providers.

Two facts collide:

1. **Codex 0.137 speaks only the OpenAI Responses API on the wire.** The `wire_api = "chat"` option
   was removed upstream (openai/codex discussion #7782; chat support became a hard error in early
   Feb 2026). Codex's builtin `openai` provider POSTs to `<base_url>/responses`, and by default it
   first dials a **websocket** (`responses_websocket`) before falling back to HTTP POST + SSE.
2. **The mainstream third-party providers implement only Chat Completions** (`/v1/chat/completions`).
   None expose `/responses`. So a codex agent on `https://api.deepseek.com/` fails with
   `404 … /responses` (observed as `wss://api.deepseek.com/responses`).

There is no codex config that bridges this: `wire_api = "chat"` is gone. The only path is a proxy that
translates the Responses protocol to Chat Completions. The product requirement (confirmed with the
operator) is that c3 does this **transparently**: the user still configures the real upstream URL, and
c3 starts and runs the proxy itself — no external process, no extra install (which an external relay
binary would impose, breaking the ADR-0003 single-binary contract).

A captured codex 0.137 `POST /responses` body and codex's own Rust SSE parser
(`codex-rs/codex-api/src/sse/responses.rs` @ rust-v0.137.0) pin the wire contract: codex keys events
off the JSON `type`, **ignores unknown events**, takes each output as a full `ResponseItem` in
`response.output_item.done`, and requires the stream to end with `response.completed` (which carries a
required `id` + optional `usage`). Probing also showed two host facts: a provider's
`supports_websockets = false` forces codex onto plain HTTP POST + SSE, and codex routes the loopback
hop through a configured `HTTP(S)_PROXY` unless `NO_PROXY` excludes `127.0.0.1`.

## Options considered

to install a second runtime (pip/cargo/Python), and bundling a per-platform binary breaks the
single-binary distribution (ADR-0003). Contradicts "c3 starts it, no extra install." 2. **In-process TS translation mounted on c3's own Hono server.** c3 hosts a loopback endpoint; the codex
driver points the CLI at it via a custom `model_provider` (`supports_websockets = false`) and the
relay rewrites Responses⇄Chat both ways. _Pro:_ no external dependency, survives single-binary
packaging, full control. _Con:_ c3 owns the protocol-translation logic and its correctness. 3. **Per-agent `wireApi` toggle.** Add config so the user declares chat-vs-responses. _Con:_ pushes a
protocol detail onto the user; against the "just configure the URL" requirement. Deferred — every
`custom` codex provider is routed today (first-party OpenAI uses `configMode: system`, which bypasses
the relay entirely).

## Decision

Adopt option 2. **For a `custom` codex agent with a provider URL, c3 drives codex through an in-process
Responses→Chat relay; the user's configuration is unchanged (the real upstream URL).**

- **Translation core (`transport/codex-relay/translate.ts`)** — pure, SDK-free, unit-tested against the
  captured request + codex's parser contract: `responsesRequestToChat` (instructions→system,
  developer→system, adjacent `function_call`s merged into one assistant turn, `function_call_output`→tool
  message, codex `namespace` tools flattened, Responses-only fields dropped, `stream` + usage forced on);
  `ChatToResponsesConverter` (streams `output_text`/reasoning deltas live, materializes each output as a
  full `ResponseItem` in `output_item.done`, always closes with `response.completed` carrying id + usage).
- **Relay (`transport/codex-relay/index.ts`)** — a per-run token registry + Hono handler. The driver
  `register()`s the real `{baseUrl, apiKey}` and gets an opaque UUID token; the handler resolves the
  binding by `Authorization: Bearer <token>`, fetches the upstream `/chat/completions`, and streams the
  translated Responses SSE back. Unknown tokens are rejected; the binding is evicted on run end.
- **Driver wiring (`adapters/codex/driver.ts`)** — when the relay is present and the run has a custom URL,
  codex is launched with a custom `model_provider` (`base_url = relay.baseUrl`, `wire_api = "responses"`,
  `supports_websockets = false`), the token as `CODEX_API_KEY`, and `NO_PROXY` augmented with the loopback
  hosts. The real key never reaches the codex subprocess. Absent relay / no custom URL ⇒ the original
  direct path is unchanged.
- **Mount (`server.ts`)** — the relay is built at the composition root over c3's own port and its route is
  registered **before** the static catch-all.

## Consequences

- A codex agent on a Chat-Completions-only provider now works out of the box; the `/responses 404`
  disappears. DeepSeek/Kimi/MiMo/MiniMax are reachable with no user-run proxy and no extra install.
- c3 owns Responses⇄Chat fidelity. Mitigated by grounding every shape in the real wire contract (captured
  request + codex's Rust parser) and by a real-binary end-to-end test (codex ⇄ relay ⇄ fake Chat upstream).
- Streaming backpressure is preserved but the relay buffers per-item text/args before emitting
  `output_item.done`; acceptable for bounded codex turns over loopback.
- Reasoning is surfaced only for upstreams that emit `reasoning_content` (DeepSeek-R class); other chat
  upstreams simply carry none.
- Node's global `fetch` does not honour `HTTP_PROXY`, so the relay's outbound call to a public provider is
  direct — fine for the China-hosted providers this targets; an operator behind a mandatory egress proxy
  for the upstream is out of scope here.

## Compliance

- **ADR-0009 R2** — the relay is HTTP transport + wire serialization, so its implementation lives in
  `transport/codex-relay/`, not `kernel/`. The kernel keeps only an inert handle
  (`kernel/.../relay-contract.ts`: `baseUrl` + `register`/`unregister` + the provider-name constant),
  injected into the driver at the composition root; the driver never sees the Hono handler. `git grep`
  for `hono`/`JSON.stringify` under `kernel/` stays empty.
- **ADR-0003** — no new bundled binary; the relay is in-process and survives `bun build --compile`.
- **ADR-0011 / ADR-0009 SDK boundary** — no vendor SDK type enters the relay; only JSON shapes cross it.

## References

- ADR-0003 (single binary), ADR-0009 (boundaries), ADR-0011 (vendor-neutral agents).
- `specs/domains/system-config/agent-config/spec.md` AC-R5.
- openai/codex discussion #7782 (chat wire-api removal); `codex-rs/codex-api/src/sse/responses.rs`
  (rust-v0.137.0) — the event contract.
- `transport/codex-relay/` (translate + relay), `kernel/agent/adapters/codex/{driver,relay-contract}.ts`.
