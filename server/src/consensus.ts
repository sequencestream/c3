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

import type {
  AskConsensusOutcome,
  ConsensusOutcome,
  ConsensusVote,
  QuestionConsensus,
} from '@ccc/shared/protocol'
import { resolveAgent, vendorScopedVoters } from './kernel/agent-config/index.js'
import { isConsensusEnabled, isConsensusMajorityEnabled } from './kernel/config/index.js'
import { askAgentOnce } from './agent-once.js'
import {
  askQuestions,
  askVoterPrompt,
  deciderAskPrompt,
  fallbackAskSummary,
  fallbackSummary,
  oneLine,
  parseAskVote,
  parseDeciderAsk,
  parseVote,
  shuffleOptions,
  tally,
  tallyQuestion,
  voterPrompt,
  type AskQuestion,
} from './consensus-tally.js'

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
  if (!isConsensusEnabled(p.cwd)) return null
  const { voters, vendorScope, crossVendorExcluded } = vendorScopedVoters(p.currentAgentId)
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
            agentName: agent.displayName,
            decision: 'abstain',
            reason: oneLine(text).slice(0, 200) || 'no parseable answer',
          }
        }
        return { agentId: agent.id, agentName: agent.displayName, ...parsed }
      } catch (err) {
        return {
          agentId: agent.id,
          agentName: agent.displayName,
          decision: 'abstain',
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )

  // Majority toggle (system setting) decides the adjudication rule; `unanimous`
  // still reports literal unanimity so the summary/console can tell a unanimous
  // verdict from a majority-carried one. See `permission-gateway/consensus.md`.
  const { unanimous, decision } = tally(votes, isConsensusMajorityEnabled(p.cwd))
  const summary = await summarize(
    p.currentAgentId,
    p.toolName,
    votes,
    unanimous,
    decision,
    p.cwd,
    p.signal,
  )
  return { kind: 'tool', votes, summary, unanimous, decision, vendorScope, crossVendorExcluded }
}

/**
 * Decider pass over the per-question tally. In ONE agent call the session's own
 * agent (a) writes the human-facing summary and (b) adjudicates the split
 * questions: where the advisors are in *effective* consensus (a mis-parsed reply,
 * or differently-worded answers that mean the same option), it returns an agreed
 * answer that upgrades the question to unanimous. It only ever upgrades a split
 * question — string-unanimous ones are never re-judged. On abort/error/parse
 * failure the summary falls back to the deterministic line and no upgrade happens
 * (so the question stays split and defers to the human — the safe default).
 */
async function decideAndSummarizeAsk(
  currentAgentId: string | null,
  perQuestion: QuestionConsensus[],
  questions: AskQuestion[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ summary: string; overrides: Map<number, string> }> {
  const fallback = fallbackAskSummary(perQuestion)
  if (signal.aborted) return { summary: fallback, overrides: new Map() }
  try {
    const decider = resolveAgent(currentAgentId)
    // Shuffle the option list shown to the decider (de-bias the fixed order);
    // parse against the ORIGINAL questions — matchOption resolves by label, so
    // tally/injection stay on canonical labels.
    const prompt = deciderAskPrompt(perQuestion, shuffleOptions(questions))
    const text = await askAgentOnce(decider, prompt, cwd, signal)
    const { summary, overrides } = parseDeciderAsk(text, questions)
    return { summary: summary || fallback, overrides }
  } catch {
    return { summary: fallback, overrides: new Map() }
  }
}

/**
 * Consensus over an `AskUserQuestion` prompt: each voter answers every question
 * (option label(s) or a custom reply) rather than voting allow/deny. Returns
 * `null` when consensus is disabled, there are no voters, or the input has no
 * questions — the caller then shows the answer panel without pre-filled opinions.
 */
export async function runAskConsensus(p: ConsensusParams): Promise<AskConsensusOutcome | null> {
  if (!isConsensusEnabled(p.cwd)) return null
  const { voters, vendorScope, crossVendorExcluded } = vendorScopedVoters(p.currentAgentId)
  if (voters.length === 0) return null
  const questions = askQuestions(p.input)
  if (!questions) return null

  // Each voter answers all questions; an errored voter abstains on every question.
  const perAgent = await Promise.all(
    voters.map(async (agent) => {
      // Independent per-voter option ordering dilutes the LLM's positional bias;
      // parse against the ORIGINAL questions so tally/injection key off the
      // canonical labels (matchOption resolves by label content, not by index).
      const prompt = askVoterPrompt(shuffleOptions(questions), p.context)
      try {
        const text = await askAgentOnce(agent, prompt, p.cwd, p.signal)
        return parseAskVote(text, questions, agent.id, agent.displayName)
      } catch {
        return questions.map(() => ({
          agentId: agent.id,
          agentName: agent.displayName,
          optionLabels: [],
          reason: '',
          abstain: true,
        }))
      }
    }),
  )

  // Per-question tally. When the majority toggle is on, `tallyQuestion`
  // deterministically resolves a still-split question to its plurality answer
  // (marking `decidedByMajority`) — a pre-step ahead of the decider, so a
  // majority-resolved question is already `unanimous` and the decider below skips
  // it (it only judges `!unanimous` questions). Priority: literal unanimous →
  // majority → decider rescue; each question is adjudicated at most once.
  const majority = isConsensusMajorityEnabled(p.cwd)
  const perQuestion = questions.map((q, i) =>
    tallyQuestion(
      q,
      i,
      perAgent.map((answers) => answers[i]),
      majority,
    ),
  )

  // Decider pass: summarize, and let the agent rescue the questions still split
  // after the majority pass, where the advisors are in effective (not literal)
  // consensus. Runs whenever there is a split question; pure summary otherwise.
  const { summary, overrides } = await decideAndSummarizeAsk(
    p.currentAgentId,
    perQuestion,
    questions,
    p.cwd,
    p.signal,
  )
  for (const q of perQuestion) {
    if (!q.unanimous && overrides.has(q.index)) {
      q.unanimous = true
      q.agreed = overrides.get(q.index)!
      q.decidedByAgent = true
    }
  }

  const agreedAnswers: Record<string, string> = {}
  for (const q of perQuestion)
    if (q.unanimous && q.agreed !== null) agreedAnswers[q.question] = q.agreed
  const fullyUnanimous = perQuestion.length > 0 && perQuestion.every((q) => q.unanimous)
  return {
    kind: 'ask',
    perQuestion,
    fullyUnanimous,
    agreedAnswers,
    summary,
    vendorScope,
    crossVendorExcluded,
  }
}
