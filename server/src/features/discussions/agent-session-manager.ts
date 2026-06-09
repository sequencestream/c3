/**
 * Cross-vendor stateful agent session manager — the resume-aware replacement for
 * stateless {@link askAgentOnce} in the discussion engine.
 *
 * # Why not extend askAgentOnce
 * `askAgentOnce` is a stateless, tool-disabled one-shot that always creates a fresh
 * Claude SDK session. The discussion orchestrator needs persistent sessions that
 * carry context across turns: each `ask()` call reuses the same vendor session so
 * the agent picks up where it left off. Adding resume to `askAgentOnce` would
 * affect every caller (consensus, automation, …), so this module is built as a
 * separate class with its own lifecycle.
 *
 * # Cross-vendor resume
 * All three vendor drivers (`ClaudeDriver`, `CodexDriver`, `OpencodeDriver`) accept
 * `DriverStartOptions.resume` — the manager unifies them through that single path.
 *
 * # Lifecycle
 * 1. **First call**: `getAgentSession` → null → `adapter.driver.start({ prompt })`
 *    → capture `sessionId` → `setAgentSession` into DB.
 * 2. **Subsequent calls**: `getAgentSession` → row found → `start({ resume,
 *    prompt })` → collect text → update `lastSeq` in DB.
 * 3. **Resume failure**: catch → `deleteAgentSession` (clean stale) → fall through
 *    to the create-new path (full prompt, fresh session).
 * 4. **Cleanup**: `closeSession` / `closeAll` → DB delete.
 *
 * @module
 */

import type { AgentConfig, VendorId } from '@ccc/shared/protocol'
import type {
  AgentDriver,
  AgentRun,
  VendorAdapter,
} from '../../kernel/agent/adapters/types.js'
import { launchForAgent } from '../../kernel/agent-config/index.js'
import type { AgentSessionRow } from './store.js'

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Store operations for the `discussion_agent_sessions` table. */
export interface AgentSessionStore {
  getAgentSession(discussionId: string, agentId: string): AgentSessionRow | null
  setAgentSession(
    discussionId: string,
    agentId: string,
    sessionId: string,
    vendor?: string,
    lastSeq?: number,
  ): void
  deleteAgentSession(discussionId: string, agentId: string): void
  deleteAllByDiscussion(discussionId: string): void
}

/** Injected dependencies for {@link AgentSessionManager}. */
export interface AgentSessionManagerDeps {
  /** Resolve a vendor id to its registered adapter. */
  getAdapter: (vendor: VendorId) => VendorAdapter
  /** Discussion agent session store. */
  store: AgentSessionStore
}

// ---------------------------------------------------------------------------
// Action mode & tool gate for background discussion agents
// ---------------------------------------------------------------------------

/**
 * The neutral action-mode × tool-gate defaults for discussion agents.
 *
 * `plan` mode denies destructive writes; `on-sensitive` lets read tools through
 * automatically while sensitive (write) tools gate behind a check that the
 * background session never resolves — effectively they hang or fail, preventing
 * side effects in unattended discussion runs. This approximates
 * `askAgentOnce`'s "all tools denied" behaviour through the neutral adapter
 * layer (which has no per-call `canUseTool` equivalent).
 */
const DISCUSS_ACTION_MODE = 'build' as const
const DISCUSS_TOOL_GATE = 'on-sensitive' as const

// ---------------------------------------------------------------------------
// AgentSessionManager
// ---------------------------------------------------------------------------

/**
 * Manages persistent vendor-agent sessions for discussions.
 *
 * Each {@link ask} call automatically decides between creating a new vendor
 * session and resuming an existing one, with degradation on resume failure.
 */
export class AgentSessionManager {
  constructor(private readonly deps: AgentSessionManagerDeps) {}

