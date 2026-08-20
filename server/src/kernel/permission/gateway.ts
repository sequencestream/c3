/**
 * The permission gateway — the SINGLE chokepoint between the SDK and the human
 * (C-SEC, server refactor 3/3, ADR-0009; sunk from the `canUseTool` closure that
 * used to live inside `runClaude`).
 *
 * `createCanUseTool(spec)` returns the `canUseTool` callback the SDK invokes for
 * every sensitive tool. Gate policies branch off `spec.gate`:
 *  - `intent` — the read-only comm agent (read tools pass, save asks, else deny);
 *  - `spec` — the spec author (reads pass, writes path-checked into `specDir`);
 *  - `spec_review` — the spec reviewer: reads pass, the one narrow submit tool
 *    passes, every write is denied outright (it owns no writable location);
 *  - `discussion-research` — the unattended read-only research agent (read tools pass, else deny);
 *  - `robot` — an IM chat-robot turn: reads pass, the human-facing tools are denied
 *    outright (nobody is in the chat to answer them), writes only via the robot's
 *    frozen allowlist (ADR-0046);
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
import type {
  AnyConsensusOutcome,
  AskConsensusOutcome,
  ConsensusOutcome,
  ServerToClient,
} from '@ccc/shared/protocol'
import { allow, deny, type PermissionDecision } from './decision.js'
import {
  classifyIntentTool,
  extractWriteTargets,
  INTENT_QUERY_TOOLS,
  INTENT_READ_TOOLS,
  isInside,
  AUTO_ALLOWED_C3_TOOLS,
  SUBMIT_SPEC_REVIEW_TOOL,
  withAnswers,
  WRITE_TOOLS,
} from './tools.js'
import { waitForDecision } from './registry.js'
import { runAskConsensus, runConsensusVote } from '../../consensus.js'
import { askQuestions } from '../../consensus-tally.js'

/** Tool names that are user-interaction tools — their `permission_request` carries `isUserInteraction: true`. */
const USER_INTERACTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])

/** Context passed to the {@link GatewaySpec.onPermissionRequest} callback. */
export interface PermissionRequestCtx {
  requestId: string
  toolName: string
  input: unknown
  sessionId: string
  workspacePath: string
  /**
   * The producing run's full {@link SessionKind} (drives the WaitUserInvolveEvent's
   * `sessionKind`, and thus WorkCenter's `jumpToSource` routing). Resolved by the
   * caller — a work session is `'work'`, the read-only intent comm agent is
   * `'intent'`, a spec-authoring run is `'spec'`, etc. Never hard-coded downstream
   * (the handler reads it verbatim).
   */
  sessionKind: string
}

/**
 * Context passed to {@link GatewaySpec.onConsensusResolved} — the audit twin of
 * {@link PermissionRequestCtx} for a tool the multi-agent consensus auto-resolved
 * with NO human prompt. Carries the deciding {@link AnyConsensusOutcome} so the
 * wiring layer can land a non-blocking `status: 'auto'` WaitUserInvolveEvent.
 */
export interface ConsensusAutoCtx {
  requestId: string
  toolName: string
  input: unknown
  sessionId: string
  workspacePath: string
  sessionKind: string
  /** The consensus that decided it (votes + verdict + summary). */
  outcome: AnyConsensusOutcome
}

