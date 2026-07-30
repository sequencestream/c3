/**
 * Loopback proxy-bypass for spawned vendor CLIs — the ONE place that computes a
 * `NO_PROXY` value covering c3's own loopback origin.
 *
 * Every c3-provided capability a vendor CLI consumes (the intent / spec-query /
 * work-event / automation MCP routes, and the provider relay) lives on c3's
 * localhost origin. A host that exports `HTTP(S)_PROXY` without a `NO_PROXY` makes
 * the CLI route `127.0.0.1:<c3port>` THROUGH that proxy, which answers 502 (or an
 * empty non-MCP body) — the MCP server then never connects and its tools are absent
 * from the model's tool set entirely, with no user-visible error. So every spawn
 * site must add the loopback hosts to `NO_PROXY`.
 *
 * A vendor-neutral infra leaf: the claude child env, the codex driver env, and the
 * relay binding all import this instead of keeping their own copy.
 */

/** The loopback hosts every c3-served endpoint is reached at. */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'] as const

/**
 * Add the loopback hosts to a comma-separated `NO_PROXY` value (idempotent).
 * Entries the user already set are preserved — this only appends what is missing,
 * so a host-configured bypass list is never narrowed.
 */
export function withLoopbackNoProxy(value?: string): string {
  const parts = (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const host of LOOPBACK_HOSTS) {
    if (!parts.includes(host)) parts.push(host)
  }
  return parts.join(',')
}
