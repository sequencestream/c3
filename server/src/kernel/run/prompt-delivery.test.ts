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
import { claudeUserTurn, driverModelPrompt } from './prompt-delivery.js'

const VISIBLE = 'Cache the endpoint\n\nAdd an LRU cache.'
const SYSTEM = 'You are a spec-driven development agent. Hard constraints: ...'

describe('claudeUserTurn — model user turn for the claude path', () => {
  it('prepends a slash-command prefix so it leads the turn (and can expand)', () => {
    expect(claudeUserTurn(VISIBLE, { userTurnPrefix: '/dev ' })).toBe(`/dev ${VISIBLE}`)
  })

  it('is the bare visible body when no prefix is injected', () => {
    expect(claudeUserTurn(VISIBLE)).toBe(VISIBLE)
    expect(claudeUserTurn(VISIBLE, {})).toBe(VISIBLE)
  })

  it('never folds the system instruction into the user turn (it rides system append)', () => {
    expect(
      claudeUserTurn(VISIBLE, { systemInstruction: SYSTEM, userTurnPrefix: '/dev ' }),
    ).not.toContain(SYSTEM)
  })
})

describe('driverModelPrompt — model prompt for the driver (codex) path', () => {
  it('folds the resolved system text ahead of the user turn (codex has no system role)', () => {
    const p = driverModelPrompt(VISIBLE, SYSTEM)
    expect(p).toBe(`${SYSTEM}\n\n${VISIBLE}`)
  })

  it('falls back to inject.systemInstruction when no profile system text is given', () => {
    const p = driverModelPrompt(VISIBLE, undefined, { systemInstruction: SYSTEM })
    expect(p).toBe(`${SYSTEM}\n\n${VISIBLE}`)
  })

  it('folds both the system instruction and the slash-command prefix into the model prompt', () => {
    const p = driverModelPrompt(VISIBLE, undefined, {
      systemInstruction: SYSTEM,
      userTurnPrefix: '/dev ',
    })
    expect(p).toBe(`${SYSTEM}\n\n/dev ${VISIBLE}`)
    expect(p).toContain(SYSTEM)
    expect(p).toContain('/dev ')
  })

  it('is the bare visible body when nothing internal is injected', () => {
    expect(driverModelPrompt(VISIBLE, undefined)).toBe(VISIBLE)
    expect(driverModelPrompt(VISIBLE, '', {})).toBe(VISIBLE)
  })
})
