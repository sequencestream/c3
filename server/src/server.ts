/**
 * `server.ts` — the composition root (server refactor 3/3e-3, ADR-0009 R3).
 *
 * Pure assembler: Hono + ws setup, kernel context construction, feature-hook
 * wiring, static assets, scheduler lifecycle, SIGINT/SIGTERM. All heavier
 * helper closures have been pushed into `wiring/`; all domain logic lives in
 * `kernel/`. The `KernelContext` shape is unchanged.
 */
import { spawn, spawnSync } from 'node:child_process'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import {
  INTENT_DISALLOWED_TOOLS,
  SPEC_DISALLOWED_TOOLS,
  SPEC_REVIEW_DISALLOWED_TOOLS,
  waitForDecision,
} from './kernel/permission/index.js'
import { launchRun, type LaunchRunDeps } from './kernel/run/run-lifecycle.js'
import { probeArapuca } from './kernel/sandbox/SandboxLauncher.js'
import { enableArapucaAutoInstall } from './kernel/sandbox/arapuca-dist.js'
import { initLogging, shutdownLogging } from './kernel/infra/logger.js'
import { setOnAgentSwap, setOnBind, resolveSessionVendor } from './kernel/agent-config/index.js'
import { listWorkspaces, resolveWorkspaceRoot } from './state.js'
import { sessionExists } from './sessions.js'
import {
  reconcileLiveness,
  emit,
  setOnStatusChange,
  isRunning,
  getRuntime,
  setOnRunEnd,
  setOnEmit,
  setTaskObserver,
  type SessionRuntime,
} from './runs.js'
import { observeTaskWire } from './kernel/agent/task-tracker.js'
import { getSessionAgentId, getAgentLang, setOnPendingIntentLookup } from './kernel/config/index.js'
import {
  reconcileQueuesOnStartup,
  setWorkflowHooks,
  startQueueTickLoop,
  stopQueueTickLoop,
} from './features/intents/workflow.js'
import { setIntentLifecycleEventBus } from './features/intents/lifecycle-events.js'
import { setRunLifecycleBus } from './kernel/run/internal-run.js'
import { buildIntentAgentPrompt } from './features/intents/prompt.js'
import { buildSpecAgentPrompt } from './features/intents/spec-prompt.js'
import { buildSpecReviewAgentPrompt } from './features/intents/spec-review.js'
import { DISCUSSION_RESEARCH_PROMPT } from './features/discussions/research.js'
import { runFind, runView } from './features/intents/tool-defs.js'
import { runCommSave } from './features/intents/save-comm.js'
import { normalizeGenericEventDefault } from './features/events/default-normalizer.js'
import {
  normalizePrGenericEvent,
  PR_EVENT_TYPES,
  PR_LEGACY_EVENT_TYPE,
} from './features/pr-events/tool-defs.js'
import { runPublishEvent } from './features/events/tool-defs.js'
import type { AutomationMcpDeps } from './features/automations/c3-tools.js'
import { setAutomationHttpMcp } from './features/automations/dispatcher.js'
import { createAutomationMcp, AUTOMATION_MCP_PATH } from './transport/automation-mcp/index.js'
import { createAdvisorMcp, ADVISOR_MCP_PATH } from './transport/advisor-mcp/index.js'
import { createAdvisorApproval } from './features/intents/advisor-approval.js'
import {
  createIntentMcp,
  INTENT_MCP_PATH,
  type IntentMcpTools,
} from './transport/intent-mcp/index.js'
import { createEventMcp, EVENT_MCP_PATH, type EventMcpTools } from './transport/event-mcp/index.js'
import { createSpecQueryMcp, SPEC_QUERY_MCP_PATH } from './transport/spec-query-mcp/index.js'
import { createSpecReviewMcp, SPEC_REVIEW_MCP_PATH } from './transport/spec-review-mcp/index.js'
import { createExternalMcp, EXTERNAL_MCP_PATH_PREFIX } from './transport/external-mcp/index.js'
import { buildExternalMcpCatalog } from './features/external-mcp/tools.js'
import { resolveRegisteredWorkspacePath } from './features/external-mcp/workspace-scope.js'
import { setExternalMcpSessionCloser } from './features/settings/mcp-api-keys.js'
import { touchMcpApiKey, verifyMcpApiKey } from './kernel/config/mcp-api-keys.js'
import { renameChatSession, listChatSessions } from './features/intents/store.js'
import {
  createConsensusAutoHandler,
  createPermissionRequestHandler,
  createQueueTodoHandler,
} from './features/user-involve/hooks.js'
import {
  startUpdateCheckScheduler,
  stopUpdateCheckScheduler,
} from './features/updates/update-checker.js'
import {
  createDesktopUpdateHttp,
  DESKTOP_UPDATE_CHECK_PATH,
  DESKTOP_UPDATE_DOWNLOAD_PATH,
} from './features/updates/desktop-update-http.js'
import {
  configureRelaunch,
  configureSelfUpdate,
  maybeAutoDownload,
  restoreStagedOnBoot,
} from './features/updates/self-update.js'
import { spawnUpdateAssistant } from './update-assistant.js'
import { resolveSelfCommand } from './daemon.js'
import {
  startSessionJanitor,
  stopSessionJanitor,
} from './features/session-cleanup/session-janitor.js'
import { EventBus } from './kernel/events/event-bus.js'
import { EventNormalizerRegistry } from './kernel/events/generic-event.js'
import { type KernelContext, assertNoTransportFields } from './kernel/types.js'
import { createBroadcaster, type Deliver } from './transport/index.js'
import { registerHandlers } from './features/index.js'
import { checkDbDriver } from './kernel/infra/db.js'
import { ensureLegacyImport } from './kernel/config/import-legacy.js'
import {
  getPendingIntent,
  JANITOR_INTERVAL_MS,
  janitor,
  touchOnRunEnd,
  updatePendingRowAgentId,
  updateRealRowAgentId,
  upsertForBind,
} from './features/sessions/session-metadata-store.js'
import { cleanupStalePendingIntents, PENDING_INTENT_TTL_MS } from './kernel/config/index.js'
import { logVendorCliHealth } from './kernel/agent/adapters/registry.js'
import {
  refreshManagedVendorClisInBackground,
  resolve as resolveVendorCli,
} from './kernel/agent/process/launcher.js'
import { createCodexAdapter } from './kernel/agent/adapters/codex/index.js'
import { createCursorAdapter } from './kernel/agent/adapters/cursor/index.js'
import { createClaudeAdapter } from './kernel/agent/adapters/claude/index.js'
import {
  createRelay,
  RELAY_CODEX_PATH,
  RELAY_ANTHROPIC_PATH,
  CODEX_RELAY_LEGACY_PATH,
} from './transport/relay/index.js'
import { setRelay } from './kernel/relay/runtime.js'
import type { VendorAdapter } from './kernel/agent/adapters/types.js'
import type { VendorId } from '@ccc/shared/protocol'
import { hasAnyInstalledSkill } from './kernel/skill-loader/index.js'
import { setSkillApprovalSend } from './kernel/skill-loader/approval.js'
import { getSkillRepos } from './kernel/config/index.js'
import { dbPath } from './kernel/infra/db.js'
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
  registerRunLifecycleLogging,
  startSchedulerWiring,
  stopSchedulerWiring,
} from './wiring/index.js'

