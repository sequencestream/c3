/**
 * `server.ts` — the composition root (server refactor 3/3e-3, ADR-0009 R3).
 *
 * Pure assembler: Hono + ws setup, kernel context construction, feature-hook
 * wiring, static assets, scheduler lifecycle, SIGINT/SIGTERM. All heavier
 * helper closures have been pushed into `wiring/`; all domain logic lives in
 * `kernel/`. The `KernelContext` shape is unchanged.
 */
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { INTENT_DISALLOWED_TOOLS } from './kernel/permission/index.js'
import { launchRun, type LaunchRunDeps } from './kernel/run/run-lifecycle.js'
import { setOnAgentSwap, setOnBind, resolveSessionVendor } from './kernel/agent-config/index.js'
import { addWorkspace, listWorkspaces } from './state.js'
import { sessionExists } from './sessions.js'
import {
  reconcileLiveness,
  setOnStatusChange,
  isRunning,
  setOnRunEnd,
  setOnEmit,
  setTaskObserver,
} from './runs.js'
import { observeTaskWire } from './kernel/agent/task-tracker.js'
import { getSessionAgentId, getUiLang, setOnPendingIntentLookup } from './kernel/config/index.js'
import { setAutomationHooks } from './features/intents/automation.js'
import { buildIntentAgentPrompt } from './features/intents/prompt.js'
import { createIntentMcpServer } from './features/intents/save-tool.js'
import { renameChatSession, listChatSessions } from './features/intents/store.js'
import { createPermissionRequestHandler } from './features/user-involve/hooks.js'
import { EventBus } from './kernel/events/event-bus.js'
import { type KernelContext, assertNoTransportFields } from './kernel/types.js'
import { createBroadcaster, type Deliver } from './transport/index.js'
import { registerHandlers } from './features/index.js'
import { checkDbDriver } from './kernel/infra/db.js'
import {
  getPendingIntent,
  JANITOR_INTERVAL_MS,
  janitor,
  touchOnRunEnd,
  updatePendingRowAgentId,
  updateRealRowAgentId,
  upsertForBind,
} from './features/works/work-session-store.js'
import { cleanupStalePendingIntents, PENDING_INTENT_TTL_MS } from './kernel/config/index.js'
import { logHostBinaryHealth } from './kernel/agent/adapters/registry.js'
import { resolve as resolveHostBinary } from './kernel/agent/process/launcher.js'
import {
  createOpencodeSupervisor,
  createOpencodeAdapter,
  type OpencodeSupervisor,
} from './kernel/agent/adapters/opencode/index.js'
import { createCodexAdapter } from './kernel/agent/adapters/codex/index.js'
import { createClaudeAdapter } from './kernel/agent/adapters/claude/index.js'
import { createCodexRelay, CODEX_RELAY_PATH } from './transport/codex-relay/index.js'
import type { VendorAdapter } from './kernel/agent/adapters/types.js'
import type { VendorId } from '@ccc/shared/protocol'
import { hasAnyInstalledSkill } from './kernel/skill-loader/index.js'
import { setSkillApprovalSend } from './kernel/skill-loader/approval.js'
import { getSkillRepos } from './kernel/config/index.js'
import { ClaudeSessionStore } from './kernel/agent/adapters/claude/session-store.js'
import { SessionAccessor, type VendorSessionSource } from './kernel/agent/session/accessor.js'
import { setOpencodeEnsure, setOpencodeStatus } from './opencode-status.js'
import {
  createBroadcasts,
  createDiscussionRuns,
  createWsHandler,
  makeRunDevTurn,
  mountDevPlaceholder,
  mountStaticAssets,
  registerRunDomainSubscriptions,
  startSchedulerWiring,
  stopSchedulerWiring,
} from './wiring/index.js'

export interface ServerOptions {
  /** Optional seed workspace — added to the registry and made discoverable. */
  projectPath?: string
  port: number
  dev: boolean
  /**
   * Attach to an operator-run OpenCode server instead of c3 spawning + supervising
   * one (the escape hatch, 2026-06-06-003). When set, c3 only builds a client for
   * it — no spawn / health / restart / kill.
   */
  opencodeUrl?: string
}

