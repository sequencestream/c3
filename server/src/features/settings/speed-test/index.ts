/**
 * Model-provider speed test — the message handler and the registry of runs in
 * flight.
 *
 * Sits beside the connectivity probe (`../model-providers.ts`) and shares nothing
 * with it on purpose. "The endpoint answers" and "the endpoint is fast" are two
 * questions; merging them would make both answers untrustworthy, so the probe's
 * `latencyMs` is never promoted into this history and this capability never issues
 * the probe's bare GET.
 *
 * The run — not the request — is the unit of ownership. A start returns a `runId`
 * and the SERVER holds the execution from there: closing the dialog, navigating
 * away, or dropping the socket changes nothing upstream, and reconnecting re-attaches
 * by asking `active`. Only an explicit interrupt stops the calls, because a
 * dropped WebSocket must never silently cancel something the operator is being
 * billed for — nor silently restart it.
 *
 * Configuration is read-only here: every field of the target comes from the SAVED
 * provider, and none of it is accepted from the wire. A client that could supply a
 * URL or a key would be a way to aim an account-level credential at an arbitrary
 * host. Unsaved drafts are therefore untestable by design, which also keeps every
 * stored record attributable to a configuration that really existed.
 *
 * Everything below is admin-gated, reads included: the history names endpoints,
 * models and failure patterns for the whole installation.
 */
import {
  SPEED_TEST_CALIBRATION_VERSION,
  SPEED_TEST_MAX_OUTPUT_TOKENS,
  SPEED_TEST_MAX_REQUESTS,
  SPEED_TEST_MIN_REQUESTS,
  SPEED_TEST_TEMPERATURE,
  type ModelProvider,
  type ProtocolType,
  type ServerToClient,
  type SpeedTestActiveRun,
  type SpeedTestErrorCode,
  type SpeedTestRun,
  type SpeedTestRunDetail,
} from '@ccc/shared/protocol'
import { checkProviderBaseUrl } from '@ccc/shared'
import { loadSettings } from '../../../kernel/config/index.js'
import type { Conn, Handler } from '../../../transport/handler-registry.js'
import { isAdminConn, requireAdmin } from '../../auth/authz.js'
import { apiDialectFor } from './dialects.js'
import { SpeedTestExecution, type SpeedTestDeps, type SpeedTestPlan } from './runner.js'
import { summarize } from './stats.js'
import {
  aggregateObservedModels,
  ensureSpeedTestSchema,
  getSpeedTestRunDetail,
  listSpeedTestComparison,
  listSpeedTestHistoryProviders,
  listSpeedTestRuns,
  saveSpeedTestRun,
} from './store.js'

type ResultFrame = Extract<ServerToClient, { type: 'model_provider_speed_test_result' }>

/**
 * One run the server is holding. `subscribers` is the delivery set — progress goes
 * to the connections that asked for this run and still pass the admin gate, never
 * to every socket, because the frames name providers and models.
 */
interface ActiveEntry {
  execution: SpeedTestExecution
  plan: SpeedTestPlan
  state: 'running' | 'save_failed'
  subscribers: Set<Conn>
  /** Set only in `save_failed`: the finished result awaiting a commit retry. */
  pending: SpeedTestRunDetail | null
}

const byRunId = new Map<string, ActiveEntry>()
const byProvider = new Map<string, ActiveEntry>()

/**
 * Injected environment for the executor. Overridable so tests drive scripted SSE
 * streams with no network and no real clock.
 */
let deps: SpeedTestDeps = {
  fetch: (...args) => globalThis.fetch(...args),
  now: () => performance.now(),
  wallClock: () => Date.now(),
}

/** Test hook: swap the executor's environment. Pass `null` to restore the real one. */
export function setSpeedTestDepsForTests(next: Partial<SpeedTestDeps> | null): void {
  deps = next
    ? { ...deps, ...next }
    : {
        fetch: (...args) => globalThis.fetch(...args),
        now: () => performance.now(),
        wallClock: () => Date.now(),
      }
}

/** Test hook: drop every registered run (pair with a fresh database). */
export function resetSpeedTestRunsForTests(): void {
  byRunId.clear()
  byProvider.clear()
}