  /**
   * Run one turn with the given agent, returning the assistant's text.
   *
   * - First call per `(discussionId, agent)` pair: creates a new vendor session
   *   and persists the mapping.
   * - Subsequent calls: resumes the stored vendor session.
   * - Resume failure: falls back to a new session with the full prompt.
   */
  async ask(
    discussionId: string,
    agent: AgentConfig,
    prompt: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<string> {
    const stored = this.deps.store.getAgentSession(discussionId, agent.id)

    if (stored) {
      try {
        return await this.resumeSession(stored, agent, prompt, cwd, signal)
      } catch {
        // Resume failed — clean up the stale DB entry and fall through to
        // the create-new path (full prompt, fresh session).
        this.deps.store.deleteAgentSession(discussionId, agent.id)
      }
    }

    return this.createSession(discussionId, agent, prompt, cwd, signal)
  }

  /**
   * Return the last-known seq for an agent in a discussion, or `null` when no
   * session has been created yet (first call / resume unavailable). Used by the
   * orchestrator to decide whether to build a full prompt or a delta prompt.
   */
  getLastSeq(discussionId: string, agentId: string): number | null {
    const row = this.deps.store.getAgentSession(discussionId, agentId)
    return row ? row.lastSeq : null
  }

  /** Remove the session mapping for a single agent in a discussion. */
  closeSession(discussionId: string, agentId: string): void {
    this.deps.store.deleteAgentSession(discussionId, agentId)
  }

  /** Remove all agent session mappings for a discussion (discussion end). */
  closeAll(discussionId: string): void {
    this.deps.store.deleteAllByDiscussion(discussionId)
  }

  // ---- Internal ----

  /**
   * Create a new vendor session and persist the mapping.
   * Called on the first `ask()` call or after resume degradation.
   */
  private async createSession(
    discussionId: string,
    agent: AgentConfig,
    prompt: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<string> {
    const driver = this.resolveDriver(agent.vendor)
    const launch = launchForAgent(agent)

    const run = await driver.start({
      prompt,
      cwd,
      signal,
      actionMode: DISCUSS_ACTION_MODE,
      toolGate: DISCUSS_TOOL_GATE,
      ...(launch.model ? { model: launch.model } : {}),
      ...(launch.envOverrides ? { envOverrides: launch.envOverrides } : {}),
      ...(launch.baseUrl ? { baseUrl: launch.baseUrl } : {}),
      ...(launch.apiKey ? { apiKey: launch.apiKey } : {}),
    })

    // Collect assistant text FIRST, then resolve sessionId (the id is always
    // available by the time the stream completes).
    const text = await collectAssistantText(run)
    const sessionId = await run.sessionId()

    this.deps.store.setAgentSession(discussionId, agent.id, sessionId, agent.vendor)
    return text
  }

  /**
   * Resume an existing vendor session by id, send the new prompt, and collect
   * the assistant's text. Throws on failure (caller degrades to create-new).
   */
  private async resumeSession(
    stored: AgentSessionRow,
    agent: AgentConfig,
    prompt: string,
    cwd: string,
    signal: AbortSignal,
  ): Promise<string> {
    const driver = this.resolveDriver(agent.vendor)
    const launch = launchForAgent(agent)

    const run = await driver.start({
      prompt,
      cwd,
      signal,
      resume: stored.sessionId,
      actionMode: DISCUSS_ACTION_MODE,
      toolGate: DISCUSS_TOOL_GATE,
      ...(launch.model ? { model: launch.model } : {}),
      ...(launch.envOverrides ? { envOverrides: launch.envOverrides } : {}),
      ...(launch.baseUrl ? { baseUrl: launch.baseUrl } : {}),
      ...(launch.apiKey ? { apiKey: launch.apiKey } : {}),
    })

    const text = await collectAssistantText(run)

    // Increment lastSeq to record one more turn was processed.
    this.deps.store.setAgentSession(
      stored.discussionId,
      stored.agentId,
      stored.sessionId,
      stored.vendor,
      stored.lastSeq + 1,
    )

    return text
  }

  /**
   * Resolve the vendor driver, throwing a clear error when no adapter is
   * registered for the agent's vendor.
   */
  private resolveDriver(vendor: VendorId): AgentDriver {
    const adapter = this.deps.getAdapter(vendor)
    if (!adapter) {
      throw new Error(
        `agent-session-manager: no adapter registered for vendor "${vendor}"`,
      )
    }
    return adapter.driver
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Iterate the canonical message stream and collect all assistant text.
 *
 * Reads `assistant`-role messages, extracts `text` blocks, and concatenates
 * them into a single string. Returns the trimmed result when the stream ends
 * or the signal aborts.
 */
async function collectAssistantText(run: AgentRun): Promise<string> {
  let text = ''
  for await (const msg of run.messages()) {
    if (msg.role === 'assistant') {
      for (const block of msg.blocks) {
        if (block.type === 'text') {
          text += block.text
        }
      }
    }
  }
  return text.trim()
}
