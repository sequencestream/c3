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
import { REQUIREMENT_DISALLOWED_TOOLS } from './kernel/permission/index.js'
import { launchRun, type LaunchRunDeps } from './kernel/run/run-lifecycle.js'
import { addWorkspace } from './state.js'
import { sessionExists } from './sessions.js'
import { isRunning, reconcileLiveness, setOnStatusChange } from './runs.js'
import { setAutomationHooks } from './features/requirements/automation.js'
import { REQUIREMENT_AGENT_PROMPT } from './features/requirements/prompt.js'
import { createRequirementMcpServer } from './features/requirements/save-tool.js'
import { type KernelContext, assertNoTransportFields } from './kernel/types.js'
import { createBroadcaster, type Deliver } from './transport/index.js'
import { registerHandlers } from './features/index.js'
import { checkDbDriver } from './kernel/infra/db.js'
import { cleanupStalePendingIntents, PENDING_INTENT_TTL_MS } from './kernel/config/index.js'
import { logHostBinaryHealth } from './kernel/agent/adapters/registry.js'
import { resolve as resolveHostBinary } from './kernel/agent/process/launcher.js'
import {
  createOpencodeSupervisor,
  createOpencodeAdapter,
  type OpencodeSupervisor,
} from './kernel/agent/adapters/opencode/index.js'
import { createCodexAdapter } from './kernel/agent/adapters/codex/index.js'
import { createCodexRelay, CODEX_RELAY_PATH } from './transport/codex-relay/index.js'
import type { VendorAdapter } from './kernel/agent/adapters/types.js'
import { ClaudeSessionStore } from './kernel/agent/adapters/claude/session-store.js'
import { SessionAccessor, type VendorSessionSource } from './kernel/agent/session/accessor.js'
import {
  createBroadcasts,
  createDiscussionRuns,
  createWsHandler,
  makeRunDevTurn,
  mountDevPlaceholder,
  mountStaticAssets,
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
  let opencodeAdapter: VendorAdapter | null = null
  let opencodeSupervisor: OpencodeSupervisor | null = null
  const opencodeExternal = !!opts.opencodeUrl
  if (opencodeExternal || resolveHostBinary('opencode')) {
    try {
      const sup = createOpencodeSupervisor({ externalUrl: opts.opencodeUrl })
      await sup.start()
      opencodeSupervisor = sup
      opencodeAdapter = createOpencodeAdapter(sup)
      console.log(`[c3] opencode ready: ${sup.url ?? '?'}${opencodeExternal ? ' (external)' : ''}`)
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
  const broadcasts = createBroadcasts({ broadcaster })
  setOnStatusChange(broadcasts.broadcastStatuses)
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
  //    explicitly. The requirement profile is wired HERE so the kernel
  //    launcher stays features-free (ADR-0009 R1).
  const launchDeps: LaunchRunDeps = {
    broadcastStatuses: broadcasts.broadcastStatuses,
    broadcastRequirements: broadcasts.broadcastRequirements,
    requirementProfile: (workspacePath) => ({
      appendSystemPrompt: REQUIREMENT_AGENT_PROMPT,
      disallowedTools: REQUIREMENT_DISALLOWED_TOOLS,
      mcpServers: createRequirementMcpServer(workspacePath, broadcasts.broadcastRequirements),
      gate: 'requirement' as const,
    }),
    // The neutral OpenCode adapter, or null when unavailable (launchRun forks to
    // the driver path for opencode sessions; 2026-06-06-003).
    getOpencodeAdapter: () => opencodeAdapter,
    // The neutral Codex adapter, or null when its host CLI is missing (launchRun
    // forks to the driver path for codex sessions; 2026-06-06-007).
    getCodexAdapter: () => codexAdapter,
  }
  const runDevTurn = makeRunDevTurn({ launchDeps })
  // Feature-private: NOT on the kernel context (ADR-0009 R1).
  setAutomationHooks({
    runDevTurn,
    broadcastRequirements: broadcasts.broadcastRequirements,
    emitStatus: broadcasts.broadcastAutomation,
    sessionExists,
    isRunning,
  })
  const discussionRuns = createDiscussionRuns({ broadcasts })

  const ctx: KernelContext = {
    launchDeps,
    launchRun: (rt, prompt, cbs) => launchRun(rt, prompt, launchDeps, cbs),
    broadcastStatuses: broadcasts.broadcastStatuses,
    broadcastRequirements: broadcasts.broadcastRequirements,
    broadcastDiscussions: broadcasts.broadcastDiscussions,
    broadcastSchedules: broadcasts.broadcastSchedules,
    broadcastAutomation: broadcasts.broadcastAutomation,
    broadcastDiscussionMessage: broadcasts.broadcastDiscussionMessage,
    broadcastDiscussionRunStatus: broadcasts.broadcastDiscussionRunStatus,
    startDiscussionRun: discussionRuns.startDiscussionRun,
    startResearchRun: discussionRuns.startResearchRun,
  }
  // R6 boot-time guard: no transport field (sock/viewer/connections) may cross
  // the kernel boundary.
  assertNoTransportFields(ctx)

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
  startSchedulerWiring({ broadcaster, broadcasts })

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
