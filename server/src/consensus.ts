/**
 * Multi-agent consensus voting over a pending permission request.
 *
 * When enabled (system settings), a sensitive tool call is first put to the
 * *other* configured agents — every agent except the one the session runs on.
 * Each voter receives the recent conversation context plus the tool name and
 * input (the question + options) and returns an allow/deny verdict with a brief
 * reason, via a one-shot, tool-disabled Claude query under its own launch
 * overrides. The session's own agent then acts as the decider and summarizes the
 * opinions in one line (with a deterministic code fallback).
 *
 * - All voters agree ⇒ {@link ConsensusOutcome.unanimous} with a `decision`; the
 *   caller auto-resolves and shows a `consensus_auto` line.
 * - Split or any abstention ⇒ no decision; the caller asks the human, attaching
 *   the opinions to the `permission_request`.
 *
 * Voting is best-effort: a voter that errors or returns no parseable answer
 * abstains (which, being non-unanimous, defers to the human — the safe default).
 */

import { query } from '@anthropic-ai/claude-agent-sdk'
import type { AgentConfig, ConsensusOutcome, ConsensusVote } from '@ccc/shared/protocol'
import { consensusVoters, isConsensusEnabled, launchForAgent, resolveAgent } from './settings.js'
import { findClaudeExecutable } from './claude.js'
import { fallbackSummary, oneLine, parseVote, tally, voterPrompt } from './consensus-tally.js'

export interface ConsensusParams {
  /** The resolved agent id the session runs on (excluded from voting). */
  currentAgentId: string | null
  toolName: string
  input: unknown
  /** Recent conversation text the voters reason over. */
  context: string
  /** Working directory for the advisor queries — the active workspace path. */
  cwd: string
  /** Aborts every in-flight advisor query when the run is torn down. */
  signal: AbortSignal
}

/**
 * Run one agent for a single non-interactive turn and return its assistant text.
 * Tools are denied so the advisor reasons from the provided context only; no
 * setting sources are loaded so the call stays light (no CLAUDE.md/hooks/Skills).
 */
async function askAgentOnce(
  agent: AgentConfig,
  prompt: string,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  const launch = launchForAgent(agent)
  const claudePath = findClaudeExecutable()
  const q = query({
    prompt,
    options: {
      cwd,
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      ...(launch.envOverrides ? { env: { ...process.env, ...launch.envOverrides } } : {}),
      ...(launch.model ? { model: launch.model } : {}),
      permissionMode: 'default',
      // Advisor must not act — it only answers from context.
      canUseTool: async () => ({ behavior: 'deny', message: 'consensus advisor: no tools' }),
    },
  })

  const onAbort = () => {
    try {
      const p = q.interrupt?.()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch {
      /* noop */
    }
  }
  signal.addEventListener('abort', onAbort, { once: true })

  let text = ''
  try {
    for await (const m of q) {
      if (signal.aborted) break
      if (m.type === 'assistant') {
        const content = (m as { message?: { content?: unknown[] } }).message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as { type?: string; text?: string }
            if (b.type === 'text' && typeof b.text === 'string') text += b.text
          }
        }
      } else if (m.type === 'result') {
        break
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  return text.trim()
}

/** Ask the session's own agent to summarize the opinions in one sentence. */
async function summarize(
  currentAgentId: string | null,
  toolName: string,
  votes: ConsensusVote[],
  unanimous: boolean,
  decision: 'allow' | 'deny' | null,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  const fallback = fallbackSummary(votes, unanimous, decision)
  if (signal.aborted) return fallback
  try {
    const decider = resolveAgent(currentAgentId)
    const prompt = [
      `Several advisor agents voted on whether to allow the tool "${toolName}". Their votes:`,
      ...votes.map((v) => `- ${v.agentName}: ${v.decision} — ${v.reason || '(no reason)'}`),
      '',
      'Write ONE short sentence in Chinese summarizing their collective opinion for a human who must make the final call. Output only that sentence, no preamble.',
    ].join('\n')
    const text = await askAgentOnce(decider, prompt, cwd, signal)
    return oneLine(text) || fallback
  } catch {
    return fallback
  }
}

/**
 * Run a consensus vote for one permission request. Returns `null` when consensus
 * is disabled or there are no other agents to vote — the caller then falls back
 * to the plain human prompt.
 */
export async function runConsensusVote(p: ConsensusParams): Promise<ConsensusOutcome | null> {
  if (!isConsensusEnabled()) return null
  const voters = consensusVoters(p.currentAgentId)
  if (voters.length === 0) return null

  const prompt = voterPrompt(p.toolName, p.input, p.context)
  const votes: ConsensusVote[] = await Promise.all(
    voters.map(async (agent): Promise<ConsensusVote> => {
      try {
        const text = await askAgentOnce(agent, prompt, p.cwd, p.signal)
        const parsed = parseVote(text)
        if (!parsed) {
          return {
            agentId: agent.id,
            agentName: agent.name,
            decision: 'abstain',
            reason: oneLine(text).slice(0, 200) || 'no parseable answer',
          }
        }
        return { agentId: agent.id, agentName: agent.name, ...parsed }
      } catch (err) {
        return {
          agentId: agent.id,
          agentName: agent.name,
          decision: 'abstain',
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )

  const { unanimous, decision } = tally(votes)
  const summary = await summarize(
    p.currentAgentId,
    p.toolName,
    votes,
    unanimous,
    decision,
    p.cwd,
    p.signal,
  )
  return { votes, summary, unanimous, decision }
}
