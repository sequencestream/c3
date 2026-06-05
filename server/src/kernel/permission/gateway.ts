/**
 * The permission gateway — the SINGLE chokepoint between the SDK and the human
 * (C-SEC, server refactor 3/3, ADR-0009; sunk from the `canUseTool` closure that
 * used to live inside `runClaude`).
 *
 * `createCanUseTool(spec)` returns the `canUseTool` callback the SDK invokes for
 * every sensitive tool. Three gate policies branch off `spec.gate`:
 *  - `requirement` — the read-only comm agent (read tools pass, save asks, else deny);
 *  - `discussion-research` — the unattended read-only research agent (read tools pass, else deny);
 *  - `standard` — the normal flow (multi-agent consensus → human prompt).
 *
 * EVERY return is a branded {@link PermissionDecision} minted by `allow`/`deny`,
 * and the function's return type forces one on every path — a forgotten branch is
 * a COMPILE error, and the trailing fallthrough is an explicit `deny` (PG-R4,
 * default-deny is structural, not incidental). `spec.recentContext` is a getter
 * because the run loop keeps mutating the rolling context the consensus voters read.
 */
import { randomUUID } from 'node:crypto'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import type { AskConsensusOutcome, ConsensusOutcome, ServerToClient } from '@ccc/shared/protocol'
import { allow, deny, type PermissionDecision } from './decision.js'
import { classifyRequirementTool, REQUIREMENT_READ_TOOLS, withAnswers } from './tools.js'
import { waitForDecision } from './registry.js'
import { runAskConsensus, runConsensusVote } from '../../consensus.js'
import { askQuestions } from '../../consensus-tally.js'

/** Everything the gateway needs from the run it guards (all caller-resolved). */
export interface GatewaySpec {
  /** Which gate policy applies (default `standard`). */
  gate: 'standard' | 'requirement' | 'discussion-research'
  /** Push a wire frame to the viewer (the permission_request / consensus_auto). */
  send: (msg: ServerToClient) => void
  /** The run's abort signal — a teardown resolves a pending prompt to deny. */
  signal: AbortSignal
  /** The agent the session runs on (excluded from its own consensus vote). */
  currentAgentId: string | null
  /** The run's working directory (handed to the consensus advisor queries). */
  cwd: string
  /** Getter for the run's rolling recent-context (mutated by the message loop). */
  recentContext: () => string
}

/**
 * Build the SDK `canUseTool` callback for one run. The returned function is the
 * only path a tool verdict can take; its `Promise<PermissionDecision>` return type
 * forces a branded verdict on every branch.
 */