/** How often the server broadcasts a full session-status snapshot. */
const STATUS_HEARTBEAT_MS = 15_000
/**
 * How long a `running` session can be silent before its run is presumed hung
 * and forcefully converged to `idle`. Conservative — long-running tools (build,
 * deploy) emit no intermediate events but finish much faster than this.
 */
const RUN_STALE_MS = 5 * 60_000

/** How often the janitor reaps abandoned pending-session intents (ADR-0015). The
 * 7-day TTL is coarse, so an hourly sweep is plenty. */
const PENDING_INTENT_SWEEP_MS = 60 * 60_000

export async function startServer(opts: ServerOptions): Promise<void> {
  // ---- Wire the `work_session_metadata` projection hooks (kernel ↛ features) ----
  // The kernel layer doesn't import the projection store directly (ADR-0009);
  // these composition-time callbacks mirror the kernel's bind / agent-swap /
  // run-end writes into the projection. The store is fail-soft, so a missing
  // db (any of these throws inside) is a logged-and-skipped no-op.
  setOnBind((input) => {
    upsertForBind(input)
  })
  setOnAgentSwap((input) => {
    if (input.scope === 'pending') {
      updatePendingRowAgentId({
        pendingId: input.sessionId,
        vendor: input.vendor,
        agentId: input.agentId,
      })
    } else {
      updateRealRowAgentId(input.sessionId, input.vendor, input.agentId)
    }
  })
  setOnRunEnd((input) => {
    const vendor = resolveSessionVendor(input.realId)
    const agentId = getSessionAgentId(input.realId) ?? ''
    // Left/right title same-source (ADR-0013): resolve the real title from the
    // SAME vendor-aware native store the title bar (`select_session`) and the
    // janitor read — NOT `firstUserTitle(baseline)`. On the FIRST run `baseline`
    // is empty (this turn's messages live in `rt.buffer`), so that fallback
    // degrades to the placeholder "New session" and the sidebar shows it forever
    // (even across refresh, since lazy validation only re-checks rows older than
    // 24h). `sessionAccessor` / `broadcasts` are forward-referenced (built below);
    // this closure only runs at run-end, long after the composition root finishes
    // — the same pattern as the janitor's native list above.
    void (async () => {
      let title = input.title
      try {
        const summaries = await sessionAccessor.list({ cwd: input.workspacePath })
        const hit = summaries.find((s) => {
          if (s.vendor !== vendor) return false
          const vsid = s.vendorExtra?.vendorSessionId
          return typeof vsid === 'string' && vsid === input.realId
        })
        // Only accept a real native title (not a default placeholder like
        // "New session") — the fallback from `firstUserTitle(baseline)` may
        // have a more meaningful value, especially for Codex sessions whose
        // JSONL file now correctly reports the user prompt.
        if (hit?.title && hit.title !== 'New session' && hit.title !== 'Untitled session') {
          title = hit.title
        }
      } catch (err) {
        console.error('[c3] onRunEnd native title lookup failed:', err)
      }
      touchOnRunEnd({
        realId: input.realId,
        vendor,
        agentId,
        title,
        // Stamp the run-end moment as `last_modified`: the session was just active,
        // so it must sort to the TOP of the list now. Passing null here would NULL
        // the column on every turn end (and re-arm the 24h lazy-validation clock via
        // `state_updated_at`), sinking an actively-developed session to the very
        // bottom — the root cause of "automation session invisible even on refresh".
        // Lazy validation later refines this to the native transcript mtime.
        lastModified: Date.now(),
      })
      // The native read is async, so `run:settled → sendSessions` already fired
      // with the pre-backfill row. Re-broadcast the list now that the real title
      // is written so every client converges (typically tens of ms later).
      broadcasts.broadcastSessions(input.workspacePath)
    })()
  })
  setOnPendingIntentLookup((pendingId) => {
    const intent = getPendingIntent(pendingId)
    return intent?.agentId ?? null
  })

  // ---- work_session_metadata projection janitor (F-9) ----
  // Runs every JANITOR_INTERVAL_MS (= STALE_MS/2 = 12h). The sweep is
  // `void`+async so a slow native `list` never blocks the heartbeat
  // timer or the event loop. The store is fail-soft (a missing db
  // returns an empty result), so this is safe to call even when the
  // projection is unavailable.
  setInterval(() => {
    try {
      const workspaces = listWorkspaces().map((w) => w.path)
      void janitor({
        nativeList: async (vendor, ws) => {
          // Use the SessionAccessor to query native stores. The accessor
          // is built at composition time; the janitor runs periodically.
          // For now, skip vendors that the accessor doesn't have sources
          // for (the accessor is the same object wired into the WS
          // handler).
          const sources = sessionAccessor?.list({ cwd: ws })
          if (!sources) return null
          const summaries = await sources
          return {
            sessions: summaries
              .filter((s) => s.vendor === vendor)
              .map((s) => {
                const extra = s.vendorExtra ?? {}
                const vsid = typeof extra.vendorSessionId === 'string' ? extra.vendorSessionId : ''
                const lastMod =
                  typeof extra.lastModified === 'number' && Number.isFinite(extra.lastModified)
                    ? extra.lastModified
                    : null
                return { vendorSessionId: vsid, title: s.title, lastModified: lastMod }
              }),
          }
        },
        workspaces,
      })
    } catch (err) {
      console.error('[c3] work_session_metadata janitor failed:', err)
    }
  }, JANITOR_INTERVAL_MS)

  // Probe the platform's builtin SQLite driver up front (release 4/7). On a newly
  // supported target (e.g. a Windows Bun binary) a missing `bun:sqlite` would
  // otherwise surface as a silent persistence-less degrade discovered much later;
  // detect it loudly at boot instead. The app still starts (callers degrade), but
  // the operator is told exactly what broke.
  checkDbDriver()

  // Probe host CLIs up front (ADR-0012). Each agent vendor runs as a host-CLI
  // subprocess that can't be packed into c3's single binary; a missing one means
  // that agent type is simply unavailable (a product convention, not a bug). Logs
  // present/missing + install guidance loudly, like checkDbDriver — c3 still starts.
  logHostBinaryHealth()

  // OpenCode lifecycle governance (2026-06-06-003, risk #2): c3 spawns + supervises
  // the long-lived OpenCode server (or attaches to an external one via --opencode-url).
  // Built here at the composition root so the kernel launcher only ever sees the
  // neutral VendorAdapter (injected via launchDeps.getOpencodeAdapter). Failure is
  // non-fatal — c3 still starts, the opencode agent type is just unavailable.
  // The supervisor's reachability is now a first-class signal (2026-06-07-003): the
  // adapter is built **unconditionally** when opencode is registered (host CLI present
  // or `--opencode-url`), so opencode is always an available vendor and its server is
  // (re)started lazily on demand (`select_session`) within a grace window — boot only
  // makes a best-effort, non-fatal attempt. Every reachability transition updates the
  // runtime singleton + broadcasts an `opencode_status` frame. `broadcastOpencodeStatus`
  // is late-bound (the broadcaster is built below) via a mutable thunk.
  let opencodeAdapter: VendorAdapter | null = null
  let opencodeSupervisor: OpencodeSupervisor | null = null
  let broadcastOpencodeStatus: () => void = () => {}
  const opencodeExternal = !!opts.opencodeUrl
  if (opencodeExternal || resolveHostBinary('opencode')) {
    try {
      const sup = createOpencodeSupervisor({
        externalUrl: opts.opencodeUrl,
        onStatusChange: (status) => {
          setOpencodeStatus(status)
          broadcastOpencodeStatus()
        },
      })
      opencodeSupervisor = sup
      // Adapter pulls the live client lazily, so it works across (re)starts even
      // when the boot attempt below fails — the server comes up on first demand.
      opencodeAdapter = createOpencodeAdapter(sup)
      setOpencodeEnsure(() => sup.ensureRunning())
      setOpencodeStatus(sup.status)
      // Best-effort boot start (non-fatal): ensureRunning degrades honestly + self-heals.
      await sup.ensureRunning()
      console.log(
        `[c3] opencode ${sup.status.reachability}: ${sup.url ?? '?'}${opencodeExternal ? ' (external)' : ''}`,
      )
    } catch (e) {
      console.warn(`[c3] opencode unavailable: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Codex lifecycle (2026-06-06-007): unlike OpenCode, Codex spawns its CLI per run
  // via the SDK (no supervisor), so the adapter is built directly — host-binary
  // gated like the others. Built here so the kernel launcher only sees the neutral
  // VendorAdapter (injected via launchDeps.getCodexAdapter). Missing CLI ⇒ null, and
  // the codex agent type is simply unavailable (a session falls back / errors loud).
  // In-process Responses→Chat relay (ADR-0014): codex 0.137 speaks only the
  // Responses API, so a codex agent on a Chat-Completions-only provider (DeepSeek,
  // Kimi, …) is driven through this loopback shim. Built unconditionally and mounted
  // below; the driver only engages it for a custom provider URL.
  const codexRelay = createCodexRelay(`http://127.0.0.1:${opts.port}`)
  let codexAdapter: VendorAdapter | null = null
  if (resolveHostBinary('codex')) {
    try {
      codexAdapter = createCodexAdapter(undefined, undefined, codexRelay)
      console.log('[c3] codex ready (per-run CLI)')
    } catch (e) {
      console.warn(`[c3] codex unavailable: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Cross-vendor session listing (ADR-0013): the read-only union the new
  // `list_sessions` path lists through. Sources are built explicitly (not via
  // `resolveAvailableAdapters`) so we take only each vendor's `SessionStore` and
  // can EXCLUDE codex — codex is not enumerable (its list entries depend on the
  // projection table, a separate concern). claude is always present; opencode
  // joins only when its supervised adapter came up.
  const sessionSources: VendorSessionSource[] = [
    { vendor: 'claude', sessions: new ClaudeSessionStore() },
  ]
  if (opencodeAdapter) {
    sessionSources.push({ vendor: 'opencode', sessions: opencodeAdapter.sessions })
  }
  const sessionAccessor = new SessionAccessor(sessionSources)

  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  // Seed the registry with the CLI-provided workspace (idempotent).
  if (opts.projectPath) addWorkspace(opts.projectPath, Date.now())

  // Single broadcast egress (ADR-0009 R2 / server refactor 2/3b). All wire frames
  // funnel through `broadcaster.toAll`; the per-run delivery (emit/viewers,
  // ADR-0006) is separate. Wiring builds the frames; the broadcaster only ships.
  const connections = new Set<Deliver>()
  const broadcaster = createBroadcaster(connections)
  const broadcasts = createBroadcasts({ broadcaster, sessionAccessor })
  setOnStatusChange(broadcasts.broadcastStatuses)
  // Wire the skill-load approval egress (mount layer 2/3, ADR-0017). Without this
  // the `send` sink stays null: `requestSkillApproval` delivers no modal AND its
  // promise never resolves, so the pre-launch `skillMount` step in `launchRun`
  // hangs forever and the run never starts (the session stays pending and vanishes
  // on refresh). The `skill_load_approval_resolve` ingress is already registered in
  // features/register.ts — this is the missing reverse leg.
  setSkillApprovalSend((msg) => broadcaster.toAll(msg))
  // Derive the task-list wire path from the emit stream (2026-06-07-009): the
  // observer folds task-tool tool_use/tool_result into a per-session model and
  // emits `task_list` snapshots (buffered ⇒ replayed on reconnect).
  setTaskObserver(observeTaskWire)
  // Auto-derive intent session titles on the first assistant response (2026-06-08-001).
  // When a blank session (title NULL) receives its first assistant_text event, extract
  // the first user message from the runtime's baseline/buffer as the session title.
  // Sessions that already have a title (refineIntent/discussionToIntent) are skipped.
  const autoTitledSessions = new Set<string>()
  setOnEmit((rt, event) => {
    if (rt.kind !== 'intent') return
    if (event.type !== 'assistant_text') return
    if (autoTitledSessions.has(rt.sessionId)) return
    autoTitledSessions.add(rt.sessionId)
    // DB write is best-effort — the store may be unavailable.
    try {
      const proj = rt.workspacePath
      const sessions = listChatSessions(proj)
      const session = sessions.find((s) => s.sessionId === rt.sessionId)
      if (session?.title) return // Don't overwrite existing titles.
      // Find the first user message from baseline or buffer.
      let firstUserText = ''
      for (const item of rt.baseline) {
        if (item.kind === 'user' && item.text?.trim()) {
          firstUserText = item.text.trim()
          break
        }
      }
      if (!firstUserText) {
        for (const ev of rt.buffer) {
          if (ev.type === 'user_text' && ev.text?.trim()) {
            firstUserText = ev.text.trim()
            break
          }
        }
      }
      if (!firstUserText) return
      const summary = firstUserText.substring(0, 64)
      renameChatSession(rt.sessionId, summary)
      broadcasts.broadcastIntentSessions(proj)
    } catch (err) {
      console.warn('[c3] auto-title derivation failed:', err)
    }
  })
  // Bind the late thunk now the broadcaster exists, so the supervisor's
  // onStatusChange (registered above) fans out `opencode_status` transitions.
  broadcastOpencodeStatus = broadcasts.broadcastOpencodeStatus
  setInterval(() => {
    // Reap stale/hung runs before broadcasting, so the snapshot is authoritative.
    reconcileLiveness(Date.now(), RUN_STALE_MS)
    broadcasts.broadcastStatuses()
  }, STATUS_HEARTBEAT_MS)
  // Janitor: drop pending-session intents abandoned for >7 days (never ran), at
  // boot and hourly thereafter. Clearing an intent never orphans a fact (ADR-0015).
  const sweepPendingIntents = (): void => {
    const reaped = cleanupStalePendingIntents(Date.now(), PENDING_INTENT_TTL_MS)
    if (reaped.length > 0) console.log(`[c3] reaped ${reaped.length} stale pending intent(s)`)
  }
  sweepPendingIntents()
  setInterval(sweepPendingIntents, PENDING_INTENT_SWEEP_MS)

  // ── Composition root (ADR-0009 R3): construct the KernelContext ONCE,
  //    explicitly. The intent profile is wired HERE so the kernel
  //    launcher stays features-free (ADR-0009 R1).
  const eventBus = new EventBus()
  const launchDeps: LaunchRunDeps = {
    eventBus,
    broadcastStatuses: broadcasts.broadcastStatuses,
    broadcastIntents: broadcasts.broadcastIntents,
    intentProfile: (workspacePath) => ({
      // Read the live Display language (uiLang) at run start so the analyst replies
      // in the user's console language, not a hard-coded one (2026-06-08-005).
      appendSystemPrompt: buildIntentAgentPrompt(getUiLang()),
      disallowedTools: INTENT_DISALLOWED_TOOLS,
      mcpServers: createIntentMcpServer(workspacePath, broadcasts.broadcastIntents),
      gate: 'intent' as const,
    }),
    // The neutral OpenCode adapter, or null when unavailable (launchRun forks to
    // the driver path for opencode sessions; 2026-06-06-003).
    getOpencodeAdapter: () => opencodeAdapter,
    // The neutral Codex adapter, or null when its host CLI is missing (launchRun
    // forks to the driver path for codex sessions; 2026-06-06-007).
    getCodexAdapter: () => codexAdapter,
    // Supply-chain write-guard probe (ADR-0017 D5, 2026-06-12): external skills are
    // installed explicitly from the settings panel (`install_skill`), NOT mounted
    // here. Launch only reads whether any configured skill is already installed (a
    // live `_c3_<id>` link in a public dir) — zero network — to decide the guard.
    detectMountedSkills: async (rt) => {
      const configs = getSkillRepos(rt.workspacePath)
      if (!configs.length) return false
      return hasAnyInstalledSkill(rt.workspacePath, configs)
    },
    // Permission-event hook: before each `permission_request` wire frame, create
    // a WaitUserInvolveEvent in the store and broadcast the updated todo list.
    onPermissionRequest: createPermissionRequestHandler({ broadcaster }),
  }
  const runDevTurn = makeRunDevTurn({ launchDeps })
  // Feature-private: NOT on the kernel context (ADR-0009 R1).
  setAutomationHooks({
    runDevTurn,
    broadcastIntents: broadcasts.broadcastIntents,
    emitStatus: broadcasts.broadcastAutomation,
    sessionExists,
    isRunning,
  })
  // Build the adapter lookup for AgentSessionManager (used by discussion runs).
  // claude is always present; codex and opencode join only when their host CLI
  // was detected at boot (null-entries are skipped — missing vendors throw at
  // runtime, which is a fatal developer error, not a silent degradation).
  const discussionAdapters = new Map<VendorId, VendorAdapter>()
  discussionAdapters.set('claude', createClaudeAdapter())
  if (codexAdapter) discussionAdapters.set('codex', codexAdapter)
  if (opencodeAdapter) discussionAdapters.set('opencode', opencodeAdapter)
  const discussionRuns = createDiscussionRuns({
    broadcasts,
    eventBus,
    getAdapter: (vendor) => {
      const a = discussionAdapters.get(vendor)
      if (!a) throw new Error(`[c3] no adapter registered for vendor "${vendor}"`)
      return a
    },
  })

  const ctx: KernelContext = {
    eventBus,
    launchDeps,
    launchRun: (rt, prompt) => launchRun(rt, prompt, launchDeps),
    broadcastStatuses: broadcasts.broadcastStatuses,
    broadcastIntents: broadcasts.broadcastIntents,
    broadcastIntentSessions: broadcasts.broadcastIntentSessions,
    broadcastDiscussions: broadcasts.broadcastDiscussions,
    broadcastSchedules: broadcasts.broadcastSchedules,
    broadcastAutomation: broadcasts.broadcastAutomation,
    broadcastDiscussionMessage: broadcasts.broadcastDiscussionMessage,
    broadcastDiscussionRunStatus: broadcasts.broadcastDiscussionRunStatus,
    broadcastWaitUserEvents: broadcasts.broadcastWaitUserEvents,
    startDiscussionRun: discussionRuns.startDiscussionRun,
    startResearchRun: discussionRuns.startResearchRun,
  }
  // R6 boot-time guard: no transport field (sock/viewer/connections) may cross
  // the kernel boundary.
  assertNoTransportFields(ctx)

  // Register application-lifetime domain subscriptions (ADR-0018 resident
  // subs model): replaces all per-launch `subscribe`/`dispose` patterns in
  // session/intent/dev-turn handlers with resident, single-responsibility
  // subscriptions that match by sessionId and are never disposed.
  registerRunDomainSubscriptions({
    eventBus,
    broadcaster,
    broadcastSessions: broadcasts.broadcastSessions,
    broadcastIntents: broadcasts.broadcastIntents,
    broadcastIntentSessions: broadcasts.broadcastIntentSessions,
    broadcastDiscussions: broadcasts.broadcastDiscussions,
    broadcastSchedules: broadcasts.broadcastSchedules,
    broadcastWaitUserEvents: broadcasts.broadcastWaitUserEvents,
  })

  // 40+ case switch collapsed to a single registry dispatch (ADR-0009).
  const handlerRegistry = registerHandlers()
  app.get(
    '/ws',
    createWsHandler({ upgradeWebSocket, broadcaster, ctx, handlerRegistry, sessionAccessor }),
  )

  // Codex relay loopback endpoint (ADR-0014). MUST be registered before the static
  // catch-all (`app.get('*')`) so it is not swallowed by the SPA fallback.
  app.post(`${CODEX_RELAY_PATH}/responses`, (c) => codexRelay.handler(c))

  // Static frontend (production / pkg) vs dev placeholder.
  if (opts.dev) mountDevPlaceholder(app)
  else mountStaticAssets(app)

  const server = serve({ fetch: app.fetch, port: opts.port }, (info) => {
    const url = `http://localhost:${info.port}`
    console.log(`[c3] server running at ${url}`)
    if (opts.projectPath) console.log(`[c3] seed workspace: ${opts.projectPath}`)
    if (opts.dev) console.log(`[c3] dev mode — open Vite at http://localhost:5173`)
  })
  injectWebSocket(server)

  // Start the schedule scheduler after the server is ready.
  startSchedulerWiring({ broadcasts, eventBus })

  // Graceful shutdown: stop the scheduler on process termination.
  const shutdown = async (): Promise<void> => {
    console.log('[c3] shutting down...')
    await stopSchedulerWiring(30_000)
    // Tree-kill the supervised OpenCode server so no orphan/port leaks (idempotent;
    // the supervisor also self-registers exit handlers as a backstop).
    opencodeSupervisor?.stop()
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
