/**
 * Composition-root singleton for the process relay handle.
 *
 * The relay is created in the composition root (`server.ts`) and injected into the
 * codex adapter directly. But two other real spawn sites also need it and are not
 * assembled with an adapter: the claude resident-process launch (`run-lifecycle`
 * around `runClaude`) and the one-shot advisor (`agent-once`). Rather than thread
 * the handle through every call, the composition root registers it here once with
 * {@link setRelay}; those sites read it with {@link getRelay}. Absent (tests /
 * scripts that never call `setRelay`) ⇒ null ⇒ the caller falls back to a direct
 * launch (system-mode / own-login), so the kernel still works without the relay up.
 */
import type { Relay } from './contract.js'

let relay: Relay | null = null

/** Register the process relay handle (composition root only). */
export function setRelay(r: Relay | null): void {
  relay = r
}

/** The process relay handle, or null when unwired (tests / no composition root). */
export function getRelay(): Relay | null {
  return relay
}

/**
 * Add the loopback hosts to a comma-separated `NO_PROXY` value (idempotent). The
 * relay lives on c3's own loopback, so the vendor CLI must bypass any configured
 * HTTP(S) proxy for `127.0.0.1` — otherwise the loopback hop is routed through the
 * proxy and fails. Mirrors the codex driver's own `NO_PROXY` handling.
 */
export function withLoopbackNoProxy(value?: string): string {
  const parts = (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    if (!parts.includes(host)) parts.push(host)
  }
  return parts.join(',')
}
