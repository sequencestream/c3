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
 * The SDK emits the warning via `process.emitWarning(msg, { code })`. We intercept
 * at that exact call — NOT at `process.emit('warning', …)` — because the two are
 * NOT equivalent across runtimes: Node's `emitWarning` dispatches through
 * `process.emit`, but Bun's writes straight to stderr and never touches it. c3 runs
 * on both Node and Bun (dev/tsx vs. the `bun build --compile` binary), so a
 * `process.emit` wrapper is a silent no-op under Bun. Wrapping `emitWarning` catches
 * the warning at its source on every runtime. `--no-warnings` is rejected because it
 * silences ALL warnings indiscriminately; here we drop ONLY this one code and pass
 * every other warning (including a genuine misconfig) through untouched.
 */

/** The SDK warning code we drop. Any other warning — including a genuine misconfig — passes through. */
export const SHADOWED_WARNING_CODE = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED'

/**
 * Extract the `code` from a `process.emitWarning` call's arguments, supporting both
 * documented signatures: the options-object form `emitWarning(msg, { code })` (what
 * the SDK uses) and the legacy positional form `emitWarning(msg, type, code)`.
 */
function warningCodeOf(options: unknown, legacyCode: unknown): string | undefined {
  if (options !== null && typeof options === 'object') {
    const code = (options as { code?: unknown }).code
    return typeof code === 'string' ? code : undefined
  }
  // Positional form: emitWarning(warning, type?, code?) — options slot holds `type`.
  return typeof legacyCode === 'string' ? legacyCode : undefined
}

/**
 * True iff this `process.emitWarning` call is the benign Claude SDK shadow warning we
 * suppress. Pure (no global mutation) so the drop rule is unit-testable in isolation.
 * `options`/`legacyCode` are the 2nd/3rd `emitWarning` arguments.
 */
export function isSuppressedClaudeWarning(options: unknown, legacyCode?: unknown): boolean {
  return warningCodeOf(options, legacyCode) === SHADOWED_WARNING_CODE
}

let installed = false

/**
 * Install the process-wide warning filter. Idempotent: safe to call on every entry
 * path (server, daemon, dev, agent-once); installs at most once. Runtime-agnostic —
 * works on both Node and Bun because it wraps `emitWarning` itself.
 */
export function installClaudeSdkWarningFilter(): void {
  if (installed) return
  installed = true
  const original = process.emitWarning.bind(process)
  const wrapped = (warning: string | Error, ...rest: unknown[]): void => {
    if (isSuppressedClaudeWarning(rest[0], rest[1])) return
    ;(original as (...args: unknown[]) => void)(warning, ...rest)
  }
  process.emitWarning = wrapped as typeof process.emitWarning
}
