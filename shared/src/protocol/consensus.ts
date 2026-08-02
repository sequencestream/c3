/**
 * Team consensus and normalized tool-risk contracts for permission decisions.
 *
 * Part of the `@ccc/shared/protocol` contract; re-exported by `../protocol.ts`.
 */

import type { VendorId } from './vendor.js'

/**
 * Multi-agent consensus voting over permission prompts. When enabled, a pending
 * permission request is first put to the *other* configured agents (every agent
 * except the session's own); if they unanimously agree it is auto-resolved,
 * otherwise the human decides with their opinions attached. Off by default.
 */
export interface ConsensusConfig {
  enabled: boolean
  /**
   * Majority rule. Optional; `false`/absent by default (back-compat: existing
   * configs without the field keep the unanimous-only behaviour). When `true`,
   * the consensus auto-resolves on a clear *majority* verdict among the voters
   * instead of requiring **unanimity**; a tie or no clear majority still defers
   * to the human. This is the configuration base for majority adjudication —
   * the tally semantics live in `consensus-tally.ts` (see
   * `permission-gateway/consensus.md`).
   */
  majority?: boolean
  /**
   * Voter-selection mode. Optional; absent/`'all'` keeps the default behaviour
   * (every enabled non-self agent votes, **across vendors**). `'custom'` restricts
   * the voters to the intersection of {@link agentIds} with that enabled non-self
   * set — letting the user exclude irrelevant read-only agents or limit voting to
   * high-trust ones. Selection is vendor-neutral: neither `all` nor `custom` groups
   * by vendor; cross-vendor voters judge a vendor-neutral, normalized risk payload
   * (tool requests) or the raw questions (`AskUserQuestion`), never the requesting
   * vendor's native tool names.
   */
  mode?: 'all' | 'custom'
  /**
   * Allowlist of agent ids for `mode: 'custom'`. Ignored when `mode` is absent or
   * `'all'`. Cleaned by `normalizeWorkspaceSetting`: ids that no longer exist or
   * are disabled are dropped (and a disabled agent is also filtered at runtime),
   * so a stale id can never resurrect a voter. Empty (or all-stale) ⇒ no voters
   * ⇒ consensus is skipped and the human is prompted as usual.
   */
  agentIds?: string[]
}

/**
 * The vendor-neutral normalization of a tool permission request, the payload the
 * cross-vendor voters actually judge (never the requesting vendor's native tool
 * name or raw input). Produced deterministically by the server's risk normalizer
 * from `(requesting vendor, native tool name, input)` before fan-out. Voters and
 * the audit trail see only this neutral form, so a Codex advisor can judge a Claude
 * session's `Bash`/`Write` request (and vice-versa) without knowing the other
 * vendor's tool vocabulary. Present on a {@link ConsensusOutcome} only when
 * normalization SUCCEEDED; a failure carries {@link ConsensusOutcome.normalizationFailure}
 * instead and every voter abstains.
 */
export interface NormalizedToolRisk {
  /** Stable, vendor-neutral operation category + a short human description. */
  operationIntent: string
  /**
   * The resources the operation touches: a neutral `kind` (e.g. `'file'`,
   * `'command'`, `'url'`, `'search'`) plus the structurally-extracted targets
   * (paths, command target, remote host/URL). Never the raw native input verbatim.
   */
  resourceScope: { kind: string; targets: string[] }
  /**
   * The four base risk axes every request is classified on, plus optional
   * non-vendor-specific extra tags. A `true` axis is descriptive only — it never
   * hard-codes a deny; the tally still decides allow/deny.
   */
  risks: { read: boolean; write: boolean; execute: boolean; network: boolean; tags?: string[] }
  /** The normalizer ruleset version, so prompts, protocol and audit stay interpretable. */
  normalizationVersion: number
}

