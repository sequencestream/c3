/**
 * Per-turn prompt delivery split — the unified, vendor-neutral system-instruction
 * channel (hide-session-system-instructions).
 *
 * A turn's text is divided into three channels so that internal instructions reach
 * the model but are NEVER rendered as a visible user message (and never read as if
 * the user typed them):
 *
 *  - **visible** — the business context (intent body / spec body / dependency note /
 *    spec-path note / user input). It is what the client sees echoed as `user_text`
 *    AND the body of the model's user turn. Its visibility and order are unchanged.
 *  - **systemInstruction** — internal natural-language instruction (the SDD work
 *    contract, the spec-authoring contract, the intent analyst role). It rides the
 *    vendor's system channel (claude's preset system append; codex folds it ahead of
 *    the user turn since it has no separate system role). Never echoed.
 *  - **userTurnPrefix** — a slash-command dev skill (e.g. `/dev`). A slash command
 *    only expands when it leads the user turn, so it cannot live in the system
 *    payload; it is prepended to the MODEL user turn only and never echoed. The
 *    client therefore never sees it, while its execution semantics are preserved.
 *
 * The client echo (`user_text`) always carries `visible` alone — that is the single
 * invariant the "client never sees internal instructions" guarantee rests on.
 */

/** The two non-visible delivery channels a caller may attach to a turn. */
export interface RunInject {
  /** Internal natural-language instruction for the vendor system channel; never echoed. */
  systemInstruction?: string
  /**
   * Slash-command dev-skill prefix prepended to the MODEL user turn only (a slash
   * command must lead the user turn to expand); never echoed.
   */
  userTurnPrefix?: string
}

/**
 * The claude-path model user turn: the slash-command prefix + the visible body. The
 * `systemInstruction` does NOT belong here — it rides claude's preset system append.
 */
export function claudeUserTurn(visible: string, inject?: RunInject): string {
  return `${inject?.userTurnPrefix ?? ''}${visible}`
}

/**
 * The driver-path (codex) model prompt. Codex has no separate system role, so the
 * internal instruction is folded ahead of the user turn — it still never reaches the
 * client echo, which carries `visible` only (HS-R6). `system` is the resolved system
 * text (an intent/spec profile's append, when present); otherwise the caller's
 * `inject.systemInstruction` is used.
 */
export function driverModelPrompt(
  visible: string,
  system: string | undefined,
  inject?: RunInject,
): string {
  const userTurn = `${inject?.userTurnPrefix ?? ''}${visible}`
  const sys = system ?? inject?.systemInstruction ?? ''
  return sys ? `${sys}\n\n${userTurn}` : userTurn
}
