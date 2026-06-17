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
import { INTENT_DISALLOWED_TOOLS, waitForDecision } from './kernel/permission/index.js'
import { launchRun, type LaunchRunDeps } from './kernel/run/run-lifecycle.js'
import { DockerDriver } from './kernel/sandbox/docker/DockerDriver.js'
import { SandboxRegistry } from './kernel/sandbox/SandboxRegistry.js'
import { getSystemSandboxes } from './kernel/config/index.js'
import { setOnAgentSwap, setOnBind, resolveSessionVendor } from './kernel/agent-config/index.js'
import { addWorkspace, listWorkspaces, resolveWorkspaceRoot } from './state.js'
import { sessionExists } from './sessions.js'
import {
  reconcileLiveness,
  setOnStatusChange,
  isRunning,
  setOnRunEnd,
  setOnEmit,
  setTaskObserver,
  emit,
} from './runs.js'
import { observeTaskWire } from './kernel/agent/task-tracker.js'
import { getSessionAgentId, getUiLang, setOnPendingIntentLookup } from './kernel/config/index.js'
import { setAutomationHooks } from './features/intents/automation.js'
import { buildIntentAgentPrompt } from './features/intents/prompt.js'
import { createIntentMcpServer } from './features/intents/save-tool.js'
import { runFind, runView } from './features/intents/tool-defs.js'
import { gatedSave } from './features/intents/save-gate.js'
import {
  createIntentMcp,
  INTENT_MCP_PATH,
  type IntentMcpTools,
} from './transport/intent-mcp/index.js'
import { renameChatSession, listChatSessions } from './features/intents/store.js'
import { createPermissionRequestHandler } from './features/user-involve/hooks.js'
import { startHeartbeatScheduler, stopHeartbeatScheduler } from './features/license/heartbeat.js'
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
  workspacePath?: string
  port: number
  dev: boolean
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
    // 24h). `titleAccessor` / `broadcasts` are forward-referenced (built below);
    // this closure only runs at run-end, long after the composition root finishes
    // — the same pattern as the janitor's native list above. NOTE: this uses
    // `titleAccessor`, NOT the list/janitor `sessionAccessor` — the latter
    // excludes codex on purpose (its disk-scan listing is a separate concern), but
    // run-end title backfill MUST read codex's JSONL so a codex session's title
    // does not stay "New session" when the live baseline has not yet been
    // hydrated from disk.
    void (async () => {
      let title = input.title
      try {
        const summaries = await titleAccessor.list({ cwd: input.workspacePath })
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
      const workspaces = listWorkspaces().map((w) => resolveWorkspaceRoot(w.id)!)
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

  // Codex lifecycle (2026-06-06-007): Codex spawns its CLI per run
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
  // projection table, a separate concern). claude is always present.
  const sessionSources: VendorSessionSource[] = [
    { vendor: 'claude', sessions: new ClaudeSessionStore() },
  ]
  const sessionAccessor = new SessionAccessor(sessionSources)

  // Run-end title-backfill accessor (codex "New session" fix). Separate from the
  // list/janitor `sessionAccessor` above so codex's disk-scan store can feed the
  // `onRunEnd` title lookup WITHOUT joining the cross-vendor list/janitor union
  // (codex stays excluded there per ADR-0013 — its list semantics depend on the
  // projection table, not a disk scan). `codexAdapter.sessions` is a
  // `CodexSessionStore` that derives the title from the first user prompt in the
  // on-disk JSONL; absent when the codex CLI isn't installed (then there are no
  // codex sessions to title anyway).
  const titleAccessor = codexAdapter
    ? new SessionAccessor([...sessionSources, { vendor: 'codex', sessions: codexAdapter.sessions }])
    : sessionAccessor

  const app = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

  // Seed the registry with the CLI-provided workspace (idempotent).
  if (opts.workspacePath) addWorkspace(opts.workspacePath, Date.now())

  // Single broadcast egress (ADR-0009 R2 / server refactor 2/3b). All wire frames
  // funnel through `broadcaster.toAll`; the per-run delivery (emit/viewers,
  // ADR-0006) is separate. Wiring builds the frames; the broadcaster only ships.
  const connections = new Set<Deliver>()
  const broadcaster = createBroadcaster(connections)
  const broadcasts = createBroadcasts({ broadcaster, sessionAccessor })
  setOnStatusChange(broadcasts.broadcastStatuses)

  // WorkCenter event hook (createEvent + broadcast before each human permission
  // prompt). ONE instance shared by every permission_request exit — the claude/driver
  // run paths (via launchDeps.onPermissionRequest) AND the codex intent save gate
  // (via gatedSave below) — so multi-vendor prompts all land in the pending-items panel.
  const onPermissionRequest = createPermissionRequestHandler({ broadcaster })

  // Intent tools over localhost HTTP MCP (2026-06-12-005): the driver-path twin of
  // the in-process SDK MCP (`createIntentMcpServer`). codex's comm-agent reaches
  // find/view/save here. find/view are read-only; `save` runs the SAME confirmation
  // gate the claude path uses — a `permission_request` frame on the bound run +
  // `waitForDecision` — so a save still needs the user's OK in c3 UI, and a deny
  // never reaches the store. The intent route is mounted below (before the SPA
  // catch-all) and bound per-run via `intentProfile.bindDriverMcp`.
  const intentMcpTools: IntentMcpTools = {
    find: (workspacePath, args) => runFind(workspacePath, args),
    view: (workspacePath, args) => runView(workspacePath, args),
    save: (binding, args) =>
      gatedSave(
        {
          emit,
          waitForDecision,
          broadcastIntents: broadcasts.broadcastIntents,
          onPermissionRequest,
        },
        binding,
        args,
      ),
  }
  const intentMcp = createIntentMcp(`http://127.0.0.1:${opts.port}`, intentMcpTools)
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

  // ── Sandbox wiring (ADR-0024) ──────────────────────────────────────────────
  // Build the system sandbox-def registry from settings and instantiate the
  // Docker driver, then thread both into the run lifecycle. The run-lifecycle
  // gate only fires when a project actually enables sandbox with an existing
  // def, so wiring this unconditionally is harmless for non-sandbox users (and
  // dockerode connects lazily — no throw when Docker is absent). Defs are read
  // at startup; a settings change needs a restart to re-register (MVP).
  const sandboxRegistry = new SandboxRegistry()
  for (const def of getSystemSandboxes()) sandboxRegistry.register(def)
  const sandboxDriver = new DockerDriver()
  if (sandboxRegistry.size > 0) {
    console.log(`[sandbox] registry ready: ${sandboxRegistry.names().join(', ')}`)
  }

  const launchDeps: LaunchRunDeps = {
    sandboxDriver,
    sandboxRegistry,
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
      // Driver-path (codex) intent tools over localhost HTTP MCP (2026-06-12-005).
      // runViaDriver binds this per-run and injects the descriptors; claude ignores
      // it (it uses the in-process `mcpServers` above).
      bindDriverMcp: (binding) => intentMcp.bind(binding),
    }),
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
    // Shared with the codex intent save gate (hoisted above).
    onPermissionRequest,
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
  // claude is always present; codex joins only when its host CLI
  // was detected at boot (null-entries are skipped — missing vendors throw at
  // runtime, which is a fatal developer error, not a silent degradation).
  const discussionAdapters = new Map<VendorId, VendorAdapter>()
  discussionAdapters.set('claude', createClaudeAdapter())
  if (codexAdapter) discussionAdapters.set('codex', codexAdapter)
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
    launchRun: (rt, prompt, images) => launchRun(rt, prompt, launchDeps, images),
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

  // Intent MCP loopback endpoint (2026-06-12-005). `all` covers POST (JSON-RPC
  // messages), GET (SSE stream), and DELETE (session end). Loopback-guarded +
  // per-run token inside the handler. Before the SPA catch-all, same as the relay.
  app.all(INTENT_MCP_PATH, (c) => intentMcp.handler(c))

  // Static frontend (production / pkg) vs dev placeholder.
  if (opts.dev) mountDevPlaceholder(app)
  else mountStaticAssets(app)

  const server = serve({ fetch: app.fetch, port: opts.port }, (info) => {
    const url = `http://localhost:${info.port}`
    console.log(`[c3] server running at ${url}`)
    if (opts.workspacePath) console.log(`[c3] seed workspace: ${opts.workspacePath}`)
    if (opts.dev) console.log(`[c3] dev mode — open Vite at http://localhost:5173`)
  })
  injectWebSocket(server)

  // Start the schedule scheduler after the server is ready.
  startSchedulerWiring({ broadcasts, eventBus })

  // Start the product-license heartbeat loop (ADR-0026, PL-R3). Fail-soft; pushes
  // the refreshed license state after each beat so the badge tracks displacement/expiry.
  startHeartbeatScheduler({ onChange: broadcasts.broadcastLicense })

  // Graceful shutdown: stop the scheduler on process termination.
  const shutdown = async (): Promise<void> => {
    console.log('[c3] shutting down...')
    stopHeartbeatScheduler()
    await stopSchedulerWiring(30_000)
    server.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
