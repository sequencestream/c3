/**
 * Suppress ONE known-benign Node process warning the Claude Agent SDK emits since
 * 0.3.198: `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`. The SDK prints it on every `query()`
 * constructed with `permissionMode: 'bypassPermissions'` — which for c3 is exactly
 * the user-selected never-ask tool gate, where auto-approving every tool before the
 * `canUseTool` callback IS the intended semantics (a never-ask session opts out of
 * gating; the read-only intent/spec/discussion gates are forced to `always-ask` /
 * `on-sensitive` and are never shadowed). Left unfiltered it floods the server log
 * on every turn of a never-ask session. See the 0.3.201 SDK upgrade record,
 * "bypassPermissions 警告实盘确认".
 *
 * Node keeps printing a warning even when a `process.on('warning')` listener is
 * added (the listener runs *alongside* the default printer, it does not replace it),
 * and `--no-warnings` silences ALL warnings indiscriminately. The only way to drop
 * exactly one warning code is to intercept it before it is emitted — hence the
 * narrow `process.emit` wrapper. It drops ONLY this one code on the `'warning'`
 * event and passes every other event (and every other warning) through untouched.
 */

/** The SDK warning code we drop. Any other warning — including a genuine misconfig — passes through. */
export const SHADOWED_WARNING_CODE = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'

/**
 * True iff this process event is the benign Claude SDK shadow warning we suppress.
 * Pure (no global mutation) so the drop rule is unit-testable in isolation.
 */
export function isSuppressedClaudeWarning(event: string | symbol, warning: unknown): boolean {
  return (
    event === 'warning' &&
    typeof warning === 'object' &&
    warning !== null &&
    (warning as { code?: unknown }).code === SHADOWED_WARNING_CODE
  )
}

let installed = false

/**
 * Install the process-wide warning filter. Idempotent: safe to call on every entry
 * path (server, daemon, dev, agent-once); installs at most once.
 */
export function installClaudeSdkWarningFilter(): void {
  if (installed) return
  installed = true
  const original = process.emit.bind(process) as (
    event: string | symbol,
    ...args: unknown[]
  ) => boolean
  const wrapped = (event: string | symbol, ...args: unknown[]): boolean => {
    if (isSuppressedClaudeWarning(event, args[0])) return false
    return original(event, ...args)
  }
  process.emit = wrapped as typeof process.emit
}