/** Drop a closing connection from every delivery set. Called from the ws `onClose`. */
export function releaseSpeedTestSubscriber(conn: Conn): void {
  for (const entry of byRunId.values()) entry.subscribers.delete(conn)
}

// ---- Delivery ----

function send(conn: Conn, frame: ResultFrame): void {
  conn.send(frame)
}

/** Fan one frame to a run's subscribers, re-checking authorization per connection. */
function push(entry: ActiveEntry, frame: ResultFrame): void {
  for (const conn of entry.subscribers) {
    if (!isAdminConn(conn)) continue
    try {
      conn.send(frame)
    } catch {
      // A socket that has gone away must not abort the sampling or the save.
    }
  }
}

function fail(
  conn: Conn,
  requestId: string,
  code: SpeedTestErrorCode,
  extra: { providerId?: string; runId?: string; run?: SpeedTestActiveRun } = {},
): void {
  send(conn, {
    type: 'model_provider_speed_test_result',
    requestId,
    event: 'error',
    code,
    ...extra,
  })
}

/** The live snapshot the console renders progress from. */
function snapshot(entry: ActiveEntry): SpeedTestActiveRun {
  const { plan, execution } = entry
  return {
    runId: plan.runId,
    providerId: plan.providerId,
    providerDisplayName: plan.providerDisplayName,
    protocolType: plan.protocolType,
    apiDialect: plan.apiDialect,
    model: plan.model,
    plannedCount: plan.plannedCount,
    completedCount: execution.completedCount,
    successCount: execution.successCount,
    failureCount: execution.failureCount,
    startedAt: execution.startedAt,
    state: entry.state,
  }
}

// ---- Validation ----

/** A validated target, or the code explaining why there isn't one. */
type Resolution =
  { ok: true; provider: ModelProvider; baseUrl: string } | { ok: false; code: SpeedTestErrorCode }

/**
 * Resolve a start request against the SAVED configuration. Every check runs before
 * any upstream call, so a rejected start costs zero requests, creates no record and
 * never appears in a success rate.
 *
 * The provider's `paused` flag is deliberately NOT consulted: pausing stops agents
 * from launching, and verifying that a paused upstream has recovered is exactly
 * what an administrator needs a speed test for. Testing does not clear the flag.
 */
function resolveTarget(
  providers: readonly ModelProvider[],
  providerId: string,
  protocolType: ProtocolType,
): Resolution {
  const provider = providers.find((p) => p.id === providerId)
  if (!provider) return { ok: false, code: 'provider_unknown' }

  const baseUrl = provider.urls[protocolType]?.trim() ?? ''
  if (!baseUrl) return { ok: false, code: 'protocol_unavailable' }
  if (checkProviderBaseUrl(baseUrl).severity === 'error') return { ok: false, code: 'invalid_url' }

  return { ok: true, provider, baseUrl }
}

/** Integer within the accepted band; rejects `0`, negatives, fractions and NaN. */
function validCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= SPEED_TEST_MIN_REQUESTS &&
    value <= SPEED_TEST_MAX_REQUESTS
  )
}

/**
 * A wire string that will be bound to a query. The frame is parsed JSON typed by
 * declaration, not by validation, so a field's TYPE proves nothing at runtime; a
 * non-string reaching the driver makes it throw, and a throw in a handler is a
 * logged warning and NO reply — the report panel would wait forever for an answer
 * that cannot come. An unusable value becomes "no such provider / no such run",
 * which is the truthful answer and one the console already renders.
 */
function asLookupKey(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * The history page's `offset`, normalised before it reaches `OFFSET`. Anything the
 * driver cannot bind — a non-number, NaN, `Infinity`, or an integer too wide for
 * SQLite — is not an offset this capability ever issues, so it reads as "first
 * page" rather than becoming an error the client never sees.
 */
function safeOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const offset = Math.trunc(value)
  return Number.isSafeInteger(offset) && offset > 0 ? offset : 0
}

// ---- Sealing ----

