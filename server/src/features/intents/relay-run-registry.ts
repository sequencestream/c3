/**
 * Who is actually calling — the server's own record of the relay runs it started.
 *
 * The PR review / fix backfill tools take a session id as an ARGUMENT, because the
 * manual and automation entry points legitimately name one. That argument is a
 * claim, not proof: a model can echo the id its own prompt showed it, and a human
 * can type the id they see in the intent detail. Either is fine for writing a
 * conclusion; neither may confer the authority to merge.
 *
 * So the queue keeps this registry. It maps the per-execution handle the MCP
 * binding already carries (`executionId`) onto the relay phase the queue started
 * under that handle, and the session the VENDOR bound to it. A tool call arriving
 * on that binding is therefore attributable without trusting any argument: the
 * server knows which run it is serving.
 *
 * In-memory on purpose. The registry only answers "is this live call the queue's
 * review run?", which is a question about the current process; a restart ends
 * every relay run it could have answered for, and a durable copy would only be a
 * way to answer `true` for a run that no longer exists.
 */
import type { RelayPhase } from './relay-occupancy.js'

export interface RelayRunBinding {
  intentId: string
  phase: RelayPhase
  workspacePath: string
  /** The `pending:` placeholder at registration; the real session id once bound. */
  sessionId: string
}

const bindings = new Map<string, RelayRunBinding>()

/** Register a relay run before it launches, under the handle its MCP binding uses. */
export function registerRelayRun(executionId: string, binding: RelayRunBinding): void {
  bindings.set(executionId, binding)
}

/** Follow the vendor's bind: the same run, now identified by its real session. */
export function bindRelayRunSession(executionId: string, sessionId: string): void {
  const found = bindings.get(executionId)
  if (!found || !sessionId) return
  bindings.set(executionId, { ...found, sessionId })
}

/** Forget a run that has ended. Every exit path of the executor calls this. */
export function unregisterRelayRun(executionId: string): void {
  bindings.delete(executionId)
}

/** The relay run behind one MCP execution handle, or `null` when it is not one. */
export function lookupRelayRun(executionId: string): RelayRunBinding | null {
  return bindings.get(executionId) ?? null
}

/** Test hook: drop every binding this process holds. */
export function resetRelayRunRegistryForTests(): void {
  bindings.clear()
}
