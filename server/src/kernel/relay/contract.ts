/**
 * Kernel-side contract for the vendor-neutral provider relay. The relay's
 * IMPLEMENTATION is an HTTP transport concern (Hono handler + fetch + wire
 * serialization + protocol adapters), so it lives in `transport/relay/` — ADR-0009
 * R2 bars kernel from touching HTTP/serialization. Drivers and the launch layer
 * only need the inert handle below (per-vendor base URLs + a per-run binding
 * registry), which is injected at the composition root; they never see the
 * handler. This file is pure: no HTTP, no SDK, no `JSON.stringify`.
 *
 * The relay is vendor-neutral: every vendor CLI's provider connection is routed to
 * a loopback relay endpoint with a per-run opaque token, and the real upstream key
 * never reaches the vendor subprocess/sandbox. A token binds an ORDERED CANDIDATE
 * LIST (a group of same-vendor providers by priority); the relay tries them in
 * order, failing over to the next only before the first response byte reaches the
 * CLI. A plain (non-group) agent is the degenerate length-1 candidate list.
 */
import type { VendorId } from '@ccc/shared/protocol'

/**
 * One real upstream a relay token can resolve to (a per-run binding entry). The
 * relay overrides the request's model with this candidate's `model` on dispatch,
 * so failover across candidates with different models switches the upstream model
 * transparently — the CLI keeps its fixed launch model.
 */
export interface RelayCandidate {
  /** Provider base URL the user configured (e.g. `https://api.deepseek.com/` or `…/anthropic`). */
  baseUrl: string
  /** Provider API key (the real one; never handed to the vendor subprocess). */
  apiKey: string
  /** The real upstream model id the relay overrides the request body's `model` with. */
  model: string
  /**
   * Codex-only: the upstream wire protocol. `chat` ⇒ the relay translates
   * Responses↔Chat; `responses` ⇒ passthrough. Irrelevant to claude (anthropic
   * passthrough); omitted there.
   */
  wireApi?: 'responses' | 'chat'
}

/** The inert relay handle drivers / the claude launch site consume (no HTTP surface). */
export interface Relay {
  /**
   * The base URL to hand a vendor CLI as its provider endpoint. codex points its
   * custom provider `base_url` here (and POSTs `<base>/responses`); claude sets
   * `ANTHROPIC_BASE_URL` here (and the SDK POSTs `<base>/v1/messages`).
   */
  endpoint(vendor: VendorId): string
  /** Bind an ordered candidate list for one run; returns the token to use as the vendor API key. */
  register(candidates: RelayCandidate[]): string
  /** Drop a run's binding. */
  unregister(token: string): void
}

/**
 * The codex `model_provider` name the driver defines to point at the relay. A
 * custom provider (not the builtin `openai`) is required so `supports_websockets`
 * can be forced off — codex 0.137 otherwise dials a websocket the relay can't serve.
 */
export const CODEX_RELAY_PROVIDER = 'c3relay'