/** Fold a finished execution into the record that will be written. */
function sealDetail(entry: ActiveEntry, outcome: SpeedTestRun['outcome']): SpeedTestRunDetail {
  const { plan, execution } = entry
  return {
    run: {
      runId: plan.runId,
      providerId: plan.providerId,
      providerDisplayName: plan.providerDisplayName,
      startedAt: execution.startedAt,
      finishedAt: deps.wallClock(),
      plannedCount: plan.plannedCount,
      protocolType: plan.protocolType,
      apiDialect: plan.apiDialect,
      model: plan.model,
      observedModels: aggregateObservedModels(execution.records),
      calibrationVersion: SPEED_TEST_CALIBRATION_VERSION,
      maxOutputTokens: SPEED_TEST_MAX_OUTPUT_TOKENS,
      temperature: SPEED_TEST_TEMPERATURE,
      outcome,
      summary: summarize(execution.records),
    },
    requests: [...execution.records],
  }
}

/**
 * Commit a sealed run and announce it. `finished` is emitted ONLY after the
 * transaction returns, so "the run is over" and "the run is saved" can never be two
 * different truths on screen.
 *
 * A commit failure keeps the entry alive in `save_failed` with the result held in
 * memory: the operator has already paid for these samples, so the answer is a
 * visible "finished but not saved" plus a retry, never a silent drop.
 *
 * The frame carries the live SNAPSHOT, not the sealed record. The snapshot is what
 * `active` answers with, so a console that missed this frame — dialog closed,
 * page reloaded, socket dropped — re-attaches to the same retry instead of
 * depending on having been on screen at the right moment.
 */
function commit(entry: ActiveEntry, detail: SpeedTestRunDetail): void {
  try {
    saveSpeedTestRun(detail)
  } catch {
    entry.state = 'save_failed'
    entry.pending = detail
    push(entry, {
      type: 'model_provider_speed_test_result',
      event: 'error',
      code: 'save_failed',
      providerId: entry.plan.providerId,
      runId: entry.plan.runId,
      run: snapshot(entry),
    })
    return
  }
  push(entry, { type: 'model_provider_speed_test_result', event: 'finished', detail })
  byRunId.delete(entry.plan.runId)
  byProvider.delete(entry.plan.providerId)
}

// ---- Actions ----

function startRun(
  conn: Conn,
  requestId: string,
  providerId: string,
  protocolType: ProtocolType,
  model: string,
  requestCount: number,
): void {
  if (!validCount(requestCount)) return fail(conn, requestId, 'invalid_count', { providerId })

  const existing = byProvider.get(providerId)
  if (existing) {
    // Not queued: a second concurrent run against one provider would interleave
    // upstream load into both measurements and make neither comparable.
    return fail(conn, requestId, 'busy', { providerId, runId: existing.plan.runId })
  }

  const providers = loadSettings().modelProviders ?? []
  const resolved = resolveTarget(providers, providerId, protocolType)
  if (!resolved.ok) return fail(conn, requestId, resolved.code, { providerId })

  // Refuse before spending anything: producing cost and then discarding the record
  // is strictly worse than not starting.
  if (!ensureSpeedTestSchema()) return fail(conn, requestId, 'db_unavailable', { providerId })

  const plan: SpeedTestPlan = {
    runId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    providerId,
    providerDisplayName: resolved.provider.displayName,
    protocolType,
    apiDialect: apiDialectFor(resolved.provider, protocolType),
    model: model.trim(),
    plannedCount: requestCount,
    baseUrl: resolved.baseUrl,
    apiKey: resolved.provider.apiKey,
  }

  const entry: ActiveEntry = {
    execution: new SpeedTestExecution(plan, deps, () => push(entry, progressFrame(entry))),
    plan,
    state: 'running',
    subscribers: new Set([conn]),
    pending: null,
  }
  byRunId.set(plan.runId, entry)
  byProvider.set(providerId, entry)

  send(conn, {
    type: 'model_provider_speed_test_result',
    requestId,
    event: 'accepted',
    run: snapshot(entry),
  })
  // The console's first tick is 0/N, sent before any request has been issued.
  push(entry, progressFrame(entry))

  void entry.execution
    .run()
    .then((outcome) => commit(entry, sealDetail(entry, outcome)))
    .catch((err: unknown) => {
      // The executor classifies every upstream failure itself, so reaching here
      // means a defect rather than a slow provider — seal what was measured.
      console.warn('[c3] speed test execution failed:', err)
      commit(entry, sealDetail(entry, 'interrupted'))
    })
}

