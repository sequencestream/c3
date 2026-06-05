/**
 * Agent error classification (server refactor 3/3, ADR-0009 — sunk from the old
 * root `claude.ts`). A mutually-exclusive PAIR of heuristics that route an SDK
 * run failure: `isDegradableError` ⇒ try the next agent in the degradation chain
 * (agent-config concern); `isSocketDisconnect` ⇒ a single same-session auto-resume
 * (run-lifecycle concern, consumed by `kernel/run`). Kept together because they
 * are defined against each other (a socket disconnect must NEVER also be
 * degradable — see the note on {@link isSocketDisconnect}).
 */

/**
 * Heuristic check: does this error message describe a transient / degradable
 * failure that warrants switching to a different agent? Matches rate-limit,
 * session-limit, authentication, and connection errors — the kinds of errors
 * that a different API key or base URL might avoid. A regular tool-execution
 * or model-response error is NOT degradable (the agent itself is fine).
 */
export function isDegradableError(message: string): boolean {
  const lower = message.toLowerCase()
  // Rate limit (HTTP 429, SDK rate-limit messages)
  if (/rate\s*limit|rate_limit|429|too\s*many\s*requests/i.test(lower)) return true
  // Session limit
  if (/session\s*limit|session_limit|concurrent\s*session/i.test(lower)) return true
  // Authentication / token errors
  if (/401|auth|unauthorized|authentication|invalid\s*api.?key|invalid\s*token/i.test(lower))
    return true
  // Connection / network errors
  if (
    /econnrefused|econnreset|etimedout|ehostunreach|network|connection\s*(refused|reset|failed|error)/i.test(
      lower,
    )
  )
    return true
  // Server-side temporary errors
  if (/5\d{2}|service\s*unavailable|internal\s*server\s*error|bad\s*gateway/i.test(lower))
    return true
  // API-level exhaustion / quota
  if (/quota|exhausted|insufficient\s*quota/i.test(lower)) return true
  return false
}

/**
 * Narrow classifier for the one SDK failure mode the socket auto-resume path
 * handles: the transport dropped mid-turn ("socket connection was closed
 * unexpectedly"). Deliberately SEPARATE from {@link isDegradableError} (the
 * degradation-chain classifier) — a socket disconnect is NOT degradable (the
 * agent/key is fine), so it must never enter `agentsToTry`; it gets a single
 * same-session `resume` instead (AS-R18). The two classifiers are mutually
 * exclusive: this phrase does not match any `isDegradableError` pattern, and
 * this matcher is intentionally a single exact phrase so a generic connection
 * error never lands here. Case-insensitive.
 */
export function isSocketDisconnect(message: string): boolean {
  return /socket connection was closed unexpectedly/i.test(message)
}
