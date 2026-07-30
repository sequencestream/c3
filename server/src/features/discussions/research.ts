/**
 * The read-only research step run when a discussion is created. It reuses the
 * `discussion-research` gate (see `claude.ts`): the agent may read project material
 * (Read/Grep/Glob/…) and search the web (WebFetch/WebSearch) but cannot write, run
 * shells, or spawn sub-agents. There is no save tool — the server captures the
 * agent's final text and writes it back to the discussion's `researchResult` field
 * (the user's original `context` is left untouched).
 *
 * The run is a FIRST-CLASS SESSION: it reports its vendor session id
 * ({@link ResearchRunOptions.onSessionId}) and streams its raw wire events
 * ({@link ResearchRunOptions.onWire}) so the caller can bind a `SessionRuntime` to
 * it. Everything that makes a session a session then follows for free — the vendor
 * writes the transcript, c3's ordinary session-open path replays it, and a
 * follow-up prompt resumes it through the generic launch path (which re-applies
 * this module's read-only profile via the runtime's research marker).
 */
import type {
  AgentConfig,
  Discussion,
  ResearchMessageBody,
  ServerToClient,
  SessionKind,
} from '@ccc/shared/protocol'
import { SYSTEM_AGENT_ID } from '@ccc/shared/protocol'
import { resolveWorkspaceRoot } from '../../state.js'
import { getDiscussionType, type DiscussionTypeDef } from '@ccc/shared/discussion-types'
import { runClaude } from '../../kernel/agent/index.js'
import { INTENT_DISALLOWED_TOOLS } from '../../kernel/permission/index.js'
import {
  bindClaudeRelay,
  launchForAgent,
  resolveAgent,
  resolveFirstAgentOfVendor,
  unbindRelay,
} from '../../kernel/agent-config/index.js'
import { getAgentLangName } from '../../kernel/config/index.js'

/**
 * This step's SessionKind: the research pass calls {@link runClaude} directly
 * (under the `discussion-research` gate), NOT through the run bus (its execution
 * form is `runKind: 'internal'`). Tagged `'discussion'` — it belongs to the
 * discussion flow, same business origin as the orchestrator.
 */
const SESSION_KIND: SessionKind = 'discussion'

/**
 * The agent the research pass runs on. The research loop is claude-hardwired
 * ({@link runClaude}), so it must resolve to a CLAUDE agent even when the project's
 * default agent is another vendor — the session is bound to this agent, and a
 * cross-vendor binding could never resume it on the follow-up turn.
 * `resolveFirstAgentOfVendor` falls back to the default agent when no claude agent
 * is enabled; that fallback is replaced here by the built-in system agent, which is
 * always claude with no overrides (i.e. the vendor CLI's own login).
 */
export function resolveResearchAgent(): AgentConfig {
  const agent = resolveFirstAgentOfVendor('claude')
  return agent.vendor === 'claude' ? agent : resolveAgent(SYSTEM_AGENT_ID)
}

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

/**
 * One streamed research item before the server stamps `discussionId`/`createdAt`.
 * `seq` + the shared {@link ResearchMessageBody} variant — built from the union
 * directly so the discriminated payload (text/tool_use/tool_result) is preserved
 * (an `Omit<ResearchMessage, …>` would collapse it to the common keys).
 */
export type ResearchStreamItem = { seq: number } & ResearchMessageBody

/** Options for {@link researchDiscussionContext}. `onMessage` streams the run's turns. */
export interface ResearchRunOptions {
  /**
   * Called for each observable research turn so the caller can broadcast it live:
   * a `text` turn (the researcher's assistant text), a `tool_use` (the call's
   * id/name/input), or a `tool_result` (the same call's returned content + error
   * flag, correlated by `toolUseId`). `seq` is monotonic (1-based) within this run
   * and is assigned to every observable item so live append and snapshot de-dupe
   * share one ordering.
   */
  onMessage?: (item: ResearchStreamItem) => void
  /**
   * The vendor session id, reported once as soon as the vendor knows it. This is
   * what promotes the run to a real session: the caller persists it on the
   * discussion, registers a `SessionRuntime` under it and projects a session row.
   * Never called when the run fails before the vendor reports an id.
   */
  onSessionId?: (sessionId: string) => void
  /**
   * Every raw wire event this run emits, in order, so the caller can fan it into
   * the session runtime (`emit`) and any viewer of the research session sees the
   * unattended run live. Distinct from {@link onMessage}, which is the narrower,
   * runtime-only research-stream projection the 「过程会话」 tab keeps rendering.
   */
  onWire?: (event: ServerToClient) => void
  /**
   * External stop control. The Stop button on the research session's status bar
   * aborts the run through the runtime's abort controller, which is this signal.
   * Omitted ⇒ the run owns a private controller and can only end on its own.
   */
  signal?: AbortSignal
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
    getAgentLangName(),
  )
  const abort = new AbortController()
  const signal = opts.signal ?? abort.signal
  // Route a custom provider through the loopback relay (ADR-0029), exactly as the
  // generic launch path does — the follow-up turns run through that path on this
  // same agent, so the first (unattended) turn must connect the same way.
  const agent = resolveResearchAgent()
  const launch = launchForAgent(agent)
  const claudeRelay = bindClaudeRelay(launch.relayCandidates)
  const envOverrides = claudeRelay
    ? { ...launch.envOverrides, ...claudeRelay.envOverrides }
    : launch.envOverrides
  let captured = ''
  let seq = 0
  let ok = true
  try {
    await runClaude({
      prompt,
      // Discussion research runs at the workspace root (no worktree), so the
      // effective cwd and the config/audit root are the same path.
      cwd: resolveWorkspaceRoot(discussion.workspaceId)!,
      workspacePath: resolveWorkspaceRoot(discussion.workspaceId)!,
      signal,
      // Pinned to `default` so the gateway's canUseTool always fires.
      permissionMode: 'default',
      appendSystemPrompt: DISCUSSION_RESEARCH_PROMPT,
      disallowedTools: INTENT_DISALLOWED_TOOLS,
      gate: 'discussion-research',
      currentAgentId: agent.id,
      ...(launch.model ? { model: launch.model } : {}),
      ...(envOverrides ? { envOverrides } : {}),
      onSessionId: (sid) => opts.onSessionId?.(sid),
      send: (m) => {
        // Fan the raw event into the run's session runtime first, so a viewer of
        // the research session sees the unattended run exactly as it happens.
        opts.onWire?.(m)
        // The agent's last assistant turn is the completed context; every assistant
        // turn, tool call, and tool result is also streamed out so the right pane
        // renders the run as a standard transcript with collapsible tool blocks
        // (best-effort — a streaming throw must not fail research).
        if (m.type === 'assistant_text') {
          captured = m.text
          opts.onMessage?.({ seq: ++seq, kind: 'text', text: m.text })
        } else if (m.type === 'tool_use') {
          opts.onMessage?.({
            seq: ++seq,
            kind: 'tool_use',
            toolUseId: m.toolUseId,
            toolName: m.toolName,
            input: m.input,
          })
        } else if (m.type === 'tool_result') {
          opts.onMessage?.({
            seq: ++seq,
            kind: 'tool_result',
            toolUseId: m.toolUseId,
            content: m.content,
            isError: m.isError,
          })
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
  } finally {
    if (claudeRelay) unbindRelay(claudeRelay.token)
  }
  const out = captured.trim()
  return { ok, researchResult: out }
}
