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
 * Loopback proxy-bypass helper, re-exported for the relay's own callers. The relay
 * lives on c3's loopback, so a vendor CLI must bypass any configured HTTP(S) proxy
 * for `127.0.0.1` — otherwise the loopback hop is routed through the proxy and
 * fails. The single implementation is the vendor-neutral infra leaf, shared with the
 * claude child env and the codex driver env.
 */
export { withLoopbackNoProxy } from '../infra/no-proxy.js'
