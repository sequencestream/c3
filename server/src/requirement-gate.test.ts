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
import { REQUIREMENT_DISALLOWED_TOOLS, SAVE_REQUIREMENTS_TOOL } from './claude.js'

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

  it('names the save tool with the mcp__<server>__<tool> convention', () => {
    // The gate keys on this exact name to route the confirmation prompt, and the
    // MCP server registers `save_requirements` under server `c3`.
    expect(SAVE_REQUIREMENTS_TOOL).toBe('mcp__c3__save_requirements')
  })
})