/** One agent's vote on a pending permission request during consensus voting. */
export interface ConsensusVote {
  /** Voting agent's id. */
  agentId: string
  /** Voting agent's display name. */
  agentName: string
  /**
   * Voting agent's vendor. Optional for back-compat with pre-cross-vendor audit
   * records (which had no vendor because voting was same-vendor only); new votes
   * always set it so the UI/audit can show each voter's vendor honestly.
   */
  vendor?: VendorId
  /** Verdict. `abstain` ⇒ the agent errored, returned no parseable answer, or the
   * request could not be normalized (⇒ the whole round abstains). */
  decision: 'allow' | 'deny' | 'abstain'
  /** One-line rationale from the agent. */
  reason: string
}

/**
 * The aggregated result of a consensus vote over the other agents. Produced by
 * the server's consensus orchestrator and surfaced to the console either as an
 * auto-decision (`consensus_auto`) or attached to a `permission_request`.
 */
export interface ConsensusOutcome {
  /** Discriminates from {@link AskConsensusOutcome} on the wire. */
  kind: 'tool'
  /** Each voter's verdict + reason. */
  votes: ConsensusVote[]
  /** Decider-agent (or code-fallback) one-line summary of the opinions. */
  summary: string
  /**
   * True ⇒ every voter returned the same allow/deny verdict (no abstain).
   * Reports **literal** unanimity regardless of the majority toggle, so the UI
   * can distinguish a unanimous outcome from one carried only by a majority
   * (`decision` set while `unanimous` is false).
   */
  unanimous: boolean
  /**
   * The verdict the gateway auto-resolved on, or null ⇒ the human decides.
   * Unanimous-only mode: set only when `unanimous`. Majority mode
   * (`ConsensusConfig.majority`): set on a strict majority of cast votes
   * (abstentions excluded); a tie or no clear majority leaves it null.
   */
  decision: 'allow' | 'deny' | null
  /**
   * The vendor-neutral risk payload the cross-vendor voters judged. Present ONLY
   * when the request normalized successfully; the voters never saw the requesting
   * vendor's native tool name or raw input, only this. Absent when normalization
   * failed (see {@link normalizationFailure}) or on legacy records. Kept optional
   * so historical outcomes (which had no normalization layer) still read.
   */
  normalized?: NormalizedToolRisk
  /**
   * Stable reason code when the request could NOT be normalized (unknown tool,
   * missing critical target, invalid input, or an internal normalizer error). When
   * set, every selected voter abstained without an advisor call, so `decision` is
   * null and the request defers to the human — normalization failure never
   * auto-allows. Absent on a normalized outcome. Auditable in the outcome so a
   * human review sees exactly why cross-vendor voting was skipped.
   */
  normalizationFailure?: string
}

/**
 * One voter's answer to ONE question of an `AskUserQuestion` prompt. Unlike the
 * allow/deny vote, the agent picks option label(s) (or writes a custom reply)
 * for each question put to the user.
 */
export interface AgentAnswer {
  agentId: string
  agentName: string
  /**
   * Answering agent's vendor. Optional for back-compat with pre-cross-vendor audit
   * records; new answers always set it so the UI/audit can show each voter's vendor.
   */
  vendor?: VendorId
  /** Matched option label(s); empty when the agent only gave a custom reply. */
  optionLabels: string[]
  /** Free-text reply when no option fits (or as an addition). */
  custom?: string
  /** One-line rationale. */
  reason: string
  /** True ⇒ the agent gave no parseable answer for this question (ignored in the tally). */
  abstain?: boolean
}

/** Per-question roll-up of every voter's answer, plus whether they agreed. */
export interface QuestionConsensus {
  /** Index into the original `AskUserQuestion` `questions` array. */
  index: number
  /** Question text — also the key used in the SDK `answers` map. */
  question: string
  header: string
  multiSelect: boolean
  /** Each voter's answer to this question. */
  answers: AgentAnswer[]
  /** True ⇒ every non-abstaining voter chose the same answer (≥1 voter, none abstained). */
  unanimous: boolean
  /** The agreed answer string (SDK format: option labels comma-separated); null when split. */
  agreed: string | null
  /**
   * True ⇒ the string tally was split, but the decider agent judged the advisors
   * to be in effective consensus and supplied {@link agreed}. Distinguishes an
   * AI-adjudicated agreement from a literal unanimous vote (for honest UI/labels).
   */
  decidedByAgent?: boolean
  /**
   * True ⇒ the literal vote was NOT unanimous, but the majority toggle is on and a
   * single answer won a strict plurality of the cast (non-abstaining) votes, which
   * became {@link agreed}. A deterministic pre-step that runs before the decider,
   * so it is mutually exclusive with {@link decidedByAgent}. Distinguishes a
   * majority-carried answer from a literal unanimous vote (for honest UI/labels).
   */
  decidedByMajority?: boolean
}

