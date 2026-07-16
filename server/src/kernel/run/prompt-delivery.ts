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
 *    vendor's system channel (claude's preset system append; codex, having no
 *    separate system role, places it as a leading input text item at position 0 —
 *    a byte-stable prefix the API prompt cache keys off). Never echoed.
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
  /**
   * Skip the arapuca sandbox for this run even when the project/session would
   * otherwise sandbox. Set when the user answers a `sandbox_conflict_request` with
   * `bypass` (run the system-auth agent on the host this turn). Default false.
   */
  bypassSandbox?: boolean
}

/**
 * The model user turn, vendor-neutral: the slash-command prefix (when present) +
 * the visible body. The `systemInstruction` does NOT belong here — it rides the
 * vendor's system channel (claude's preset system append, codex's leading input
 * text item). Both the claude launcher and the codex driver-path deliver the
 * internal instruction OUTSIDE this string, so the user turn never carries it and
 * the client echo still shows `visible` alone.
 */
export function modelUserTurn(visible: string, inject?: RunInject): string {
  return `${inject?.userTurnPrefix ?? ''}${visible}`
}
