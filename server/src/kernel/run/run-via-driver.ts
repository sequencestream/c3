/**
 * Vendor-neutral run path via {@link AgentDriver} (2026-06-06-003). This is the
 * FIRST run that flows through the neutral adapter interface rather than the
 * claude-hardwired `runClaude` loop — `launchRun` forks here when the session's
 * vendor is `opencode`. It is deliberately the *minimal* driver route (range C):
 * it does NOT reuse the claude path's degradation chain, socket auto-resume FSM,
 * consensus, or requirement profile — those are claude-shaped and out of scope for
 * the first non-Claude integration. The claude path stays byte-for-byte unchanged.
 *
 * Two translations live here:
 *  - **approval** — the driver's {@link ApprovalBridge} handler is wired to c3's
 *    existing browser approval registry (`permission_request` wire frame +
 *    `waitForDecision`), so an OpenCode permission prompt reaches the same UI a
 *    Claude one does.
 *  - **canonical → wire** — OpenCode streams append-with-upsert canonical frames;
 *    the c3 wire protocol is claude-shaped incremental append. {@link WireEmitter}
 *    diffs successive frames into `assistant_text` deltas + one-shot `tool_use` /
 *    `tool_result`, so the existing web console renders an OpenCode turn unchanged.
 */
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import type { CanonicalMessage, VendorAdapter } from '../agent/adapters/types.js'
import { fromPermissionMode } from '../agent/adapters/claude/permission-map.js'
import { freezeSessionAgent, resolveSessionLaunch } from '../agent-config/index.js'
import { waitForDecision } from '../permission/index.js'
import {
  bindPending,
  clearPending,
  emit,
  finalizeRun,
  setStatus,
  type SessionRuntime,
} from '../../runs.js'
import type { LaunchCbs } from '../types.js'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Diffs append-with-upsert canonical frames into claude-shaped incremental wire
 * events. Text blocks emit only their new suffix; a tool_use emits once when first
 * seen and its result once it back-fills (D3). Keyed by block id (anonymous text
 * is bucketed under a single key — OpenCode text parts always carry an id).
 */
export class WireEmitter {
  private readonly textLen = new Map<string, number>()
  private readonly toolSeen = new Set<string>()
  private readonly resultSeen = new Set<string>()

  constructor(private readonly send: (m: Parameters<typeof emit>[1]) => void) {}

  consume(msg: CanonicalMessage): void {
    for (const b of msg.blocks) {
      if (b.type === 'text') {
        const id = b.id ?? '__anon__'
        const prev = this.textLen.get(id) ?? 0
        if (b.text.length > prev) {
          this.send({ type: 'assistant_text', text: b.text.slice(prev) })
          this.textLen.set(id, b.text.length)
        }
      } else if (b.type === 'tool_use') {
        if (!this.toolSeen.has(b.id)) {
          this.toolSeen.add(b.id)
          // Carry the message-level `preApproved` audit marker onto the tool_use
          // frame (2026-06-06-004): a tool the vendor's own rule engine auto-allowed
          // never raised a `permission_request`, so this is the only signal the web
          // gets to color it "vendor pre-approved". Read at first-seen only — the
          // canonical flag is sticky, so a later result back-fill never flips it.
          this.send({
            type: 'tool_use',
            toolUseId: b.id,
            toolName: b.name,
            input: b.input ?? {},
            ...(msg.preApproved ? { preApproved: true } : {}),
          })
        }
        if (b.result && !this.resultSeen.has(b.id)) {
          this.resultSeen.add(b.id)
          this.send({
            type: 'tool_result',
            toolUseId: b.id,
            content: b.result.content,
            isError: b.result.isError,
          })
        }
      }
    }
  }
}

/**
 * Run one turn through a vendor adapter's driver. Owns the same registry/emit
 * concerns `launchRun` does for claude (abort wiring, prompt echo, status flips,
 * pending→real bind, terminal turn_end) but via the neutral interface. Used for
 * `opencode` and `codex` (2026-06-06-007); any future driver-routed vendor reuses it.
 */
export async function runViaDriver(
  rt: SessionRuntime,
  prompt: string,
  adapter: VendorAdapter,
  cbs: LaunchCbs = {},
): Promise<void> {
  const workspacePath = rt.workspacePath
  let runId = rt.sessionId

  emit(runId, { type: 'user_text', text: prompt })

  const cycleAbort = new AbortController()
  rt.run = { abort: cycleAbort, handle: null }
  setStatus(runId, 'running')

  // Wire the driver's approval bridge to c3's browser approval registry: a tool
  // prompt becomes a `permission_request` frame, the decision comes back through
  // `waitForDecision` (the exact path a Claude prompt takes). Default-deny on stop.
  const disposeApproval = adapter.approval.onRequest(async (req) => {
    emit(runId, {
      type: 'permission_request',
      requestId: req.requestId,
      toolName: req.toolName,
      input: req.input,
    })
    const { decision } = await waitForDecision(req.requestId, cycleAbort.signal)
    return decision === 'allow'
      ? { behavior: 'allow' }
      : { behavior: 'deny', reason: 'User denied in c3 UI' }
  })

  const { actionMode, toolGate } = fromPermissionMode(rt.mode)

  // Resolve the session agent's launch overrides (provider connection only). The
  // claude-hardwired path applies these to the SDK; the driver path threads the
  // neutral subset the vendor's driver understands (2026-06-06-007). Codex's policy
  // gate is derived from `actionMode`/`toolGate` in its driver (2026-06-06-008).
  const { agentId, model, baseUrl, apiKey, envOverrides } = resolveSessionLaunch(runId)

  try {
    const run = await adapter.driver.start({
      prompt,
      cwd: workspacePath,
      signal: cycleAbort.signal,
      actionMode,
      toolGate,
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(envOverrides ? { envOverrides } : {}),
      // A pending session starts fresh; a real id resumes that native session.
      ...(runId.startsWith(PENDING_SESSION_PREFIX) ? {} : { resume: runId }),
    })

    // Bind pending→real once the native session id resolves (OpenCode mints it at
    // session.create, so this is immediate). Mirrors launchRun's bind so the
    // sidebar/url settle onto the real id.
    const sid = await run.sessionId()
    if (sid !== runId && runId.startsWith(PENDING_SESSION_PREFIX)) {
      const prev = runId
      bindPending(prev, sid)
      // Freeze the session→agent fact onto the agent that ran, pinning its vendor
      // for the session's life (ADR-0015).
      freezeSessionAgent(prev, sid, agentId)
      runId = sid
      void cbs.onEvent?.({ kind: 'bound', prevId: prev, realId: sid })
    }

    const emitter = new WireEmitter((m) => emit(runId, m))
    for await (const msg of run.messages()) {
      if (cycleAbort.signal.aborted) break
      emitter.consume(msg)
    }
    if (!cycleAbort.signal.aborted) emit(runId, { type: 'turn_end', reason: 'complete' })
  } catch (err) {
    if (!cycleAbort.signal.aborted) {
      emit(runId, { type: 'turn_end', reason: 'error', error: errMsg(err) })
    }
  } finally {
    disposeApproval()
    if (rt.run) rt.run = null
    // The driver path is non-Claude (opencode / codex). Agent-teams are Claude-locked
    // (2026-06-06-006): no non-Claude vendor has `streamingPush`, so this path never
    // detects a team tool and never wires `onTeam` — a driver session can never be a
    // team. Force the flag false defensively (a team lead can only live on the
    // runClaude path's resident process).
    rt.team = false
    clearPending(runId)
    finalizeRun(runId)
    await cbs.onEvent?.({ kind: 'settled', workspacePath })
  }
}