function progressFrame(entry: ActiveEntry): ResultFrame {
  return { type: 'model_provider_speed_test_result', event: 'progress', run: snapshot(entry) }
}

// ---- Handler ----

/**
 * The single ingress for every speed-test action. Narrow by `action`; each branch
 * carries exactly the fields it needs, so no arm has to ignore another's payload.
 */
export const modelProviderSpeedTestHandler: Handler<'model_provider_speed_test'> = (
  _ctx,
  conn,
  msg,
) => {
  // Admin-only throughout: the history names every configured endpoint and model.
  if (!requireAdmin(conn)) return
  const { requestId } = msg

  switch (msg.action) {
    case 'start':
      startRun(conn, requestId, msg.providerId, msg.protocolType, msg.model, msg.requestCount)
      return

    case 'interrupt': {
      const entry = byRunId.get(msg.runId)
      if (!entry) return fail(conn, requestId, 'not_found', { runId: msg.runId })
      entry.subscribers.add(conn)
      entry.execution.interrupt()
      return
    }

    case 'active': {
      const entry = byProvider.get(msg.providerId)
      if (entry) entry.subscribers.add(conn)
      send(conn, {
        type: 'model_provider_speed_test_result',
        requestId,
        event: 'active',
        providerId: msg.providerId,
        run: entry ? snapshot(entry) : null,
      })
      return
    }

    case 'retry_save': {
      const entry = byRunId.get(msg.runId)
      if (!entry || entry.state !== 'save_failed' || !entry.pending) {
        return fail(conn, requestId, 'not_found', { runId: msg.runId })
      }
      entry.subscribers.add(conn)
      // Replays nothing upstream: the samples are already in memory, so a retry
      // costs no credits and cannot insert a second record for one execution.
      commit(entry, entry.pending)
      return
    }

    case 'list':
      send(conn, {
        type: 'model_provider_speed_test_result',
        requestId,
        event: 'list',
        page: listSpeedTestRuns(asLookupKey(msg.providerId), safeOffset(msg.offset ?? 0)),
      })
      return

    case 'detail': {
      const detail = getSpeedTestRunDetail(asLookupKey(msg.runId))
      if (!detail) return fail(conn, requestId, 'not_found', { runId: msg.runId })
      send(conn, {
        type: 'model_provider_speed_test_result',
        requestId,
        event: 'detail',
        detail,
      })
      return
    }

    case 'history_providers':
      send(conn, {
        type: 'model_provider_speed_test_result',
        requestId,
        event: 'history_providers',
        providers: listSpeedTestHistoryProviders(currentProviderNames()),
      })
      return

    case 'compare':
      // Same projection as the report's provider picker, one step wider: each
      // provider brings its newest runs along, so a row can switch records — and
      // the view re-sort — without another round trip.
      send(conn, {
        type: 'model_provider_speed_test_result',
        requestId,
        event: 'compare',
        entries: listSpeedTestComparison(currentProviderNames()),
      })
      return
  }
}

/**
 * The live configuration as an id → name map, for reads that must name a provider
 * as the operator currently sees it. History stores its own snapshot; this is what
 * lets a rename show through without rewriting the record.
 */
function currentProviderNames(): Map<string, string> {
  return new Map((loadSettings().modelProviders ?? []).map((p) => [p.id, p.displayName] as const))
}

/**
 * Stop every run in flight and let each seal its samples. Called on graceful
 * shutdown: an orderly stop should not throw away measurements the operator paid
 * for. A sudden crash still loses them — no recovery is promised.
 */
export async function shutdownSpeedTests(): Promise<void> {
  const entries = [...byRunId.values()]
  for (const entry of entries) entry.execution.interrupt()
  // One turn of the loop lets each aborted request settle and commit.
  await new Promise((resolve) => setTimeout(resolve, 0))
}