/** Everything the gateway needs from the run it guards (all caller-resolved). */
export interface GatewaySpec {
  /** Which gate policy applies (default `standard`). */
  gate: 'standard' | 'intent' | 'discussion-research' | 'spec' | 'spec_review' | 'robot'
  /**
   * Only meaningful when `gate === 'robot'`: the write/exec-class tools this
   * robot's configuration deliberately widened to. Absent or empty means the
   * robot is read-only, which is the default a robot is created with — widening
   * is an explicit act by an administrator (ADR-0046). Read-class tools are not
   * listed here; they pass on their own.
   */
  robotAllowedTools?: ReadonlySet<string>
  /**
   * Only set when `gate === 'spec'`: the absolute directory writes are confined
   * to. Write-class tools targeting a path outside it are denied; reads pass
   * through anywhere. Resolved per-run by the composition root from the spec
   * runtime's `specDir`.
   */
  specDir?: string
  /** Push a wire frame to the viewer (the permission_request / consensus_auto). */
  send: (msg: ServerToClient) => void
  /** The run's abort signal — a teardown resolves a pending prompt to deny. */
  signal: AbortSignal
  /** The agent the session runs on (excluded from its own consensus vote). */
  currentAgentId: string | null
  /**
   * The registered workspace root. Used to read project config (consensus
   * enable/voter/majority) and as the WorkCenter attribution key for every
   * prompt/auto ctx this gateway raises. In worktree-isolated runs this is the
   * project root, NOT {@link cwd} (the worktree) — `loadWorkspaceSetting` keys on
   * the exact path, so using the worktree here silently disables consensus and
   * drops audit events (their workspace is unregistered).
   */
  workspacePath: string
  /**
   * The run's effective working directory (the isolated worktree in worktree
   * mode). Handed to the consensus advisor queries as their launch cwd ONLY —
   * NOT used to read project config or attribute WorkCenter events (that is
   * {@link workspacePath}).
   */
  cwd: string
  /** Getter for the run's rolling recent-context (mutated by the message loop). */
  recentContext: () => string
  /**
   * When true (external skills mounted), write-class tools skip the consensus
   * shortcut and go straight to a human `permission_request`. This prevents the
   * SDK's `allowed-tools` frontmatter from auto-allowing a skill's write tools
   * without c3 oversight (mount layer 2/3, ADR-0017 §E — supply-chain write-ops
   * guard). Read tools and AskUserQuestion are unaffected.
   */
  skillWriteGuard?: boolean
  /**
   * The session id (a getter because the id may change on pending→real bind).
   * Only used when {@link onPermissionRequest} is set.
   */
  sessionId: () => string
  /**
   * The producing run's {@link SessionKind} for prompts this gateway raises —
   * `'intent'` for the read-only comm agent, `'work'` for a normal dev/user session,
   * `'spec'` for a spec-authoring run. Forwarded verbatim into every {@link
   * PermissionRequestCtx}; the composition root resolves it from the runtime kind.
   */
  sessionKind: string
  /**
   * Optional callback invoked **before** a `permission_request` wire frame is
   * sent. Receives the full {@link PermissionRequestCtx} including session-level
   * fields. NOT invoked for `consensus_auto` frames (the human is not involved).
   *
   * Every `send(permission_request)` call site that blocks on a human decision
   * triggers it — the standard split/no-consensus prompt, the standard
   * AskUserQuestion panel, the skill write-guard, AND the intent gate's
   * AskUserQuestion. Only the full-unanimous AskUserQuestion auto-answer is
   * excluded (it emits `consensus_auto`, no human).
   */
  onPermissionRequest?: (ctx: PermissionRequestCtx) => void
  /**
   * Optional callback invoked when the multi-agent consensus auto-resolves a tool
   * (the `consensus_auto` path) — i.e. EXACTLY where {@link onPermissionRequest} is
   * NOT called because no human is involved. Receives the full {@link ConsensusAutoCtx}
   * with the deciding outcome so the wiring layer can record a non-blocking
   * `status: 'auto'` WaitUserInvolveEvent (auto decisions stay auditable in
   * WorkCenter without creating a todo). Fired for both the unanimous AskUserQuestion
   * auto-answer and the allow/deny tool consensus auto-decision.
   */
  onConsensusResolved?: (ctx: ConsensusAutoCtx) => void
}

/**
 * Build the SDK `canUseTool` callback for one run. The returned function is the
 * only path a tool verdict can take; its `Promise<PermissionDecision>` return type
 * forces a branded verdict on every branch.
 */
