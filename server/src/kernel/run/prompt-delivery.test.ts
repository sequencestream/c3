/**
 * Prompt-delivery split — the vendor-neutral core of hide-session-system-instructions.
 *
 * Two invariants, both vendor-agnostic:
 *  - the internal instruction (system contract) and the slash-command prefix reach
 *    the MODEL (claude's user turn / system append, or codex's folded prompt);
 *  - neither ever appears in `visible`, the single string the client echo carries.
 *
 * `visible` is what `launchRun` / `runViaDriver` emit as `user_text`; these helpers
 * shape only what the model receives, so a test that the helpers never fold the
 * internal text back into `visible` pins the client-invisibility guarantee.
 */
import { describe, expect, it } from 'vitest'
import { modelUserTurn } from './prompt-delivery.js'

const VISIBLE = 'Cache the endpoint\n\nAdd an LRU cache.'
const SYSTEM = 'You are a spec-driven development agent. Hard constraints: ...'

describe('modelUserTurn — the model user turn (both vendor paths)', () => {
  it('prepends a slash-command prefix so it leads the turn (and can expand)', () => {
    expect(modelUserTurn(VISIBLE, { userTurnPrefix: '/dev ' })).toBe(`/dev ${VISIBLE}`)
  })

  it('is the bare visible body when no prefix is injected', () => {
    expect(modelUserTurn(VISIBLE)).toBe(VISIBLE)
    expect(modelUserTurn(VISIBLE, {})).toBe(VISIBLE)
  })

  it('never folds the system instruction into the user turn (it rides the system channel)', () => {
    // The system instruction is delivered separately (claude's preset system append,
    // codex's leading input text item) — it must never appear in the user turn, on
    // either vendor path.
    expect(
      modelUserTurn(VISIBLE, { systemInstruction: SYSTEM, userTurnPrefix: '/dev ' }),
    ).not.toContain(SYSTEM)
    expect(modelUserTurn(VISIBLE, { systemInstruction: SYSTEM })).toBe(VISIBLE)
  })
})