export interface ServerOptions {
  port: number
  dev: boolean
  /**
   * The interface to bind. Omitted ⇒ {@link DEFAULT_HOST} (loopback only).
   *
   * This used to be implicit: `serve()` without a hostname listens on EVERY
   * interface, so a machine on the LAN could already reach c3 without anyone
   * choosing that. Exposure is now an explicit decision — `0.0.0.0` / `::` / a
   * specific interface address — which is what makes the API-key-guarded
   * external MCP route safe to ship.
   */
  host?: string
}

/**
 * The listen address when none is configured: loopback, so a fresh install and
 * an upgraded one are both reachable only from the machine itself. Opening c3 to
 * a network is a deliberate `--host` choice.
 */
export const DEFAULT_HOST = '127.0.0.1'

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
  // ---- File logging: tee console output to ~/.c3/log/c3.log (best-effort) ----
  // Installed first so every subsequent startup line is also persisted. The c3
  // home dir is already resolved by this point (cli.ts called setSettingsPath).
  initLogging()

  // ---- Wire the `session_metadata` projection hooks (kernel ↛ features) ----
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

  // ---- session_metadata projection janitor (F-9) ----
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
      console.error('[c3] session_metadata janitor failed:', err)
    }
  }, JANITOR_INTERVAL_MS)

  // Probe the platform's builtin SQLite driver up front (release 4/7). On a newly
  // supported target (e.g. a Windows Bun binary) a missing `bun:sqlite` would
  // otherwise surface as a silent persistence-less degrade discovered much later;
  // detect it loudly at boot instead. The app still starts (callers degrade), but
  // the operator is told exactly what broke.
  checkDbDriver()

  // Import the legacy JSON configuration files (settings.json / state.json) into the
  // database, once per installation. Deliberately triggered HERE and nowhere else:
  // a read path that imported on demand would make any process that merely reads a
  // setting — a unit test, a one-off script — rewrite and retire the user's real
  // files. Only a starting server owns that transition.
  ensureLegacyImport()

  // Probe vendor CLIs up front. The default source is c3's managed vendor dir;
  // env overrides remain explicit, and host PATH is only a degraded fallback.
  // The remote side of that sync (npm packument fetch, tarball download, integrity
  // check, npm install) runs in the BACKGROUND: a slow or unreachable registry must
  // never delay port binding and readiness. Each vendor keeps its own 24h
  // remote-check cooldown, so most starts trigger no network work at all. The health
  // log right below is therefore the snapshot resolvable NOW — not the outcome of
  // the refresh just triggered; a vendor may still read as missing until the
  // background install lands.
  refreshManagedVendorClisInBackground()
  logVendorCliHealth()

  // Codex lifecycle (2026-06-06-007): Codex spawns its CLI per run
  // via the SDK (no supervisor), so the adapter is built directly — vendor CLI
  // gated like the others. Built here so the kernel launcher only sees the neutral
  // VendorAdapter (injected via launchDeps.getCodexAdapter). Missing CLI ⇒ null, and
  // the codex agent type is simply unavailable (a session falls back / errors loud).
  // Vendor-neutral in-process relay (ADR-0029): every vendor CLI's provider traffic
  // is routed to a loopback endpoint with a per-run token so the real provider key
  // never reaches the subprocess/sandbox; the relay translates/passes-through per
  // vendor and fails over across a group's candidate list. Built unconditionally,
  // mounted below, injected into the codex adapter, and registered as the process
  // relay singleton so the claude launch path and the one-shot advisor reach it too.
  const relay = createRelay(`http://127.0.0.1:${opts.port}`)
  setRelay(relay)
  let codexAdapter: VendorAdapter | null = null
  if (resolveVendorCli('codex')) {
    try {
      codexAdapter = createCodexAdapter(undefined, undefined, relay)
      console.log('[c3] codex ready (per-run CLI)')
    } catch (e) {
      console.warn(`[c3] codex unavailable: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Cursor: a per-run `cursor-agent` CLI, like the other vendors. The credential
  // is NOT resolved here — it is per-agent (the bound agent's config, else the
  // ambient CURSOR_API_KEY, else the CLI's own keychain login) and reaches the
  // driver on the run's env map, so a server with no key still exposes cursor.
  let cursorAdapter: VendorAdapter | null = null
  if (resolveVendorCli('cursor')) {
    try {
      cursorAdapter = createCursorAdapter()
      console.log('[c3] cursor ready (per-run CLI)')
    } catch (e) {
      console.warn(`[c3] cursor unavailable: ${e instanceof Error ? e.message : String(e)}`)
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

  // Single broadcast egress (ADR-0009 R2 / server refactor 2/3b). All wire frames
  // funnel through `broadcaster.toAll`; the per-run delivery (emit/viewers,
  // ADR-0006) is separate. Wiring builds the frames; the broadcaster only ships.
  const connections = new Set<Deliver>()
  const broadcaster = createBroadcaster(connections)
  const broadcasts = createBroadcasts({ broadcaster, sessionAccessor })
  setOnStatusChange(broadcasts.broadcastStatuses)

  // WorkCenter event hook (createEvent + broadcast before each human permission
  // prompt). ONE instance shared by every permission_request exit (the claude/driver
  // run paths, via launchDeps.onPermissionRequest) — so multi-vendor prompts all
  // land in the pending-items panel.
  const onPermissionRequest = createPermissionRequestHandler({ broadcaster })
  // Consensus auto-resolution audit hook: records a non-blocking `status: 'auto'`
  // WaitUserInvolveEvent whenever the gateway auto-decides via multi-agent consensus
  // (no human prompt), so automatic decisions stay traceable in WorkCenter.
  const onConsensusResolved = createConsensusAutoHandler()
  // Intent tools over the loopback HTTP MCP route — the SINGLE transport both
  // Claude and Codex now consume for the comm-agent's find/view/save. find/view are
  // read-only; `save` runs the ONE comm-save handler (`runCommSave`) shared by both
  // vendors: the user already confirmed the listed intents in the conversation, so
  // it persists straight away without any browser round-trip.
  // The route is mounted below (before the SPA catch-all) and bound per-run via
  // `intentProfile.bindMcp`.
  const intentMcpTools: IntentMcpTools = {
    find: (workspacePath, args) => runFind(workspacePath, args),
    view: (workspacePath, args) => runView(workspacePath, args),
    save: (binding, args) =>
      runCommSave({ broadcastIntents: broadcasts.broadcastIntents }, binding, args),
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
    if (rt.sessionKind !== 'intent') return
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
  setIntentLifecycleEventBus(eventBus)
  setRunLifecycleBus(eventBus)
  // Run 生命周期日志:注册在总线建好后的第一时间,这样此后任何发布者(交互式
  // launcher、driver、automation、discussion、一次性内部调用)的启动/退出都被记
  // 录,不依赖各自的调用顺序。
  registerRunLifecycleLogging(eventBus)

  // Generic event contract + kernel normalizer registry. Every model-publishable
  // event is routed through `type → normalizer`: a KNOWN type gets its dedicated
  // typed normalizer, any other (custom) type falls through to the default
  // normalizer — both perform field-level redaction/truncation. The open
  // `<category>:<action>` contract means a `custom:*` event publishes safely rather
  // than being rejected. The PR event types (`pr:<operation>`, plus the retired
  // `pr:operation` alias the normalizer rewrites) are the first registered set;
  // their normalizer is the SINGLE normalization used by both the model publish
  // paths and the three server-side PR-create paths. `normalizeEvent` is injected
  // wide; a missing PR registration is a publish failure, never a bypass.
  const eventNormalizers = new EventNormalizerRegistry(normalizeGenericEventDefault)
  for (const type of PR_EVENT_TYPES) eventNormalizers.register(type, normalizePrGenericEvent)
  eventNormalizers.register(PR_LEGACY_EVENT_TYPE, normalizePrGenericEvent)
  const normalizeEvent = (core: import('@ccc/shared').GenericEvent) =>
    eventNormalizers.normalize(core)

  // Vendor-neutral model-publishable events. The model performs its operation
  // with its OWN tools, then calls `publish_event` to publish ONE generic event;
  // the pipeline normalizes it (per-type registry) and delivers the normalized
  // `GenericEvent` inside a `GenericEventEnvelope` onto the single `'event'` bus
  // topic. Consumers discriminate `event.type` (`pr:operation` is the first type).
  // ONE bus sink is shared by both MCP surfaces (Claude in-process below + the
  // codex localhost HTTP route here). The route is mounted before the SPA catch-all.
  const publishEvent = (payload: import('@ccc/shared').GenericEventEnvelope): void =>
    eventBus.publish('event', payload)
  const eventMcpTools: EventMcpTools = {
    publish: (binding, args) =>
      runPublishEvent(args, normalizeEvent, (event) =>
        publishEvent({
          workspacePath: binding.workspacePath,
          sessionId: binding.getRunId(),
          event,
        }),
      ),
  }
  const eventMcp = createEventMcp(`http://127.0.0.1:${opts.port}`, eventMcpTools)
  const specQueryMcp = createSpecQueryMcp(`http://127.0.0.1:${opts.port}`)
  const specReviewMcp = createSpecReviewMcp(`http://127.0.0.1:${opts.port}`)

  // ── Sandbox wiring (arapuca process-level isolation) ───────────────────────
  // Probe arapuca once at startup for the "sandbox available?" signal (log only;
  // the run-lifecycle gate only fires when a project actually enables sandbox, and
  // re-probes with a hard-fail there). Wiring is unconditional and harmless for
  // non-sandbox users — no container daemon to reach.
  // Auto-install is wired ON here (and only here): a long-lived server may fetch
  // the version-pinned arapuca in the background, while unit tests and embedders
  // that merely import the kernel never reach the network. The very next probe
  // starts that download if the managed install is absent — without blocking.
  enableArapucaAutoInstall()
  const arapucaProbe = probeArapuca()
  console.log(
    arapucaProbe.ok
      ? `[sandbox] arapuca available via ${arapucaProbe.source} (process-level isolation ready)`
      : `[sandbox] arapuca unavailable (${arapucaProbe.uiCode}) — sandbox-enabled runs will hard-fail ` +
          'until the c3-managed install finishes or one is on PATH',
  )

  const launchDeps: LaunchRunDeps = {
    sandboxEnabled: true,
    eventBus,
    broadcastStatuses: broadcasts.broadcastStatuses,
    broadcastIntents: broadcasts.broadcastIntents,
    intentProfile: (workspacePath, sessionId) => ({
      // Read the live agent-output language at run start so the analyst replies
      // in the language the console is being used in, not a hard-coded one.
      // `sessionId` (the run's id at launch, possibly pending) is injected so the
      // model can back-link a single saved intent to this comm session.
      appendSystemPrompt: buildIntentAgentPrompt(getAgentLang(), sessionId),
      disallowedTools: INTENT_DISALLOWED_TOOLS,
      // The three intent tools over c3's loopback HTTP MCP route — the SINGLE
      // transport every vendor consumes. Bound per-run (the run path
      // supplies workspace + live run id + signal); `save_intents` lands in the
      // shared comm handler (`runCommSave`, wired into `intentMcpTools` above),
      // so every vendor persists through one identical path.
      bindMcp: (binding) => intentMcp.bind(binding),
      gate: 'intent' as const,
    }),
    // Spec-authoring profile (write-confined gate + disallowed-tools lock + spec
    // prompt). `specDir` is per-run and rides on the runtime, not this static
    // profile. Every vendor consumes the two READ-ONLY ledger query tools
    // (find/view) over the same loopback HTTP MCP route. No save, no run-level
    // binding — the spec author reads existing intents to ground the spec but can
    // never write the ledger. The same path runs on reset_spec_session, so a reset
    // session gets the tools too.
    specProfile: () => ({
      appendSystemPrompt: buildSpecAgentPrompt(getAgentLang()),
      disallowedTools: SPEC_DISALLOWED_TOOLS,
      bindMcp: (binding) => specQueryMcp.bind(binding),
      gate: 'spec' as const,
    }),
    // Spec-REVIEW profile (strictly read-only gate + a STRICTER disallowed-tools
    // lock than the author's — the write tools are cut at the SDK level too, since
    // a reviewer has no writable location for a path check to decide about).
    // `intentId` + `fingerprint` come off the runtime and are closed over here, so
    // the reviewer's `submit_spec_review` can only ever conclude about the one
    // intent and the one document version this review was launched for.
    specReviewProfile: (workspacePath, intentId, fingerprint) => ({
      appendSystemPrompt: buildSpecReviewAgentPrompt(getAgentLang()),
      disallowedTools: SPEC_REVIEW_DISALLOWED_TOOLS,
      bindMcp: (binding) => specReviewMcp.bind({ ...binding, intentId, fingerprint }),
      gate: 'spec_review' as const,
    }),
    // Discussion-research profile (read-only gate + disallowed-tools lock + the
    // research system prompt). The first, unattended research pass applies this
    // itself; this wiring is what re-applies it to a FOLLOW-UP turn on the same
    // session, which flows through the generic launch path. Selected by the
    // runtime's research marker, never by `sessionKind` alone — the orchestrator's
    // per-agent discussion sessions must not inherit the research role.
    researchProfile: () => ({
      appendSystemPrompt: DISCUSSION_RESEARCH_PROMPT,
      disallowedTools: INTENT_DISALLOWED_TOOLS,
      gate: 'discussion-research' as const,
    }),
    // Work-session base MCP profile: every new and resumed work session gets
    // `publish_event` so the model can publish a vendor-neutral generic event
    // after acting with its own tools. No gate override, no disallowed-tools lock
    // — the run keeps its standard surface. Every vendor binds the same
    // loopback HTTP MCP route.
    sessionProfile: () => ({
      bindMcp: (binding) => eventMcp.bind(binding),
    }),
    // The neutral adapter for a driver-path vendor, or null when its host CLI is
    // missing (launchRun forks to the driver path for every non-claude vendor).
    getDriverAdapter: (vendor) => {
      switch (vendor) {
        case 'codex':
          return codexAdapter ?? null
        case 'cursor':
          return cursorAdapter ?? null
        case 'claude':
          // Claude runs on its own SDK loop, not the driver path.
          return null
      }
    },
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
    // Consensus auto-decision audit hook (non-blocking 'auto' WorkCenter record).
    onConsensusResolved,
  }
  const runDevTurn = makeRunDevTurn({ launchDeps })
  // Feature-private: NOT on the kernel context (ADR-0009 R1).
  const workflowHooks = {
    runDevTurn,
    // The spec-phase launcher the queue hands to `launchSpecSession` /
    // `launchSpecReviewSession`. Identical to the WS handlers' `ctx.launchRun`,
    // so a spec session started by the queue and one started by a human button
    // take the exact same launch path — including the profile locks.
    launchSpecRun: (rt: SessionRuntime, prompt: string) => launchRun(rt, prompt, launchDeps),
    broadcastIntents: broadcasts.broadcastIntents,
    emitStatus: broadcasts.broadcastWorkflow,
    sessionExists,
    isRunning,
    sessionStatus: (id: string) => getRuntime(id)?.status ?? null,
    normalizeEvent,
    publishEvent,
    createUserTodo: createQueueTodoHandler({ broadcaster }),
    broadcastQueueDetail: broadcasts.broadcastQueueDetail,
  }
  setWorkflowHooks(workflowHooks)
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
  // Configure the automation c3 MCP deps AFTER the discussion run starters exist
  // (the discussion tools need `startDiscussionRun`). The stored deps are only
  // invoked at automation-dispatch runtime, well after startup. ONE deps object
  // feeds the loopback HTTP MCP route (`createAutomationMcp`) that EVERY vendor's
  // automations bind per execution, so they all run the SAME tool behaviors from
  // one definition.
  const automationMcpDeps: AutomationMcpDeps = {
    broadcastIntents: broadcasts.broadcastIntents,
    normalizeEvent,
    publishEvent,
    broadcastDiscussions: broadcasts.broadcastDiscussions,
    broadcastDiscussionMessage: broadcasts.broadcastDiscussionMessage,
    startDiscussionRun: discussionRuns.startDiscussionRun,
    launchRun: (rt, prompt, images, inject) => launchRun(rt, prompt, launchDeps, images, inject),
  }
  // The automation c3 MCP over loopback HTTP: the dispatcher binds it per execution
  // (Claude and Codex both) when the automation selects a c3 tool. Mounted before
  // the SPA catch-all, same as the intent / event / relay routes.
  const automationMcp = createAutomationMcp(`http://127.0.0.1:${opts.port}`, automationMcpDeps)
  setAutomationHttpMcp(automationMcp)

  // The PUBLIC external MCP route. Unlike every route above it takes no origin
  // and mints no per-run token: an agent c3 did not start authenticates with a
  // long-lived API key that IS the address, and the scope — one workspace, one
  // ticked tool set — is rebuilt from that key on every request. Wired here, after
  // the run launcher and discussion starters exist, because a key may be granted
  // write tools that reach both. It shares the SAME event bus sink, intent store
  // and session launcher as the internal surfaces, so an external caller observes
  // identical behaviour; only the attribution differs.
  const externalMcp = createExternalMcp({
    authenticate: (key) => verifyMcpApiKey(key),
    resolveRegisteredWorkspace: resolveRegisteredWorkspacePath,
    onAuthenticated: (keyId) => touchMcpApiKey(keyId, Date.now()),
    buildCatalog: (scope) =>
      buildExternalMcpCatalog(scope, {
        normalizeEvent,
        publishEvent,
        broadcastIntents: broadcasts.broadcastIntents,
        broadcastDiscussions: broadcasts.broadcastDiscussions,
        broadcastDiscussionMessage: broadcasts.broadcastDiscussionMessage,
        startDiscussionRun: discussionRuns.startDiscussionRun,
        launchRun: (rt, prompt, images, inject) =>
          launchRun(rt, prompt, launchDeps, images, inject),
      }),
  })
  // Revoking a key — or narrowing its tool scope — must also kill the sessions it
  // already opened, not just refuse the next handshake: the settings handler calls
  // back into the live route.
  setExternalMcpSessionCloser((keyId) => externalMcp.closeSessionsForKey(keyId))

  // The QUEUE ADVISOR c3 MCP over loopback HTTP — a route of its own, bound per
  // consultation (workspace + one intent + chain depth). Kept separate from the
  // automation route on purpose: an ordinary automation must not be able to reach
  // these tools. Every vendor reads the same group from this one route (ADR-0011).
  // Confirmation-required tools run through the SAME approval gate `save_intents`
  // uses, so a human sees advisor writes where they see every other write request.
  const advisorMcp = createAdvisorMcp(`http://127.0.0.1:${opts.port}`, {
    broadcastIntents: broadcasts.broadcastIntents,
    broadcastWaitUserEvents: broadcasts.broadcastWaitUserEvents,
    launchRun: (rt, prompt, images, inject) => launchRun(rt, prompt, launchDeps, images, inject),
    normalizeEvent,
    publishEvent: (workspacePath, sessionId, event) =>
      eventBus.publish('event', { workspacePath, sessionId, event }),
    publishStatusChanged: (input) => eventBus.publish('intent:status_changed', input),
    requestWriteApproval: createAdvisorApproval({
      emit,
      waitForDecision,
      onPermissionRequest,
    }),
  })

  const ctx: KernelContext = {
    eventBus,
    normalizeEvent,
    launchDeps,
    launchRun: (rt, prompt, images, inject) => launchRun(rt, prompt, launchDeps, images, inject),
    broadcastStatuses: broadcasts.broadcastStatuses,
    broadcastIntents: broadcasts.broadcastIntents,
    broadcastIntentSessions: broadcasts.broadcastIntentSessions,
    broadcastDeliveries: broadcasts.broadcastDeliveries,
    broadcastDiscussions: broadcasts.broadcastDiscussions,
    broadcastAutomations: broadcasts.broadcastAutomations,
    broadcastWorkflow: broadcasts.broadcastWorkflow,
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
    broadcastAutomations: broadcasts.broadcastAutomations,
    broadcastWaitUserEvents: broadcasts.broadcastWaitUserEvents,
    normalizeEvent,
    publishEvent,
    settleResearchTurn: discussionRuns.settleResearchTurn,
  })

  // 40+ case switch collapsed to a single registry dispatch (ADR-0009).
  const handlerRegistry = registerHandlers()
  app.get(
    '/ws',
    createWsHandler({ upgradeWebSocket, broadcaster, ctx, handlerRegistry, sessionAccessor }),
  )

  // Vendor-neutral relay loopback endpoints (ADR-0029). MUST be registered before
  // the static catch-all (`app.get('*')`) so they are not swallowed by the SPA
  // fallback. codex POSTs `<codex>/responses`; the claude SDK POSTs
  // `<anthropic>/v1/messages`. The legacy codex-only path is kept as a transition
  // alias for one release window.
  app.post(`${RELAY_CODEX_PATH}/responses`, (c) => relay.codexHandler(c))
  app.post(`${CODEX_RELAY_LEGACY_PATH}/responses`, (c) => relay.codexHandler(c))
  app.post(`${RELAY_ANTHROPIC_PATH}/v1/messages`, (c) => relay.anthropicHandler(c))

  // Desktop-update endpoints — the Tauri shell's update state machine talks to
  // these. Loopback-guarded inside the handlers. Before the SPA catch-all.
  const desktopUpdateHttp = createDesktopUpdateHttp()
  app.get(DESKTOP_UPDATE_CHECK_PATH, (c) => desktopUpdateHttp.check(c))
  app.get(DESKTOP_UPDATE_DOWNLOAD_PATH, (c) => desktopUpdateHttp.download(c))

  // Intent MCP loopback endpoint (2026-06-12-005). `all` covers POST (JSON-RPC
  // messages), GET (SSE stream), and DELETE (session end). Loopback-guarded +
  // per-run token inside the handler. Before the SPA catch-all, same as the relay.
  app.all(INTENT_MCP_PATH, (c) => intentMcp.handler(c))

  // Event MCP loopback endpoint (2026-06-20). The codex twin of the
  // work-session in-process publish tool. Loopback-guarded + per-run token inside
  // the handler. Before the SPA catch-all, same as the intent/relay routes.
  app.all(EVENT_MCP_PATH, (c) => eventMcp.handler(c))

  // Spec-query MCP loopback endpoint. The codex twin of the spec-authoring
  // in-process read-only ledger tools. It never registers save_intents.
  app.all(SPEC_QUERY_MCP_PATH, (c) => specQueryMcp.handler(c))
  app.all(SPEC_REVIEW_MCP_PATH, (c) => specReviewMcp.handler(c))

  // Automation MCP loopback endpoint. The codex twin of the automation in-process
  // c3 profile (intent query/write-back, PR events, discussion tools). Bound
  // per-execution by the dispatcher. Loopback-guarded + per-execution token inside
  // the handler. Before the SPA catch-all, same as the other MCP routes.
  app.all(AUTOMATION_MCP_PATH, (c) => automationMcp.handler(c))

  // Advisor MCP loopback endpoint — the queue advisor's dedicated tool group.
  // Bound per consultation; loopback-guarded + per-consultation token inside the
  // handler. Before the SPA catch-all, same as the other MCP routes.
  app.all(ADVISOR_MCP_PATH, (c) => advisorMcp.handler(c))

  // PUBLIC external MCP endpoint. Deliberately NOT under `/internal`: it carries
  // no loopback guard and no per-run token, because its callers are agents c3
  // never launched. The API key in the PATH is the sole credential and the sole
  // scope input — it decides the workspace and the tool set on every request.
  // A wildcard, not `/mcp/:key`, so a malformed address (`/mcp`, `/mcp/`,
  // `/mcp/<key>/extra`) is refused HERE rather than falling through to the SPA
  // catch-all and answering an MCP client with a page of HTML.
  // Registered before the SPA catch-all, same as every other MCP route.
  app.all(EXTERNAL_MCP_PATH_PREFIX, (c) => externalMcp.handler(c))
  app.all(`${EXTERNAL_MCP_PATH_PREFIX}/*`, (c) => externalMcp.handler(c))

  // Static frontend (production / pkg) vs dev placeholder.
  if (opts.dev) mountDevPlaceholder(app)
  else mountStaticAssets(app)

  // Explicit bind address (never the implicit all-interfaces default). The log
  // states the ACTUAL listen address so "why can't the other machine reach it"
  // is answerable from the log alone — and it prints no URL that could carry a
  // token.
  const host = opts.host?.trim() || DEFAULT_HOST
  const server = serve({ fetch: app.fetch, port: opts.port, hostname: host }, (info) => {
    console.log(`[c3] server listening on ${host}:${info.port}`)
    // Which database is in effect — it holds the configuration, so this is the one
    // thing that tells an isolated launch apart from one running on the real
    // `~/.c3` at a glance. Path only.
    console.log(`[c3] database: ${dbPath()}`)
    if (host === DEFAULT_HOST) console.log(`[c3] open http://localhost:${info.port}`)
    else console.log(`[c3] reachable from other hosts — external access is API-key gated`)
    if (opts.dev) console.log(`[c3] dev mode — open Vite at http://localhost:5173`)
  })
  injectWebSocket(server)

  // Start the automation scheduler after the server is ready.
  startSchedulerWiring({ broadcasts, eventBus })

  // Recover every queue that was running before this process started, then arm
  // the fixed reconcile cadence. The startup pass runs BEFORE the tick loop so
  // recovery is derived from persisted facts once, deterministically, instead of
  // racing a timer. Both enter the same idempotent reconcile entry point, so a
  // duplicate pass is harmless. A failure here degrades to "the next tick will
  // reconcile" — it never invents state and never clears any.
  void reconcileQueuesOnStartup(workflowHooks)
    .then((count) => {
      if (count > 0) console.log('[c3:queue] 启动对账完成:%d 个工作区队列', count)
    })
    .catch((err) => console.error('[c3:queue] 启动对账失败:', err))
  startQueueTickLoop()

  // Self-update: reconcile whatever the staging area holds from a previous run
  // (a package waiting for this restart, or a failure the relaunch helper left
  // behind), then let it broadcast every state change.
  configureSelfUpdate({ onChange: broadcasts.broadcastSelfUpdateState })
  restoreStagedOnBoot()

  // Stop everything and release the listening port. Shared by the signal handler
  // and by self-update's relaunch, which must free the port before its successor
  // binds it. Connection close is bounded so a lingering WebSocket cannot wedge a
  // restart.
  const stopAndRelease = async (): Promise<void> => {
    stopUpdateCheckScheduler()
    stopSessionJanitor()
    stopQueueTickLoop()
    await stopSchedulerWiring(30_000)
    await new Promise<void>((resolve) => {
      const done = setTimeout(resolve, 5000)
      done.unref?.()
      server.close(() => {
        clearTimeout(done)
        resolve()
      })
      ;(server as { closeAllConnections?: () => void }).closeAllConnections?.()
    })
    shutdownLogging()
  }

  configureRelaunch({
    pid: process.pid,
    releasePort: stopAndRelease,
    exit: (code) => process.exit(code),
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf-8' })
      if (r.error) return { status: r.status ?? 1, stderr: String(r.error) }
      return { status: r.status, stderr: r.stderr ?? '' }
    },
    spawnAssistant: spawnUpdateAssistant,
    // The foreground successor keeps this terminal and this process group, so
    // Ctrl-C still reaches it; only the shell prompt returns early.
    spawnSuccessor: () => {
      const { command, args } = resolveSelfCommand(
        process.execPath,
        process.argv[1],
        process.argv.slice(2),
        process.execArgv,
      )
      try {
        const child = spawn(command, args, { stdio: 'inherit', detached: false })
        child.unref()
        return child.pid !== undefined
      } catch {
        return false
      }
    },
  })

  // Start the update-availability checker: poll the GitHub releases endpoint for
  // the latest release and broadcast the refreshed snapshot after each check.
  // A check that finds a newer release also arms the background download, so the
  // console can offer "restart to update" without the user going to a terminal.
  // Fail-soft.
  startUpdateCheckScheduler({
    onChange: () => {
      broadcasts.broadcastUpdateStatus()
      maybeAutoDownload()
    },
  })

  // Start the session janitor: when cleanup is switched on system-wide, prune
  // session transcripts older than the retention window from every reachable
  // vendor session store. Fail-soft, daily cadence.
  startSessionJanitor()

  // Graceful shutdown: stop the scheduler on process termination.
  const shutdown = async (): Promise<void> => {
    console.log('[c3] shutting down...')
    await stopAndRelease()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
