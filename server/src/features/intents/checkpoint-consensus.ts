/**
 * Checkpoint consensus for the automation orchestrator.
 *
 * When the automation loop detects that a dev turn ended at a developer
 * checkpoint (an unanswered AskUserQuestion or a `stuck` judge verdict),
 * and the project's consensus majority toggle is ON, this module spawns a
 * vote among peer agents to decide whether the orchestrator should
 * **continue** past the checkpoint (treating it as a passable step) or
 * **wait** for human intervention.
 *
 * ## Flow
 *
 * 1. The automation orchestrator detects a checkpoint signal in
 *    `_processTurnResult()` — either `hasPendingQuestion()` fired or
 *    `judgeCompletion()` returned `stuck`.
 * 2. If consensus majority is enabled AND there are voters, call
 *    `runCheckpointConsensus()`.
 * 3. Each voter receives the intent context, the agent's last message, the
 *    checkpoint trigger reason, and code-change evidence, then decides
 *    `continue` | `wait`.
 * 4. The votes are tallied: a strict majority of cast votes decides.
 *    A tie or no cast votes ⇒ `decision: null` ⇒ the orchestrator stops
 *    (the fail-safe default).
 * 5. The outcome is broadcast via `WorkflowStatus.checkpointConsensus`
 *    so the UI/events can render the process.
 * 6. The orchestrator: `decision === 'continue'` ⇒ treat as `in_progress`
 *    and auto-continue; otherwise stop (existing behaviour).
 *
 * ## Invariants
 *
 * - **Fail-safe to human.** Any voter error/timeout/unparseable answer is
 *   an abstain, which can lower the majority threshold but never changes
 *   the direction of a winning vote. A tie or no clear majority always
 *   means `decision: null` ⇒ the orchestrator stops (the human decides).
 * - **Majority toggle controls strictness.** When ON, a strict majority
 *   of cast (non-abstain) votes wins. When OFF (unanimous-only mode), the
 *   checkpoint consensus is not triggered — the code follows the existing
 *   stop-and-wait-for-human path (RM-A11).
 * - **No AskUserQuestion overlap.** Checkpoint consensus does NOT answer
 *   the underlying AskUserQuestion — it only decides the *automation flow*
 *   (continue the loop vs. stop). The underlying tool-use remains unresolved
 *   in the buffer; the continuation launch sends "continue" to the same
 *   session, and the agent resolves the checkpoint independently.
 * - **No re-vote.** A checkpoint consensus round is run once per turn
 *   settle. There is no retry or re-vote mechanism in this module.
 */

import type {
  CheckpointConsensusOutcome,
  CheckpointConsensusVote,
  Intent,
} from '@ccc/shared/protocol'
import { askAgentOnce } from '../../agent-once.js'
import { selectConsensusVoters } from '../../kernel/agent-config/index.js'
import {
  getConsensusConfig,
  getUiLangName,
  isConsensusEnabled,
  isConsensusMajorityEnabled,
} from '../../kernel/config/index.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckpointConsensusParams {
  /** The project path (resolved). */
  workspacePath: string
  /** The intent being developed. */
  intent: Intent
  /** The last assistant message from the dev turn. */
  lastMessage: string
  /** The checkpoint trigger type. */
  trigger: 'pending_question' | 'judge_stuck'
  /** Human-readable reason for the trigger (judge's stuck reason, or the pending-question detection text). */
  triggerReason: string
  /**
   * Uncommitted changes stat (`git diff HEAD --stat`) — supporting evidence
   * for the voters. May be empty when not available (the pending-question
   * path computes diff after the guard).
   */
  diffStat?: string
  /** Abort signal for the advisor queries. */
  signal: AbortSignal
}

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