export function createCanUseTool(spec: GatewaySpec): CanUseTool {
  const { gate, send, signal, currentAgentId, cwd, recentContext, robotAllowedTools } = spec

  // The SDK's third `options` arg now (0.3.186) carries `agentID` — the id of the
  // sub-agent that raised the prompt when a background/team agent is the requester.
  // The same change makes background agents FORWARD their permission prompts here
  // instead of auto-denying (and keeps stdin open while they run); c3 inherits that
  // behaviour for its team sessions at no cost. We deliberately ignore the arg: c3
  // routes every approval to the single main-session UI keyed by `sessionId`, and
  // there is no product surface that distinguishes the originating sub-agent. Thread
  // `agentID` into PermissionRequestCtx only when such a surface exists.
  //
  // That arg also carries `requestId` (0.3.199) — the SDK's own control_request
  // envelope id, meaningful ONLY when the consumer returns `null` and echoes it in
  // an out-of-band control_response (e.g. a signed HTTP POST). c3 does the opposite:
  // it returns a branded allow/deny inline and lets the SDK's transport carry the
  // response, so the SDK matches its envelope internally and c3 never needs that id.
  // The `requestId` minted below is a c3-domain id on a DIFFERENT plane — it
  // correlates the BROWSER round-trip (permission_request wire frame ↔ waitForDecision
  // pending map ↔ permission_response ↔ WorkCenter event) and must also span branches
  // the SDK id can't reach (consensus auto-resolve, AskUserQuestion
  // answer-injection). A single c3 id already
  // covers all of them; adopting the SDK id would add a second id with no verifiable
  // gain and risk permanent tool blocking via an accidental `null`. See the
  // 0.3.201 upgrade record for the full ledger.
  return async (toolName, input): Promise<PermissionDecision> => {
    const requestId = randomUUID()

    // The work-session c3 tools are ALWAYS auto-allowed with no human prompt, in
    // every gate — see AUTO_ALLOWED_C3_TOOLS for why each one qualifies. They are
    // only ever bound to standard work sessions, so this never widens the intent /
    // spec / discussion gates' read-only surface in practice.
    if (AUTO_ALLOWED_C3_TOOLS.has(toolName)) {
      return allow(input)
    }

    // Intent (read-only) gate: a separate, simpler policy that never
    // runs consensus. Read tools and `save_intents` pass through; everything else
    // is denied by default (defence-in-depth behind `disallowedTools`).
    if (gate === 'intent') {
      const decisionClass = classifyIntentTool(toolName)
      // Read-class built-ins + read-only c3 query tools (find/view) pass through.
      // `save_intents` also passes through HERE — the user already confirmed the
      // listed intents in the conversation, which is the save's single human
      // authorization; a prompt here would be a second, redundant confirmation.
      if (decisionClass === 'allow') {
        return allow(input)
      }
      // AskUserQuestion is a clarifying-only tool (no write/exec side effects),
      // so the read-only intent agent may use it. It needs the standard
      // answer-injection flow — NOT a plain allow (the SDK echoes answers only
      // when `input.answers` is pre-filled). Single agent ⇒ no consensus: just
      // prompt the human and inject the answers (or deny on cancel).
      if (decisionClass === 'ask' && askQuestions(input)) {
        spec.onPermissionRequest?.({
          requestId,
          toolName,
          input,
          sessionId: spec.sessionId(),
          workspacePath: spec.workspacePath,
          sessionKind: spec.sessionKind,
        })
        send({ type: 'permission_request', requestId, toolName, input, isUserInteraction: true })
        const { decision, answers } = await waitForDecision(requestId, signal)
        if (decision === 'allow') {
          return allow(withAnswers(input, answers ?? {}))
        }
        return deny('User denied in c3 UI')
      }
      console.warn(`[c3] intent gate denied tool: ${toolName}`)
      return deny('Intent chat is read-only; this tool is blocked.')
    }

    // Spec (write-confined) gate: the spec-authoring agent may read the whole
    // project freely (reuses the intent read set) PLUS the two read-only ledger
    // query tools (find/view) so it can ground the spec against existing intents,
    // but may WRITE only inside the run's `specDir`. The read-pass set is an
    // EXPLICIT read-only union — NOT `classifyIntentTool(...) === 'allow'`, which
    // also passes `save_intents`: a spec session must never write the ledger, so
    // save falls through to deny-by-default below (defence-in-depth — the spec MCP
    // server does not register save in the first place). Write-class tools are
    // path-checked here (they are NOT in the SDK-level disallowed lock for this run,
    // precisely so they reach this branch); a target outside the spec dir — or with
    // no resolvable path — is denied (fail-closed). AskUserQuestion routes via the
    // same answer-injection flow as the intent gate. Everything else is denied.
    if (gate === 'spec') {
      if (INTENT_READ_TOOLS.has(toolName) || INTENT_QUERY_TOOLS.has(toolName)) {
        return allow(input)
      }
      if (WRITE_TOOLS.has(toolName)) {
        const targets = extractWriteTargets(input)
        if (
          targets.length > 0 &&
          spec.specDir &&
          targets.every((t) => isInside(spec.specDir!, t))
        ) {
          return allow(input)
        }
        console.warn(`[c3] spec gate denied out-of-bounds write: ${toolName}`)
        return deny('Spec session may only write inside the spec directory.')
      }
      if (toolName === 'AskUserQuestion' && askQuestions(input)) {
        spec.onPermissionRequest?.({
          requestId,
          toolName,
          input,
          sessionId: spec.sessionId(),
          workspacePath: spec.workspacePath,
          sessionKind: spec.sessionKind,
        })
        send({ type: 'permission_request', requestId, toolName, input, isUserInteraction: true })
        const { decision, answers } = await waitForDecision(requestId, signal)
        if (decision === 'allow') {
          return allow(withAnswers(input, answers ?? {}))
        }
        return deny('User denied in c3 UI')
      }
      console.warn(`[c3] spec gate denied tool: ${toolName}`)
      return deny('Spec session is spec-only; this tool is blocked.')
    }

    // Spec-REVIEW (strictly read-only) gate. The reviewer reads the spec, the
    // repository source and this project's intents, and reports its verdict
    // through ONE narrow submit tool. It has NO writable location anywhere — the
    // spec belongs to its author, so write-class tools are denied here outright
    // rather than path-checked (contrast the `spec` gate above, which is the
    // whole reason this is a separate kind and not a reuse of `spec`). Shell,
    // sub-agents, slash commands, writable MCP tools and anything unrecognised
    // fall through to the deny-by-default at the end: fail-closed by structure.
    //
    // Clarifying questions are off. A review run is unattended queue work, and a
    // reviewer that could open a human prompt would turn an automated gate into a
    // silent stall.
    if (gate === 'spec_review') {
      if (
        INTENT_READ_TOOLS.has(toolName) ||
        INTENT_QUERY_TOOLS.has(toolName) ||
        toolName === SUBMIT_SPEC_REVIEW_TOOL
      ) {
        return allow(input)
      }
      if (WRITE_TOOLS.has(toolName)) {
        console.warn(`[c3] spec_review gate denied write tool: ${toolName}`)
        return deny('Spec review is read-only; it may not write any path.')
      }
      console.warn(`[c3] spec_review gate denied tool: ${toolName}`)
      return deny('Spec review is read-only; this tool is blocked.')
    }

    // Discussion-research (read-only) gate: a one-shot research agent that
    // completes a new discussion's `context`. It reuses the intent read
    // set (Read/Grep/Glob/… + WebFetch/WebSearch) so it can read project
    // material and search the web, but has NO save tool — the server writes the
    // agent's final text back itself — and clarifying questions are off (the
    // run is unattended). Everything else is denied by default.
    if (gate === 'discussion-research') {
      if (INTENT_READ_TOOLS.has(toolName)) {
        return allow(input)
      }
      console.warn(`[c3] discussion-research gate denied tool: ${toolName}`)
      return deny('Discussion research is read-only; this tool is blocked.')
    }

    // IM chat-robot gate (ADR-0046). The turn is driven by an inbound group
    // message and NOBODY is watching this run: a prompt raised here would hang
    // until the turn's wall clock kills it, and the person in the chat would
    // just see silence. Denying the human-facing tools outright is what makes
    // "a robot turn never stalls" a structural property rather than a race
    // against a timeout — the same reasoning as the spec_review gate above.
    //
    // Reads pass. Write/exec-class tools pass ONLY when this robot's own
    // configuration froze them into an allowlist; a freshly created robot has
    // none, so it is read-only until an administrator deliberately widens it.
    // Everything unrecognised falls through to the deny-by-default at the end.
    if (gate === 'robot') {
      if (USER_INTERACTION_TOOLS.has(toolName)) {
        console.warn(`[c3] robot gate denied user-interaction tool: ${toolName}`)
        return deny('No one is present in a chat-robot turn, so this tool cannot be answered.')
      }
      if (INTENT_READ_TOOLS.has(toolName) || INTENT_QUERY_TOOLS.has(toolName)) {
        return allow(input)
      }
      if (robotAllowedTools?.has(toolName)) {
        return allow(input)
      }
      console.warn(`[c3] robot gate denied tool: ${toolName}`)
      return deny('This tool is outside the allowed set for this chat robot.')
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
        // Config read keys off the registered root; advisor queries launch in cwd.
        workspacePath: spec.workspacePath,
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
        spec.onConsensusResolved?.({
          requestId,
          toolName,
          input,
          sessionId: spec.sessionId(),
          workspacePath: spec.workspacePath,
          sessionKind: spec.sessionKind,
          outcome: ask,
        })
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
      spec.onPermissionRequest?.({
        requestId,
        toolName,
        input,
        sessionId: spec.sessionId(),
        workspacePath: spec.workspacePath,
        sessionKind: spec.sessionKind,
      })
      send(
        ask
          ? {
              type: 'permission_request',
              requestId,
              toolName,
              input,
              consensus: ask,
              isUserInteraction: true,
            }
          : { type: 'permission_request', requestId, toolName, input, isUserInteraction: true },
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

    // Supply-chain write guard (mount layer 2/3, ADR-0017 §E): when an external
    // skill is loaded, write-class tools (anything except known read tools and
    // AskUserQuestion) skip the consensus shortcut and go straight to a human
    // permission_request. This prevents the SDK's `allowed-tools` frontmatter
    // from auto-allowing write ops without c3 oversight.
    if (
      spec.skillWriteGuard &&
      !INTENT_READ_TOOLS.has(toolName) &&
      toolName !== 'AskUserQuestion'
    ) {
      spec.onPermissionRequest?.({
        requestId,
        toolName,
        input,
        sessionId: spec.sessionId(),
        workspacePath: spec.workspacePath,
        sessionKind: spec.sessionKind,
      })
      send({ type: 'permission_request', requestId, toolName, input })
      const { decision } = await waitForDecision(requestId, signal)
      if (decision === 'allow') return allow(input)
      return deny('User denied in c3 UI')
    }

    // Multi-agent consensus first (resolves to null when disabled, when there
    // are no other agents, or if the advisor queries throw).
    const outcome: ConsensusOutcome | null = await runConsensusVote({
      currentAgentId: currentAgentId ?? null,
      toolName,
      input,
      context: recentContext(),
      // Config read keys off the registered root; advisor queries launch in cwd.
      workspacePath: spec.workspacePath,
      cwd,
      signal,
    }).catch(() => null)
    // A clear verdict ⇒ auto-resolve; surface how it was decided in the stream.
    // `decision` is non-null only on a unanimous vote or, under the majority
    // toggle, a strict-majority one (`tally`); a tie / no clear majority leaves
    // it null and falls through to the human.
    if (outcome && outcome.decision) {
      send({ type: 'consensus_auto', toolName, input, outcome })
      spec.onConsensusResolved?.({
        requestId,
        toolName,
        input,
        sessionId: spec.sessionId(),
        workspacePath: spec.workspacePath,
        sessionKind: spec.sessionKind,
        outcome,
      })
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
    spec.onPermissionRequest?.({
      requestId,
      toolName,
      input,
      sessionId: spec.sessionId(),
      workspacePath: spec.workspacePath,
      sessionKind: spec.sessionKind,
    })
    // Split / no consensus ⇒ ask the human, attaching the opinions (if any).
    const isUI = USER_INTERACTION_TOOLS.has(toolName)
    const req: ServerToClient = outcome
      ? {
          type: 'permission_request',
          requestId,
          toolName,
          input,
          consensus: outcome,
          ...(isUI ? { isUserInteraction: true } : {}),
        }
      : {
          type: 'permission_request',
          requestId,
          toolName,
          input,
          ...(isUI ? { isUserInteraction: true } : {}),
        }
    send(req)
    const { decision } = await waitForDecision(requestId, signal)
    if (decision === 'allow') {
      return allow(input)
    }
    // Default-deny (PG-R4): absent an explicit human/consensus allow, deny.
    return deny('User denied in c3 UI')
  }
}