export function createCanUseTool(spec: GatewaySpec): CanUseTool {
  const { gate, send, signal, currentAgentId, cwd, recentContext } = spec

  return async (toolName, input): Promise<PermissionDecision> => {
    const requestId = randomUUID()

    // Requirement (read-only) gate: a separate, simpler policy that never
    // runs consensus. Read tools pass through; `save_requirements` asks the
    // human; everything else is denied by default (defence-in-depth behind
    // `disallowedTools`).
    if (gate === 'requirement') {
      const decisionClass = classifyRequirementTool(toolName)
      // Read-class built-ins + read-only c3 query tools (find/view) pass through.
      if (decisionClass === 'allow') {
        return allow(input)
      }
      if (decisionClass === 'confirm-save') {
        send({ type: 'permission_request', requestId, toolName, input })
        const { decision } = await waitForDecision(requestId, signal)
        if (decision === 'allow') {
          return allow(input)
        }
        return deny('User denied in c3 UI')
      }
      // AskUserQuestion is a clarifying-only tool (no write/exec side effects),
      // so the read-only requirement agent may use it. It needs the standard
      // answer-injection flow — NOT a plain allow (the SDK echoes answers only
      // when `input.answers` is pre-filled). Single agent ⇒ no consensus: just
      // prompt the human and inject the answers (or deny on cancel).
      if (decisionClass === 'ask' && askQuestions(input)) {
        send({ type: 'permission_request', requestId, toolName, input })
        const { decision, answers } = await waitForDecision(requestId, signal)
        if (decision === 'allow') {
          return allow(withAnswers(input, answers ?? {}))
        }
        return deny('User denied in c3 UI')
      }
      console.warn(`[c3] requirement gate denied tool: ${toolName}`)
      return deny('Requirement chat is read-only; this tool is blocked.')
    }

    // Discussion-research (read-only) gate: a one-shot research agent that
    // completes a new discussion's `context`. It reuses the requirement read
    // set (Read/Grep/Glob/… + WebFetch/WebSearch) so it can read project
    // material and search the web, but has NO save tool — the server writes the
    // agent's final text back itself — and clarifying questions are off (the
    // run is unattended). Everything else is denied by default.
    if (gate === 'discussion-research') {
      if (REQUIREMENT_READ_TOOLS.has(toolName)) {
        return allow(input)
      }
      console.warn(`[c3] discussion-research gate denied tool: ${toolName}`)
      return deny('Discussion research is read-only; this tool is blocked.')
    }

    // AskUserQuestion is not an allow/deny tool — it needs an ANSWER per
    // question. Consensus voters answer each question; if they all agree on
    // every question we answer on the user's behalf, otherwise the human
    // fills the answer panel (agreed questions pre-filled). This branch runs
    // even with consensus disabled so the panel still renders and the answers
    // get injected (the base AskUserQuestion support).
    if (toolName === 'AskUserQuestion' && askQuestions(input)) {
      // The consensus pass spawns one advisor query() subprocess per voter plus
      // a decider — a multi-second window during which the tool-use stays
      // pending and the request is not yet visible to the human. It is fully
      // contained (the `.catch` ⇒ null) so an advisor error/slowness can never
      // abort or throw into the main run; the worst case is "no opinions, ask
      // the human" (the safe default). If the main run is nonetheless torn down
      // in this window, `waitForDecision` resolves to deny (below) and we log it
      // so the precise trigger can be confirmed in a live multi-agent setup.
      const ask: AskConsensusOutcome | null = await runAskConsensus({
        currentAgentId: currentAgentId ?? null,
        toolName,
        input,
        context: recentContext(),
        cwd,
        signal,
      }).catch((err) => {
        console.warn(
          `[c3] runAskConsensus threw (deferring to human): ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        return null
      })
      if (ask && ask.fullyUnanimous) {
        send({ type: 'consensus_auto', toolName, input, outcome: ask })
        return allow(withAnswers(input, ask.agreedAnswers))
      }
      // The run was torn down *while* consensus ran: do NOT emit a
      // permission_request the human can never answer. It would linger in the
      // buffer as a dead "曾请求…" static line (the residue the fix forbids).
      // Deny straight away — the turn is already ending.
      if (signal.aborted) {
        console.warn(
          `[c3] AskUserQuestion ${requestId} aborted during the consensus window — ` +
            `skipping the unanswerable permission_request (consensus-window race)`,
        )
        return deny('Run aborted during consensus')
      }
      send(
        ask
          ? { type: 'permission_request', requestId, toolName, input, consensus: ask }
          : { type: 'permission_request', requestId, toolName, input },
      )
      const { decision, answers } = await waitForDecision(requestId, signal)
      if (decision === 'allow') {
        return allow(withAnswers(input, answers ?? {}))
      }
      // Distinguish a human "deny" from a run-teardown deny: the latter means an
      // AskUserQuestion prompt the user never answered was denied because the run
      // signal aborted during/after the consensus window — the race this log
      // exists to catch.
      if (signal.aborted) {
        console.warn(
          `[c3] AskUserQuestion ${requestId} denied by run abort before the human answered ` +
            `(consensus-window race) — tool=${toolName}`,
        )
      }
      return deny('User denied in c3 UI')
    }

    // Multi-agent consensus first (resolves to null when disabled, when there
    // are no other agents, or if the advisor queries throw).
    const outcome: ConsensusOutcome | null = await runConsensusVote({
      currentAgentId: currentAgentId ?? null,
      toolName,
      input,
      context: recentContext(),
      cwd,
      signal,
    }).catch(() => null)
    // Unanimous ⇒ auto-resolve; surface how it was decided in the stream.
    if (outcome && outcome.unanimous && outcome.decision) {
      send({ type: 'consensus_auto', toolName, input, outcome })
      if (outcome.decision === 'allow') {
        return allow(input)
      }
      return deny('Denied by c3 multi-agent consensus')
    }
    // Run torn down during the consensus window ⇒ skip the unanswerable prompt
    // (same residue guard as the AskUserQuestion branch above) and deny.
    if (signal.aborted) {
      return deny('Run aborted during consensus')
    }
    // Split / no consensus ⇒ ask the human, attaching the opinions (if any).
    const req: ServerToClient = outcome
      ? { type: 'permission_request', requestId, toolName, input, consensus: outcome }
      : { type: 'permission_request', requestId, toolName, input }
    send(req)
    const { decision } = await waitForDecision(requestId, signal)
    if (decision === 'allow') {
      return allow(input)
    }
    // Default-deny (PG-R4): absent an explicit human/consensus allow, deny.
    return deny('User denied in c3 UI')
  }
}
