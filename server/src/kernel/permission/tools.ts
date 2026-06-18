/**
 * Permission gate policy — tool-name constants + the pure intent classifier
 * + the AskUserQuestion answer-injection helper (C-SEC, server refactor 3/3,
 * sunk from the old `claude.ts`). A pure leaf both the gateway and the run loop
 * (`kernel/agent`, for the SDK-level disallowed-tools lock) import, with no SDK /
 * consensus / registry dependency — so the gateway↔agent boundary stays acyclic.
 */
import path from 'node:path'

/** The c3 `save_intents` MCP tool's fully-qualified name (server name `c3`). */
export const SAVE_INTENTS_TOOL = 'mcp__c3__save_intents'

/** The c3 `find_intents` read-only MCP tool's fully-qualified name. */
export const FIND_INTENTS_TOOL = 'mcp__c3__find_intents'

/** The c3 `view_intent` read-only MCP tool's fully-qualified name. */
export const VIEW_INTENT_TOOL = 'mcp__c3__view_intent'

/**
 * The read-only c3 MCP query tools the intent agent may call without a
 * prompt. They only read the project's own ledger (project-bound in the tool
 * closure), so the gate treats them like the read-class built-ins — unlike
 * `save_intents`, which still raises a human confirmation.
 */
export const INTENT_QUERY_TOOLS = new Set([FIND_INTENTS_TOOL, VIEW_INTENT_TOOL])

/**
 * Tools hard-disabled (SDK level) for the intent-communication agent — the
 * source-of-truth read-only lock, paired with the intent gate's
 * deny-by-default. `Bash` covers every shell sub-command, so it isn't enumerated.
 * `Task` and `SlashCommand` are essential: a spawned sub-agent's tool calls don't
 * pass through the parent `canUseTool`, and a slash command could run an
 * arbitrary skill — either would bypass the gateway, so both must be cut here.
 */
export const INTENT_DISALLOWED_TOOLS = [
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
 * Read-only tools the intent-communication agent may use without a prompt
 * ("read project material freely"). Anything not here — and not
 * `save_intents` — is denied by the intent gate (deny-by-default).
 */
export const INTENT_READ_TOOLS = new Set([
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
 * Pure classification of a tool for the intent (read-only) gate, so the
 * routing is unit-testable (the live `canUseTool` closure is otherwise only
 * reachable via live-LLM e2e). Deny-by-default:
 *  - `allow` — read-class built-ins + the read-only c3 query tools (no prompt).
 *  - `confirm-save` — `save_intents` (raises a human confirmation).
 *  - `ask` — `AskUserQuestion` (clarifying-only; gate still applies the
 *    `askQuestions` input guard and routes via answer-injection).
 *  - `deny` — everything else.
 */
export type IntentToolDecision = 'allow' | 'confirm-save' | 'ask' | 'deny'
export function classifyIntentTool(toolName: string): IntentToolDecision {
  if (INTENT_READ_TOOLS.has(toolName) || INTENT_QUERY_TOOLS.has(toolName)) return 'allow'
  if (toolName === SAVE_INTENTS_TOOL) return 'confirm-save'
  if (toolName === 'AskUserQuestion') return 'ask'
  return 'deny'
}

/**
 * Write-class built-in tools — the ones the spec gate must path-check (they all
 * carry a target file path) rather than hard-block. Kept OUT of
 * {@link SPEC_DISALLOWED_TOOLS} on purpose: they must reach `canUseTool` so the
 * gate can decide per-path, whereas the disallowed list is an SDK-level hard cut.
 */
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

/**
 * Tools hard-disabled (SDK level) for the spec-authoring agent. A spec session
 * writes a markdown document and needs no shell / sub-agent / slash command —
 * any of which would bypass the path-level write gate (e.g. `Bash echo > file`
 * never reaches `canUseTool`). The write-class tools are deliberately ABSENT
 * (the spec gate path-checks them); everything dangerous is cut here.
 */
export const SPEC_DISALLOWED_TOOLS = ['Bash', 'BashOutput', 'KillShell', 'Task', 'SlashCommand']

/**
 * Extract the target file path(s) from a write-tool input. The field name
 * varies by tool (`file_path` for Write/Edit/MultiEdit, `notebook_path` for
 * NotebookEdit); `path` is accepted defensively. Returns `[]` when no path is
 * found — the spec gate treats that as fail-closed (deny).
 */
export function extractWriteTargets(input: unknown): string[] {
  const o = (input ?? {}) as Record<string, unknown>
  const fp = o.file_path ?? o.notebook_path ?? o.path
  return typeof fp === 'string' && fp.length > 0 ? [fp] : []
}

/**
 * True iff `target` resolves strictly within `root`. Resolves both sides and
 * checks `path.relative` does not escape — defeating both `../` traversal and
 * the prefix-confusion bug (`.specsX` vs `.specs`, where a raw `startsWith`
 * would wrongly match). A `target` equal to `root` itself counts as inside.
 */
export function isInside(root: string, target: string): boolean {
  const rootAbs = path.resolve(root)
  const tgtAbs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(rootAbs, target)
  const rel = path.relative(rootAbs, tgtAbs)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
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
