/**
 * Permission gate policy — tool-name constants + the pure requirement classifier
 * + the AskUserQuestion answer-injection helper (C-SEC, server refactor 3/3,
 * sunk from the old `claude.ts`). A pure leaf both the gateway and the run loop
 * (`kernel/agent`, for the SDK-level disallowed-tools lock) import, with no SDK /
 * consensus / registry dependency — so the gateway↔agent boundary stays acyclic.
 */

/** The c3 `save_requirements` MCP tool's fully-qualified name (server name `c3`). */
export const SAVE_REQUIREMENTS_TOOL = 'mcp__c3__save_requirements'

/** The c3 `find_requirements` read-only MCP tool's fully-qualified name. */
export const FIND_REQUIREMENTS_TOOL = 'mcp__c3__find_requirements'

/** The c3 `view_requirement` read-only MCP tool's fully-qualified name. */
export const VIEW_REQUIREMENT_TOOL = 'mcp__c3__view_requirement'

/**
 * The read-only c3 MCP query tools the requirement agent may call without a
 * prompt. They only read the project's own ledger (project-bound in the tool
 * closure), so the gate treats them like the read-class built-ins — unlike
 * `save_requirements`, which still raises a human confirmation.
 */
export const REQUIREMENT_QUERY_TOOLS = new Set([FIND_REQUIREMENTS_TOOL, VIEW_REQUIREMENT_TOOL])

/**
 * Tools hard-disabled (SDK level) for the requirement-communication agent — the
 * source-of-truth read-only lock, paired with the requirement gate's
 * deny-by-default. `Bash` covers every shell sub-command, so it isn't enumerated.
 * `Task` and `SlashCommand` are essential: a spawned sub-agent's tool calls don't
 * pass through the parent `canUseTool`, and a slash command could run an
 * arbitrary skill — either would bypass the gateway, so both must be cut here.
 */
export const REQUIREMENT_DISALLOWED_TOOLS = [
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

/**
 * Read-only tools the requirement-communication agent may use without a prompt
 * ("read project material freely"). Anything not here — and not
 * `save_requirements` — is denied by the requirement gate (deny-by-default).
 */
export const REQUIREMENT_READ_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'LS',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
  'TaskCreate',
  'TaskList',
  'TaskUpdate',
  'TaskGet',
])

/**
 * Pure classification of a tool for the requirement (read-only) gate, so the
 * routing is unit-testable (the live `canUseTool` closure is otherwise only
 * reachable via live-LLM e2e). Deny-by-default:
 *  - `allow` — read-class built-ins + the read-only c3 query tools (no prompt).
 *  - `confirm-save` — `save_requirements` (raises a human confirmation).
 *  - `ask` — `AskUserQuestion` (clarifying-only; gate still applies the
 *    `askQuestions` input guard and routes via answer-injection).
 *  - `deny` — everything else.
 */
export type RequirementToolDecision = 'allow' | 'confirm-save' | 'ask' | 'deny'
export function classifyRequirementTool(toolName: string): RequirementToolDecision {
  if (REQUIREMENT_READ_TOOLS.has(toolName) || REQUIREMENT_QUERY_TOOLS.has(toolName)) return 'allow'
  if (toolName === SAVE_REQUIREMENTS_TOOL) return 'confirm-save'
  if (toolName === 'AskUserQuestion') return 'ask'
  return 'deny'
}

/**
 * Inject `AskUserQuestion` answers into the tool input so the SDK echoes them as
 * the tool result (verified: the tool reads a pre-supplied `answers` map keyed by
 * question text). This is a deliberate, AskUserQuestion-only exception to the
 * gateway's "don't rewrite inputs" rule (PG-R6) — the only headless channel to
 * answer the prompt.
 */
export function withAnswers(
  input: unknown,
  answers: Record<string, string>,
): Record<string, unknown> {
  const base = (input ?? {}) as Record<string, unknown>
  const prior = (base.answers as Record<string, string> | undefined) ?? {}
  return { ...base, answers: { ...prior, ...answers }, annotations: base.annotations ?? {} }
}
