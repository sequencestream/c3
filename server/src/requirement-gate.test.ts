/**
 * Tests for the requirement read-only lock's *static* policy surface (US-3 §4.2/§4.3).
 *
 * The live `canUseTool` decision lives in a closure inside `runClaude` (over the
 * SDK `query`), so the runtime allow/deny path itself is only reachable via a
 * live-LLM e2e (see test-report). What IS unit-testable — and is the load-bearing
 * source-of-truth for the lock — are the exported constants that configure the
 * SDK and the gate: the hard `disallowedTools` list and the save-tool name. These
 * tests pin them so a regression (e.g. dropping `Task`/`SlashCommand`) is caught.
 */
import { describe, expect, it } from 'vitest'
import { REQUIREMENT_DISALLOWED_TOOLS, SAVE_REQUIREMENTS_TOOL, withAnswers } from './claude.js'

describe('requirement gate — disallowed-tools lock', () => {
  it('hard-disables every write/exec/escape tool the design requires (§4.3)', () => {
    // AC-3.2: comm agent never edits/writes/runs commands. The SDK-level list is
    // the first layer of the read-only lock (the gate deny-by-default is the 2nd).
    const required = [
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'Bash',
      'BashOutput',
      'KillShell',
      'Task',
      'SlashCommand',
    ]
    for (const tool of required) {
      expect(REQUIREMENT_DISALLOWED_TOOLS).toContain(tool)
    }
  })

  it('includes Task and SlashCommand specifically (sub-agent / skill escape hatches)', () => {
    // Design §4.3 + code-review: a sub-agent's tool calls bypass the parent
    // canUseTool, and a slash command can run an arbitrary skill — neither can be
    // caught by the gate alone, so both MUST be cut at the SDK level. Guard them
    // explicitly so a future trim of the list can't silently reopen the hole.
    expect(REQUIREMENT_DISALLOWED_TOOLS).toContain('Task')
    expect(REQUIREMENT_DISALLOWED_TOOLS).toContain('SlashCommand')
  })

  it('does not list read tools (they auto-allow) nor the save tool (it prompts)', () => {
    // §4.2: read tools pass through freely; save_requirements is gated by a human
    // prompt — neither belongs in the hard-disabled set.
    for (const readTool of ['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch']) {
      expect(REQUIREMENT_DISALLOWED_TOOLS).not.toContain(readTool)
    }
    expect(REQUIREMENT_DISALLOWED_TOOLS).not.toContain(SAVE_REQUIREMENTS_TOOL)
    expect(REQUIREMENT_DISALLOWED_TOOLS).not.toContain('save_requirements')
  })

  it('does not hard-disable AskUserQuestion (clarifying-only, gate routes it via answer injection)', () => {
    // The requirement agent may ASK the user to clarify (no write/exec side
    // effect). The gate handles it through the standard answer-injection flow, so
    // it must NOT sit in the SDK-level hard-disabled list — otherwise the answer
    // panel could never render. Guard against a future trim accidentally adding it.
    //
    // This pins HALF of the AskUserQuestion contract — that it isn't *silently*
    // closed at the SDK level. The other half (the requirement gate routes it to
    // the answer panel + injects answers, instead of falling through to the
    // deny-by-default branch) lives in the `canUseTool` closure and is only
    // reachable via live-LLM e2e — see the `ask_gated` / `ask_answer_injected`
    // checks in scripts/e2e/e2e-requirement-test.mjs.
    expect(REQUIREMENT_DISALLOWED_TOOLS).not.toContain('AskUserQuestion')
  })

  it('names the save tool with the mcp__<server>__<tool> convention', () => {
    // The gate keys on this exact name to route the confirmation prompt, and the
    // MCP server registers `save_requirements` under server `c3`.
    expect(SAVE_REQUIREMENTS_TOOL).toBe('mcp__c3__save_requirements')
  })
})

describe('requirement gate — AskUserQuestion answer injection (withAnswers)', () => {
  // `withAnswers` is the deterministic, side-effect-free core of the gate's
  // AskUserQuestion handling: when the human answers the panel, the gate returns
  // `{ behavior: 'allow', updatedInput: withAnswers(input, answers) }` so the SDK
  // echoes the answers back to the model (the SDK reads answers ONLY from a
  // pre-filled `input.answers` map). The runtime decision to *take* this path
  // (instead of the deny-by-default fallback) is e2e-only, but the injection SHAPE
  // it produces is pure and pinned here — a regression that drops/misplaces the
  // answers would silently break the prompt even with the routing intact.

  it('merges the answers under `input.answers` keyed by question text', () => {
    const input = { questions: [{ question: 'Pick one?' }] }
    const out = withAnswers(input, { 'Pick one?': 'A' })
    expect(out.answers).toEqual({ 'Pick one?': 'A' })
  })

  it('preserves every other field of the original tool input', () => {
    const input = { questions: [{ question: 'Q?' }], header: 'H', extra: 42 }
    const out = withAnswers(input, { 'Q?': 'yes' })
    expect(out.questions).toEqual([{ question: 'Q?' }])
    expect(out.header).toBe('H')
    expect(out.extra).toBe(42)
  })

  it('keeps any pre-existing answers and lets the new ones win on conflict', () => {
    const input = { answers: { kept: 'old', shared: 'old' } }
    const out = withAnswers(input, { shared: 'new', added: 'fresh' })
    // Prior answers survive; supplied answers override matching keys and add new ones.
    expect(out.answers).toEqual({ kept: 'old', shared: 'new', added: 'fresh' })
  })

  it('defaults `annotations` to {} when the input omits it (SDK shape)', () => {
    const out = withAnswers({ questions: [] }, {})
    expect(out.annotations).toEqual({})
  })

  it('does not mutate the original input object', () => {
    const input = { questions: [{ question: 'Q?' }], answers: { a: '1' } }
    const snapshot = JSON.stringify(input)
    withAnswers(input, { b: '2' })
    expect(JSON.stringify(input)).toBe(snapshot)
  })

  it('tolerates null/undefined input without throwing (deny path never reaches here, but be safe)', () => {
    expect(() => withAnswers(null, { q: 'a' })).not.toThrow()
    expect(withAnswers(null, { q: 'a' }).answers).toEqual({ q: 'a' })
  })
})
