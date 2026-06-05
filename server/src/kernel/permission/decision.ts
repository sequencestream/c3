/**
 * The branded permission verdict (C-SEC, server refactor 3/3, ADR-0009).
 *
 * A `PermissionDecision` is the ONLY value the SDK `canUseTool` boundary accepts
 * from c3, and it can be minted in exactly one place: here, via {@link allow} /
 * {@link deny}. The `unique symbol` brand makes a bare `{ behavior: 'allow' }`
 * object NON-assignable to `PermissionDecision`, so no feature/transport code can
 * fabricate a verdict and slip it past the gateway — the type system is the guard
 * (paired with the eslint ban on `@anthropic-ai/claude-agent-sdk` imports outside
 * the kernel). `deny` REQUIRES a reason (PG-R7); `allow` carries only the
 * (optionally rewritten) tool input (PG-R6).
 *
 * Structurally a superset of the SDK's `PermissionResult`, so a `PermissionDecision`
 * is returned straight to the SDK with no unwrapping.
 */
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'

declare const PERMISSION_BRAND: unique symbol

/** A permission verdict only `kernel/permission` can construct (via allow/deny). */
export type PermissionDecision = PermissionResult & { readonly [PERMISSION_BRAND]: true }

/**
 * Allow the tool, optionally with a rewritten input (the AskUserQuestion
 * answer-injection exception to PG-R6 is the only caller that passes one).
 */
export function allow(updatedInput?: Record<string, unknown>): PermissionDecision {
  return { behavior: 'allow', ...(updatedInput ? { updatedInput } : {}) } as PermissionDecision
}

/** Deny the tool. A reason is mandatory (PG-R7) and surfaced to the SDK/agent. */
export function deny(reason: string): PermissionDecision {
  return { behavior: 'deny', message: reason } as PermissionDecision
}
