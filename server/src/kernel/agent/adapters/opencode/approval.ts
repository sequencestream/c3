/**
 * OpenCode's {@link ApprovalBridge} — out-of-loop, per-tool approval (009 GO),
 * the second `perToolApproval: true` reference after Claude. Where Claude blocks
 * inside a `canUseTool` callback, OpenCode asks via a `permission.updated` event
 * and the run halts **server-side** until a REST write-back lands. So this bridge
 * is event-driven: the driver feeds it `permission.updated` (suspend → ask human →
 * write back) and `permission.replied` (the confirmation half), and the bridge
 * owns the four things the event/REST split demands but the SDK does not provide
 * (009 conclusion):
 *
 *  1. **Timeout** — a server-side halt with no answer would hang forever (there is
 *     no "list pending permissions" endpoint to reconcile against), so an unanswered
 *     request times out to `deny` + a `reject` write-back. This is the deliberate
 *     divergence from PG-R2's "block indefinitely": the block lives in OpenCode's
 *     process, not c3's, so c3 must bound it.
 *  2. **Retry + stale 404** — the write-back retries with backoff; a structured
 *     `404 PermissionNotFoundError` means the id went stale (run moved on) → stop
 *     retrying, resolve locally.
 *  3. **`permission.replied` idempotency** — if something else (an operator, a rule)
 *     answers first, the replied event settles the pending promise so c3 does NOT
 *     double-write.
 *  4. **preApproved audit** — a `replied` for an id c3 never asked-and-wrote is the
 *     rule engine auto-allowing; the bridge surfaces it so the driver can stamp a
 *     `preApproved` canonical marker (the audit trail of bypassed approvals).
 *
 * ADR-0009: imports `@opencode-ai/sdk` (inside `adapters/opencode/`); no SDK type
 * crosses upward — the neutral {@link ApprovalRequest}/{@link ApprovalDecision} do.
 */
import type { OpencodeClient, Permission } from '@opencode-ai/sdk'
import type { ApprovalBridge, ApprovalDecision, ApprovalHandler, Disposer } from '../types.js'

/** Where + how to write a decision back to the OpenCode server. */
export interface WriteBackContext {
  client: OpencodeClient
  /** The run's working directory, passed as the REST `directory` query. */
  directory?: string
}

/** A rule-engine auto-allow the bridge detected (for the preApproved audit trail). */
export interface PreApprovedSignal {
  sessionID: string
  permissionID: string
  response: string
}

/**
 * The classification of a `permission.replied` event, returned to the calling
 * driver so it can act per-run (push a preApproved canonical marker) without a
 * global callback that would mis-route across concurrent sessions.
 *  - `settled` — a c3 in-flight request was answered externally first (idempotency).
 *  - `preApproved` — c3 never asked-and-wrote this id ⇒ rule-engine auto-allow.
 *  - `self` — c3 itself wrote this back (no action; the confirmation of our own write).
 */
export type RepliedResult = 'settled' | 'preApproved' | 'self'

type Outcome =
  | { type: 'decided'; decision: ApprovalDecision }
  | { type: 'external' } // answered by someone else first (replied event)
  | { type: 'timeout' }

/** Tunable bridge timings (defaults applied in the constructor). */
export interface OpencodeApprovalOptions {
  /** Max wait for a decision before default-denying + writing back reject. */
  timeoutMs?: number
  /** Write-back retry attempts (excluding the first try). */
  maxRetries?: number
  /** Backoff for retry attempt n (1-based). */
  backoff?: (attempt: number) => number
  sleep?: (ms: number) => Promise<void>
}