/**
 * Consensus over an `AskUserQuestion` prompt: voters answer each question rather
 * than vote allow/deny. When every question is unanimous the gateway can answer
 * on the user's behalf; otherwise the human fills in the answers (split questions
 * highlighted, agreed ones pre-filled). Surfaced like {@link ConsensusOutcome}.
 */
export interface AskConsensusOutcome {
  kind: 'ask'
  /** One roll-up per question, in original order. */
  perQuestion: QuestionConsensus[]
  /** True ⇒ every question is unanimous — eligible for auto-answer. */
  fullyUnanimous: boolean
  /** Pre-built `answers` map (question text → agreed answer) for the unanimous questions. */
  agreedAnswers: Record<string, string>
  /** Decider-agent (or code-fallback) one-line summary. */
  summary: string
}

/** Either consensus shape, discriminated by `kind`. */
export type AnyConsensusOutcome = ConsensusOutcome | AskConsensusOutcome

/**
 * One voter's verdict in a checkpoint consensus round. The voter decides whether
 * the automation orchestrator should continue past a developer checkpoint or wait
 * for human intervention.
 */
export interface CheckpointConsensusVote {
  /** Voting agent's id. */
  agentId: string
  /** Voting agent's display name. */
  agentName: string
  /**
   * Voting agent's vendor. Optional for back-compat with pre-cross-vendor records;
   * new votes set it (checkpoint voting is now vendor-neutral like the other rounds).
   */
  vendor?: VendorId
  /**
   * Verdict. `continue` ⇒ auto-pass the checkpoint; `wait` ⇒ stop for human;
   * `abstain` ⇒ the agent errored or returned no parseable answer.
   */
  decision: 'continue' | 'wait' | 'abstain'
  /** One-line rationale from the agent. */
  reason: string
}

/**
 * The aggregated result of a checkpoint consensus round in the automation
 * orchestrator. When the orchestrator detects a checkpoint signal (unanswered
 * AskUserQuestion or a `stuck` judge verdict), and the majority toggle is on,
 * it spawns a vote among peer agents to decide whether to skip the checkpoint
 * and continue the automation loop.
 *
 * The outcome is broadcast via `WorkflowStatus.checkpointConsensus` so the
 * UI/events can render who voted what and the final decision.
 */
export interface CheckpointConsensusOutcome {
  /** Each voter's verdict + reason. */
  votes: CheckpointConsensusVote[]
  /**
   * The decision the orchestrator should follow:
   * - `'continue'` ⇒ the majority (or, in unanimous mode, all voters) agreed to
   *   pass the checkpoint; the orchestrator should treat this as `in_progress`.
   * - `'wait'` ⇒ the majority (or all) agreed to wait; the orchestrator stops
   *   and exposes the checkpoint to the human.
   * - `null` ⇒ a tie or no clear majority; the orchestrator also stops (the
   *   fail-safe default).
   */
  decision: 'continue' | 'wait' | null
  /**
   * True ⇒ every voter returned the same verdict (no abstain). Reports literal
   * unanimity regardless of the majority toggle.
   */
  unanimous: boolean
  /** Decider-agent (or code-fallback) one-line summary of the opinions. */
  summary: string
  /** The type which triggered the checkpoint consensus. */
  trigger: 'pending_question' | 'judge_stuck'
  /**
   * The judge's reason when the trigger was `judge_stuck`; the pending-question
   * detection reason when the trigger was `pending_question`.
   */
  triggerReason: string
}