function voterPrompt(
  intent: Intent,
  lastMessage: string,
  trigger: 'pending_question' | 'judge_stuck',
  triggerReason: string,
  diffStat: string | undefined,
): { system: string; user: string } {
  // system: the stable advisor role + decision instruction + considerations + output
  // shape — byte-identical across voters, so it rides the system channel as a
  // cacheable prefix.
  const system = [
    'You are an advisor judging whether an automated software development process should continue past a checkpoint that would normally require human approval.',
    '',
    'Decide whether the automation should **CONTINUE** past this checkpoint (treating it as a routine step the agent can resolve on its own) or **WAIT** for a human to intervene.',
    '',
    'Consider:',
    "- Does the agent's message show genuine progress toward the intent?",
    '- Is the checkpoint a routine dev-skill step (e.g. "approve design?", "proceed to implementation?") that the agent can handle on its own?',
    "- Is there concrete code change evidence backing the agent's report?",
    '- Does the situation truly need human judgment (unclear requirements, error state, missing context)?',
    '',
    'Reply with ONLY a single-line JSON object, no other text:',
    '{"decision":"continue"|"wait","reason":"<one short sentence>"}',
  ].join('\n')
  // user: the per-vote context — the intent, the agent's last message, the checkpoint
  // signal, and the code-change evidence.
  const user = [
    `# Intent title\n${intent.title}`,
    `# Intent content\n${intent.content}`,
    '',
    '# What the agent produced last',
    lastMessage || '(no text output)',
    '',
    '# Checkpoint signal',
    trigger === 'pending_question'
      ? `The dev turn ended with an unanswered question to the user (AskUserQuestion) — a checkpoint the agent paused at. Reason: ${triggerReason}`
      : `The automation completion judge determined the agent is stuck and needs human input. Reason: ${triggerReason}`,
    '',
    '# Code-change evidence (git diff --stat)',
    diffStat || '(no uncommitted changes)',
  ].join('\n')
  return { system, user }
}

// ---------------------------------------------------------------------------
// Vote parsing
// ---------------------------------------------------------------------------

function parseCheckpointVote(
  text: string,
): { decision: 'continue' | 'wait'; reason: string } | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as { decision?: unknown; reason?: unknown }
      const d = String(obj.decision ?? '').toLowerCase()
      if (d === 'continue' || d === 'wait') {
        return {
          decision: d,
          reason: typeof obj.reason === 'string' ? obj.reason.replace(/\s+/g, ' ').trim() : '',
        }
      }
    } catch {
      /* fall through to keyword scan */
    }
  }
  const low = text.toLowerCase()
  const cont = /\bcontinue\b/.test(low)
  const wait = /\bwait\b/.test(low)
  if (cont && !wait)
    return { decision: 'continue', reason: text.replace(/\s+/g, ' ').trim().slice(0, 200) }
  if (wait && !cont)
    return { decision: 'wait', reason: text.replace(/\s+/g, ' ').trim().slice(0, 200) }
  return null
}

// ---------------------------------------------------------------------------
// Tally
// ---------------------------------------------------------------------------

function tallyCheckpoint(
  votes: CheckpointConsensusVote[],
  majority: boolean,
): { unanimous: boolean; decision: 'continue' | 'wait' | null } {
  const decisions = votes.map((v) => v.decision)
  const allContinue = decisions.length > 0 && decisions.every((d) => d === 'continue')
  const allWait = decisions.length > 0 && decisions.every((d) => d === 'wait')
  const unanimous = allContinue || allWait
  if (!majority) {
    // Unanimous-only mode — only used when the caller has already checked
    // isConsensusMajorityEnabled, so this branch should not normally fire.
    return { unanimous, decision: allContinue ? 'continue' : allWait ? 'wait' : null }
  }
  const cont = decisions.filter((d) => d === 'continue').length
  const w = decisions.filter((d) => d === 'wait').length
  return { unanimous, decision: cont > w ? 'continue' : w > cont ? 'wait' : null }
}

// ---------------------------------------------------------------------------
// Deterministic summary fallback
// ---------------------------------------------------------------------------

function fallbackSummary(
  votes: CheckpointConsensusVote[],
  unanimous: boolean,
  decision: 'continue' | 'wait' | null,
): string {
  const counts = votes.reduce<Record<string, number>>(
    (acc, v) => {
      acc[v.decision] = (acc[v.decision] ?? 0) + 1
      return acc
    },
    {} as Record<string, number>,
  )
  const parts = Object.entries(counts).map(([d, n]) => `${n} ${d}`)
  if (decision === 'continue') {
    if (unanimous) return `所有 agent 一致同意继续（${parts.join(', ')}）`
    return `多数派裁决继续（${parts.join(', ')}）`
  }
  if (decision === 'wait') {
    if (unanimous) return `所有 agent 一致认为需等待人工（${parts.join(', ')}）`
    return `多数派裁决等待人工（${parts.join(', ')}）`
  }
  return `agent 意见不一致（${parts.join(', ')}），需人工裁决`
}

// ---------------------------------------------------------------------------
// Decider summarizer (agent-assisted)
// ---------------------------------------------------------------------------