export class OpencodeApprovalBridge implements ApprovalBridge {
  /** Neutral fallback handler (covers the window before a session is bound). */
  private handler: ApprovalHandler | null = null
  /** Per-session handlers — the precise route once a run's session id is known. */
  private readonly sessionHandlers = new Map<string, ApprovalHandler>()
  private preApprovedCb: ((s: PreApprovedSignal) => void) | null = null
  /** permissionID → settle fn for an in-flight request (the timeout/replied race). */
  private readonly pending = new Map<string, (o: Outcome) => void>()
  /** permissionIDs c3 itself wrote back (so a self-triggered replied isn't mis-read as preApproved). */
  private readonly handledByC3 = new Set<string>()

  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly backoff: (attempt: number) => number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(opts: OpencodeApprovalOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000
    this.maxRetries = opts.maxRetries ?? 3
    this.backoff = opts.backoff ?? ((n) => Math.min(5_000, 200 * 2 ** n))
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  onRequest(handler: ApprovalHandler): Disposer {
    this.handler = handler
    return () => {
      if (this.handler === handler) this.handler = null
    }
  }

  /**
   * Bind a handler to one session — the precise route a live run registers once
   * its session id resolves. Takes precedence over the neutral {@link onRequest}
   * fallback, so concurrent OpenCode runs each reach their own browser viewer.
   */
  bindSession(sessionId: string, handler: ApprovalHandler): Disposer {
    this.sessionHandlers.set(sessionId, handler)
    return () => {
      if (this.sessionHandlers.get(sessionId) === handler) this.sessionHandlers.delete(sessionId)
    }
  }

  /** Subscribe to rule-engine auto-allows (for the driver's preApproved audit stamp). */
  onPreApproved(cb: (s: PreApprovedSignal) => void): Disposer {
    this.preApprovedCb = cb
    return () => {
      if (this.preApprovedCb === cb) this.preApprovedCb = null
    }
  }

  /**
   * Handle a `permission.updated`: suspend until the human decides (or timeout or
   * an external reply), then write the verdict back. Idempotent on re-delivery.
   */
  async handleUpdated(perm: Permission, ctx: WriteBackContext): Promise<void> {
    if (this.pending.has(perm.id) || this.handledByC3.has(perm.id)) return

    // Per-session handler wins; the neutral fallback covers the pre-bind window.
    const handler = this.sessionHandlers.get(perm.sessionID) ?? this.handler

    const outcome = await new Promise<Outcome>((resolve) => {
      const timer = setTimeout(() => this.settle(perm.id, { type: 'timeout' }), this.timeoutMs)
      this.pending.set(perm.id, (o) => {
        clearTimeout(timer)
        this.pending.delete(perm.id)
        resolve(o)
      })
      if (!handler) {
        // PG-R4 default-deny: no handler ⇒ deny (structural, never auto-allow).
        this.settle(perm.id, {
          type: 'decided',
          decision: { behavior: 'deny', reason: 'no approval handler registered' },
        })
        return
      }
      void handler({
        requestId: perm.id,
        toolName: perm.type,
        input: {
          title: perm.title,
          pattern: perm.pattern,
          callID: perm.callID,
          metadata: perm.metadata,
        },
      })
        .then((decision) => this.settle(perm.id, { type: 'decided', decision }))
        .catch((e) =>
          this.settle(perm.id, {
            type: 'decided',
            decision: { behavior: 'deny', reason: `approval handler error: ${String(e)}` },
          }),
        )
    })

    if (outcome.type === 'external') return // already answered elsewhere — no write-back
    const allow = outcome.type === 'decided' && outcome.decision.behavior === 'allow'
    this.handledByC3.add(perm.id)
    await this.writeBack(ctx, perm, allow ? 'once' : 'reject')
  }

  /**
   * Handle a `permission.replied`: settle a pending request (idempotency — someone
   * answered first), or — when c3 never asked-and-wrote this id — surface it as a
   * rule-engine auto-allow for the preApproved audit trail.
   */
  handleReplied(props: {
    sessionID: string
    permissionID: string
    response: string
  }): RepliedResult {
    const settle = this.pending.get(props.permissionID)
    if (settle) {
      settle({ type: 'external' })
      return 'settled'
    }
    if (this.handledByC3.has(props.permissionID)) return 'self'
    // c3 never asked-and-wrote this id ⇒ the rule engine auto-allowed it. Surface
    // it both via the optional callback and the return value (the driver uses the
    // return to stamp a per-run preApproved marker without cross-session leakage).
    this.preApprovedCb?.(props)
    return 'preApproved'
  }

  /** Settle an in-flight request by id (no-op if already settled). */
  private settle(permissionID: string, outcome: Outcome): void {
    this.pending.get(permissionID)?.(outcome)
  }

  /** REST write-back with backoff retry; a structured 404 (stale id) stops retrying. */
  private async writeBack(
    ctx: WriteBackContext,
    perm: Permission,
    response: 'once' | 'always' | 'reject',
    attempt = 0,
  ): Promise<void> {
    try {
      const res = await ctx.client.postSessionIdPermissionsPermissionId({
        path: { id: perm.sessionID, permissionID: perm.id },
        body: { response },
        ...(ctx.directory ? { query: { directory: ctx.directory } } : {}),
      })
      if (res.response?.status === 404) return // stale permission — give up cleanly
      if (res.error) throw new Error('opencode permission write-back returned an error')
    } catch {
      if (attempt >= this.maxRetries) return // exhausted — local state already settled
      await this.sleep(this.backoff(attempt + 1))
      await this.writeBack(ctx, perm, response, attempt + 1)
    }
  }
}
