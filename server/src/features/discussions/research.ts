/**
 * The read-only research step run when a discussion is created. It reuses the
 * `discussion-research` gate (see `claude.ts`): the agent may read project material
 * (Read/Grep/Glob/…) and search the web (WebFetch/WebSearch) but cannot write, run
 * shells, or spawn sub-agents. There is no save tool — the server captures the
 * agent's final text and writes it back to the discussion's `researchResult` field
 * (the user's original `context` is left untouched).
 */
import type { Discussion, ResearchMessage, SessionKind } from '@ccc/shared/protocol'
import { resolveWorkspaceRoot } from '../../state.js'
import { getDiscussionType, type DiscussionTypeDef } from '@ccc/shared/discussion-types'
import { runClaude } from '../../kernel/agent/index.js'
import { INTENT_DISALLOWED_TOOLS } from '../../kernel/permission/index.js'
import { getUiLangName } from '../../kernel/config/index.js'

/**
 * This step's SessionKind: the research pass calls {@link runClaude} directly
 * (under the `discussion-research` gate), NOT through the run bus (its execution
 * form is `runKind: 'internal'`). Tagged `'discussion'` — it belongs to the
 * discussion flow, same business origin as the orchestrator.
 */
const SESSION_KIND: SessionKind = 'discussion'

/** System-prompt append that frames the unattended, read-only research run. */
export const DISCUSSION_RESEARCH_PROMPT = `You are the discussion's "context researcher". Your sole task: research and gather the background facts for an upcoming discussion.
- Read-only: use Read/Grep/Glob to read this project's material and WebSearch/WebFetch to gather background from the web; do not write files, run commands, or ask questions.
- Around the discussion's type + goal, collect the genuinely relevant facts, current state, constraints, and open questions / points to clarify.
- Describe the current state only: do NOT offer any options, candidate approaches, solution ideas, recommendations, or conclusions; state the project's current situation objectively and leave judgement and divergence to the discussion itself.
- Treat the user's original context as a clue — verify and expand on it rather than merely restating it.
- Output only the research findings themselves (structured bullet points are fine); no pleasantries, and do not explain what you did.`

/**
 * Build the research agent's user prompt from the discussion's type/goal/context.
 * Pure (no I/O) so it can be unit tested. `def` defaults to the discussion's type
 * when omitted (kept as a param so tests don't depend on the catalog).
 */
export function buildResearchPrompt(
  input: { goal: string; context: string; workspacePath: string },
  def: DiscussionTypeDef | undefined,
  langName?: string,
): string {
  const typeLine = def
    ? `Discussion type: ${def.label} — ${def.description}`
    : 'Discussion type: (unspecified)'
  const ctx = input.context.trim()
  const lang = langName ?? 'English'
  return [
    typeLine,
    `Discussion goal: ${input.goal.trim() || '(not provided)'}`,
    `Project path: ${input.workspacePath}`,
    ctx ? `User-provided initial context:\n${ctx}` : 'The user provided no initial context.',
    '',
    'Read the relevant project material and research background from the web, then produce the research findings (output the findings only).',
    '',
    `Respond in ${lang}.`,
  ].join('\n')
}

/**
 * Outcome of a research run. `ok` is `false` only when the agent run threw — the
 * caller uses it to gate auto-start (a failed research never auto-starts the
 * discussion; it stays a `draft` for a manual Start). `researchResult` is the
 * completed text on success, or `''` on empty output / failure — the user's
 * original `context` is never substituted in, so a research miss leaves
 * `researchResult` empty rather than echoing the user's input.
 */
export interface DiscussionResearchResult {
  ok: boolean
  researchResult: string
}

/** One streamed research item before the server stamps `discussionId`/`createdAt`. */
export type ResearchStreamItem = Pick<ResearchMessage, 'seq' | 'kind' | 'content'>

/** Options for {@link researchDiscussionContext}. `onMessage` streams the run's turns. */
export interface ResearchRunOptions {
  /**
   * Called for each observable research turn so the caller can broadcast it live:
   * an `assistant_text` turn (`kind: 'text'`) or a tool call (`kind: 'tool'`,
   * `content` is the tool name). `seq` is monotonic (1-based) within this run.
   */
  onMessage?: (item: ResearchStreamItem) => void
}

/**
 * Decide whether a discussion is eligible for auto-start after research completes.
 * Pure (no I/O) so it is unit-tested. Eligible only when the (re-fetched) record
 * still exists, is a `draft`, and has no live run — guarding against a discussion
 * that was manually Started or cancelled while research was in flight.
 */
export function canAutoStartDiscussion(
  discussion: Discussion | null | undefined,
  hasActiveRun: boolean,
): boolean {
  return !!discussion && discussion.status === 'draft' && !hasActiveRun
}

/**
 * Run the read-only research agent for a freshly-created discussion and resolve to
 * its completed `researchResult` plus an `ok` flag. Best-effort: on empty output
 * `researchResult` is `''`; `ok=false` only when the run threw, so a research miss
 * never blocks creation. The discussion's `context` is read as a clue but never
 * written back.
 */
export async function researchDiscussionContext(
  discussion: Discussion,
  opts: ResearchRunOptions = {},
): Promise<DiscussionResearchResult> {
  console.log(
    `[c3:discussion] (${SESSION_KIND}) research「${discussion.goal.slice(0, 60)}」(${discussion.id})`,
  )
  const def = getDiscussionType(discussion.type)
  const prompt = buildResearchPrompt(
    {
      goal: discussion.goal,
      context: discussion.context,
      workspacePath: resolveWorkspaceRoot(discussion.workspaceId)!,
    },
    def,
    getUiLangName(),
  )
  const abort = new AbortController()
  let captured = ''
  let seq = 0
  let ok = true
  try {
    await runClaude({
      prompt,
      cwd: resolveWorkspaceRoot(discussion.workspaceId)!,
      signal: abort.signal,
      // Pinned to `default` so the gateway's canUseTool always fires.
      permissionMode: 'default',
      appendSystemPrompt: DISCUSSION_RESEARCH_PROMPT,
      disallowedTools: INTENT_DISALLOWED_TOOLS,
      gate: 'discussion-research',
      send: (m) => {
        // The agent's last assistant turn is the completed context; every assistant
        // turn and tool call is also streamed out so the right pane shows the run
        // flowing live (best-effort — a streaming throw must not fail research).
        if (m.type === 'assistant_text') {
          captured = m.text
          opts.onMessage?.({ seq: ++seq, kind: 'text', content: m.text })
        } else if (m.type === 'tool_use') {
          opts.onMessage?.({ seq: ++seq, kind: 'tool', content: m.toolName })
        }
      },
    })
  } catch (err) {
    ok = false
    console.warn(
      `[c3] discussion research failed (${discussion.id}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  const out = captured.trim()
  return { ok, researchResult: out }
}