/**
 * Ask the first available agent to summarise the votes in one sentence.
 * Falls back to `fallbackSummary` on error/abort.
 */
async function summarize(
  votes: CheckpointConsensusVote[],
  unanimous: boolean,
  decision: 'continue' | 'wait' | null,
  cwd: string,
  signal: AbortSignal,
): Promise<string> {
  const fallback = fallbackSummary(votes, unanimous, decision)
  if (signal.aborted) return fallback
  try {
    // Use the first configured voter as decider, or fall back to the
    // deterministic summary if none is available. Respect the custom voter
    // allowlist so the decider is drawn from the configured voter pool.
    const voters = selectConsensusVoters(null, getConsensusConfig(cwd))
    if (voters.length === 0) return fallback
    const decider = voters[0]
    // system: the stable summariser role + output instruction; user: the votes cast.
    const system = [
      'Several advisor agents voted on whether an automated development process should continue past a checkpoint that needs human approval.',
      `Write ONE short sentence in ${getUiLangName()} summarizing their collective opinion for the automation orchestrator. Output only that sentence, no preamble.`,
    ].join('\n')
    const user = [
      'Their votes:',
      ...votes.map((v) => `- ${v.agentName}: ${v.decision} — ${v.reason || '(no reason)'}`),
    ].join('\n')
    const text = await askAgentOnce(decider, user, cwd, signal, null, system)
    const clean = text.replace(/\s+/g, ' ').trim()
    return clean || fallback
  } catch {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a checkpoint consensus vote for the automation orchestrator.
 *
 * Returns `null` when consensus is disabled (the majority toggle is off), there
 * are no voters, or the project is not configured for consensus voting — in all
 * these cases the orchestrator falls back to the existing stop-and-wait behaviour.
 *
 * When a decision is produced, it carries the per-voter votes, the aggregate
 * decision, and a human-readable summary — all of which are broadcast via
 * `WorkflowStatus.checkpointConsensus` so the UI can render them.
 */
export async function runCheckpointConsensus(
  params: CheckpointConsensusParams,
): Promise<CheckpointConsensusOutcome | null> {
  const { workspacePath, intent, lastMessage, trigger, triggerReason, diffStat, signal } = params

  // Check both that consensus is enabled AND majority is on — checkpoint
  // consensus only makes sense with majority rule (unanimous-only would
  // routinely deadlock on a checkpoint that every agent agrees to pass).
  if (!isConsensusEnabled(workspacePath) || !isConsensusMajorityEnabled(workspacePath)) {
    return null
  }

  const voters = selectConsensusVoters(null, getConsensusConfig(workspacePath))
  if (voters.length === 0) return null

  console.log(
    `[c3:checkpoint-consensus] (auto) vote on "${intent.title}" checkpoint (${trigger}) → ${voters.length} voter(s)`,
  )

  const { system, user } = voterPrompt(intent, lastMessage, trigger, triggerReason, diffStat)
  const votes: CheckpointConsensusVote[] = await Promise.all(
    voters.map(async (agent): Promise<CheckpointConsensusVote> => {
      try {
        const text = await askAgentOnce(agent, user, workspacePath, signal, null, system)
        const parsed = parseCheckpointVote(text)
        if (!parsed) {
          return {
            agentId: agent.id,
            agentName: agent.displayName,
            vendor: agent.vendor,
            decision: 'abstain',
            reason: text.replace(/\s+/g, ' ').trim().slice(0, 200) || 'no parseable answer',
          }
        }
        return { agentId: agent.id, agentName: agent.displayName, vendor: agent.vendor, ...parsed }
      } catch (err) {
        return {
          agentId: agent.id,
          agentName: agent.displayName,
          vendor: agent.vendor,
          decision: 'abstain',
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )

  // Majority toggle is guaranteed true by the early return above, but we pass
  // it explicitly so the tally is consistent with the setting.
  const majority = isConsensusMajorityEnabled(workspacePath)
  const { unanimous, decision } = tallyCheckpoint(votes, majority)
  const summary = await summarize(votes, unanimous, decision, workspacePath, signal)

  console.log(
    `[c3:checkpoint-consensus] (auto) result: ${decision ?? 'no_decision'} (unanimous=${unanimous}): ${summary}`,
  )

  return {
    votes,
    decision,
    unanimous,
    summary,
    trigger,
    triggerReason,
  }
}
