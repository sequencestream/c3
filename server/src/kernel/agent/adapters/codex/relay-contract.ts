/**
 * Kernel-side contract for the codex Responses→Chat relay (ADR-0014). The relay's
 * IMPLEMENTATION is an HTTP transport concern (Hono handler + fetch + wire
 * serialization), so it lives in `transport/codex-relay/` — ADR-0009 R2 bars
 * kernel from touching HTTP/serialization. The driver only needs the inert handle
 * below (a base URL + a per-run binding registry), which is injected at the
 * composition root; it never sees the handler. This file is pure: no HTTP, no SDK,
 * no `JSON.stringify`.
 */

/** The real upstream a relay token resolves to (a per-run binding). */
export interface RelayUpstream {
  /** Provider base URL the user configured (e.g. `https://api.deepseek.com/`). */
  baseUrl: string
  /** Provider API key (the real one; never handed to the codex subprocess). */
  apiKey: string
}

/** The inert relay handle the codex driver consumes (no HTTP surface). */
export interface CodexRelay {
  /** The base URL to hand the codex CLI as the relay provider's `base_url`. */
  readonly baseUrl: string
  /** Bind a real upstream for one run; returns the token to use as the codex API key. */
  register(upstream: RelayUpstream): string
  /** Drop a run's binding. */
  unregister(token: string): void
}

/**
 * The codex `model_provider` name the driver defines to point at the relay. A
 * custom provider (not the builtin `openai`) is required so `supports_websockets`
 * can be forced off — codex 0.137 otherwise dials a websocket the relay can't serve.
 */
export const CODEX_RELAY_PROVIDER = 'c3relay'
