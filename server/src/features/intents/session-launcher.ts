/**
 * Framing-free session launch service — extracts the intent session start logic
 * from both the WebSocket handlers (`start_development`, `write_spec`) into
 * core functions that both the WS adapters and the automation MCP tool adapter
 * call, so the two surfaces never drift.
 *
 * The core functions accept an optional progress callback (for WS →
 * {@link ServerToClient.dev_launch_progress} /
 * {@link ServerToClient.spec_launch_progress}), a {@link SessionLaunchDeps}
 * callback bag, and an optional actor name; they return a structured result
 * that the adapter translates into either an MCP `{content, isError}` or a WS
 * `{type:'error', error}` frame. Never sends to a connection itself — the
 * adapter does that.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PENDING_SESSION_PREFIX } from '@ccc/shared/protocol'
import type { Intent, PromptImage } from '@ccc/shared/protocol'
import { ensureRuntime, getRuntime, isRunning } from '../../runs.js'
import type { SessionRuntime } from '../../runs.js'
import { loadHistory, sessionExists } from '../../sessions.js'
import {
  getDefaultMainBranch,
  getDefaultMode,
  getDevSkill,
  getGitBranchMode,
  getSddEnabled,
} from '../../kernel/config/index.js'
import {
  getDefaultAgentId,
  resolveSessionVendor,
  resolveSpecAgent,
  setSessionAgent,
} from '../../kernel/agent-config/index.js'
import type { RunInject } from '../../kernel/run/prompt-delivery.js'
import {
  getIntent,
  isStoreAvailable,
  listIntents,
  safeInsertIntentLog,
  setBranchName,
  setSpecPath,
} from './store.js'
import {
  clearPendingDevLink,
  registerPendingDevLink,
  releaseDevLaunch,
  tryClaimDevLaunch,
} from './dev-link.js'
import { clearPendingSpecLink, registerPendingSpecLink } from './spec-link.js'
import { buildDevPrompt } from './dev-prompt.js'
import { findDependencyBlockingMainline } from './dependency-gate.js'
import { syncUnconfirmedDependencyPrsInBackground } from './pr-status-sync.js'
import { buildContinueSpecPrompt, buildSeedSpec, buildSpecInstructPrompt } from './spec.js'
import { computeSpecLayout } from './spec-path.js'
import { getSpecsBase, resolveSpecFileAbs } from './specs-root.js'
import { createWorktree, fetchRemoteBase, pullCurrentBranch, readBranch } from './worktree.js'
import { upsertPendingRow } from '../sessions/session-metadata-store.js'

// ── Types ──

export type SessionLaunchResult =
  | { success: true; sessionId: string }
  | { success: false; code: string; params?: Record<string, string> }

export interface SessionLaunchDeps {
  readonly launchRun: (
    rt: SessionRuntime,
    prompt: string,
    images?: PromptImage[],
    inject?: RunInject,
  ) => Promise<void>
  readonly broadcastIntents: (workspacePath: string) => void
}

// ── Helpers ──

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── Work session launcher ──

/**
 * Launch (or restart) a work/development session for an intent. Validates status
 * gate (todo / dangling in_progress), SDD approval gate, dependency gate
 * (worktree mode), and git branch strategy (worktree / current-branch), then
 * creates the runtime, registers the pending→intent link, and fires the
 * launcher. Returns a structured result — never throws for expected validation
 * failures.
 */
export async function launchWorkSession(
  workspacePath: string,
  intentId: string,
  deps: SessionLaunchDeps,
  progress?: (stage: string) => void,
  _actor?: string | null,
): Promise<SessionLaunchResult> {
  if (!isStoreAvailable()) return { success: false, code: 'intent.dbUnavailable' }

  if (!tryClaimDevLaunch(intentId)) {
    return { success: false, code: 'intent.devStartInFlight' }
  }
  const releaseClaim = (): void => releaseDevLaunch(intentId)

  const req = getIntent(intentId)
  if (!req) {
    releaseClaim()
    return { success: false, code: 'intent.notFound' }
  }

  // Status gate: allow `todo`, or `in_progress` whose work session has gone missing.
  const dangling =
    req.status === 'in_progress' &&
    (!req.lastWorkSessionId || !(await sessionExists(workspacePath, req.lastWorkSessionId)))
  if (req.status !== 'todo' && !dangling) {
    releaseClaim()
    return { success: false, code: 'intent.cannotStartDev', params: { status: req.status } }
  }

  // SDD quality gate — server-side, forced.
  if (getSddEnabled(workspacePath) && !req.specApproved) {
    releaseClaim()
    return { success: false, code: 'intent.specNotApproved' }
  }

  // Dependency gate (worktree mode only)
  if (req.dependsOn.length > 0 && getGitBranchMode(workspacePath) === 'worktree') {
    const unmerged = findDependencyBlockingMainline(
      req.dependsOn,
      listIntents(workspacePath),
      getDefaultMainBranch(workspacePath),
    )
    if (unmerged) {
      syncUnconfirmedDependencyPrsInBackground({
        ctx: { broadcastIntents: deps.broadcastIntents },
        workspacePath,
        dependsOn: req.dependsOn,
      })
      releaseClaim()
      return {
        success: false,
        code: 'intent.dependencyNotMerged',
        params: { title: unmerged.title, id: unmerged.id },
      }
    }
  }

  // ── Git branch strategy ──
  let effectiveCwd: string
  progress?.('fetching-remote-main')

  if (getGitBranchMode(workspacePath) === 'worktree') {
    try {
      const baseBranch = getDefaultMainBranch(workspacePath)
      if (baseBranch?.trim()) fetchRemoteBase(workspacePath, baseBranch)
      progress?.('preparing-worktree')
      const wt = createWorktree(workspacePath, req.id, req.title, baseBranch)
      effectiveCwd = wt.worktreePath
      setBranchName(req.id, wt.branchName)
    } catch (err) {
      releaseClaim()
      return {
        success: false,
        code: 'intent.worktreeCreateFailed',
        params: { message: errMsg(err) },
      }
    }
  } else {
    progress?.('preparing-worktree')
    const pull = pullCurrentBranch(workspacePath)
    if (!pull.ok) {
      releaseClaim()
      return {
        success: false,
        code: 'intent.pullFailed',
        params: { message: pull.message ?? '' },
      }
    }
    effectiveCwd = workspacePath
    const branch = readBranch(workspacePath)
    if (branch) setBranchName(req.id, branch)
  }

  // ── Create dev session ──
  const devId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const devRt = ensureRuntime(devId, workspacePath, getDefaultMode(workspacePath), [], 'work')
  devRt.effectiveCwd = effectiveCwd
  const resolvedVendor = resolveSessionVendor(devId)
  if (resolvedVendor === 'codex') {
    try {
      upsertPendingRow({
        pendingId: devId,
        workspacePath,
        vendor: resolvedVendor,
        agentId: getDefaultAgentId(),
        title: req.title,
        ownerKind: 'intent',
        ownerId: req.id,
      })
    } catch (err) {
      console.warn(`[c3:intents] work session projection write failed: ${errMsg(err)}`)
    }
  }

  // Build dev prompt (split system / visible / prefix)
  const devParts = buildDevPrompt({
    title: req.title,
    content: req.content,
    dependsOn: req.dependsOn,
    devSkill: getDevSkill(workspacePath),
    sddEnabled: getSddEnabled(workspacePath),
    specPath: req.specPath,
  })

  // Register pending→intent link and fire launcher
  registerPendingDevLink(devId, req.id)
  progress?.('launching')

  try {
    void deps
      .launchRun(devRt, devParts.visible, undefined, {
        systemInstruction: devParts.systemInstruction,
        userTurnPrefix: devParts.userTurnPrefix,
      })
      .catch((err: unknown) => {
        clearPendingDevLink(devId)
        releaseClaim()
        progress?.('failed')
        console.warn(`[c3:intents] launchWorkSession async fail: ${errMsg(err)}`)
      })
  } catch (err) {
    clearPendingDevLink(devId)
    releaseClaim()
    console.warn(`[c3:intents] launchWorkSession sync fail: ${errMsg(err)}`)
  }

  return { success: true, sessionId: devId }
}

// ── Spec session launcher ──

/**
 * Launch a spec-authoring session for an intent. Two sub-paths:
 *   1. **First-time** (no `specSessionId` yet) — scaffold the dated spec
 *      directory, seed spec.md, backfill `specPath`, and launch a new spec
 *      session with a first-time prompt.
 *   2. **Resume** (existing `specSessionId`) — validate the session is not
 *      already running, restore the runtime if it was dropped, and re-launch
 *      with a continuation prompt. Returns the existing session id.
 *
 * Both paths run the dependency gate first.
 */
export async function launchSpecSession(
  workspacePath: string,
  intentId: string,
  deps: SessionLaunchDeps,
  progress?: (stage: string) => void,
  actor?: string | null,
): Promise<SessionLaunchResult> {
  if (!isStoreAvailable()) return { success: false, code: 'intent.dbUnavailable' }

  const intent = getIntent(intentId)
  if (!intent) return { success: false, code: 'intent.notFound' }

  // If a spec session already exists → resume it
  if (intent.specSessionId) {
    return resumeSpecSession(workspacePath, intent, deps, progress, actor)
  }

  // First-time: scaffold and launch new session
  return createFirstSpecSession(workspacePath, intent, deps, progress, actor)
}

/**
 * Internal: prepare spec dependency context — dependency gate (worktree mode)
 * + pull current branch. Returns an error result on block, or `{ ok: true }`
 * to proceed. Sync (no I/O beyond the store read for dependencies).
 */
function prepareSpecDependencyContext2(
  workspacePath: string,
  intent: Intent,
  broadcastIntents: (path: string) => void,
  progress?: (stage: string) => void,
): SessionLaunchResult {
  if (getGitBranchMode(workspacePath) === 'worktree') {
    const blocking = findDependencyBlockingMainline(
      intent.dependsOn,
      listIntents(workspacePath),
      getDefaultMainBranch(workspacePath),
    )
    if (blocking) {
      syncUnconfirmedDependencyPrsInBackground({
        ctx: { broadcastIntents },
        workspacePath,
        dependsOn: intent.dependsOn,
      })
      return {
        success: false,
        code: 'intent.dependencyNotMerged',
        params: { title: blocking.title, id: blocking.id },
      }
    }
  }
  progress?.('pulling-code')
  const pull = pullCurrentBranch(workspacePath)
  if (!pull.ok) {
    console.warn(`[c3:intents] spec session pull failed; continuing: ${pull.message ?? 'unknown'}`)
  }
  progress?.('launching')
  return { success: true, sessionId: '' }
}

/** Internal: create a FIRST spec session — scaffold the dated directory, write
 * the seed file, backfill specPath, log, broadcast, then launch the spec agent
 * with a first-time prompt. Sync (fire-and-forget launch).
 */
function createFirstSpecSession(
  workspacePath: string,
  intent: Intent,
  deps: SessionLaunchDeps,
  progress?: (stage: string) => void,
  actor?: string | null,
): SessionLaunchResult {
  const depCheck = prepareSpecDependencyContext2(
    workspacePath,
    intent,
    deps.broadcastIntents,
    progress,
  )
  if (!depCheck.success) return depCheck

  // Compute dated spec layout
  const specRoot = getSpecsBase(workspacePath)
  const layout = computeSpecLayout({
    specRoot,
    shortEnTitle: intent.shortEnTitle,
    intentId: intent.id,
    now: new Date(),
    listDay: (dir) => {
      try {
        return readdirSync(dir)
      } catch {
        return []
      }
    },
  })

  // Scaffold directory + seed spec.md
  try {
    mkdirSync(layout.dirAbs, { recursive: true })
    writeFileSync(layout.fileAbs, buildSeedSpec(intent, new Date().toISOString()), 'utf8')
  } catch (err) {
    return { success: false, code: 'intent.specWriteFailed', params: { message: errMsg(err) } }
  }

  // Backfill spec_path immediately and broadcast
  setSpecPath(intent.id, layout.fileAbs)
  safeInsertIntentLog(intent.id, 'spec_created', '编写 spec', actor ?? 'system')
  deps.broadcastIntents(workspacePath)

  // Launch spec session
  const specId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const specAgent = resolveSpecAgent()
  const rt = ensureRuntime(specId, workspacePath, getDefaultMode(workspacePath), [], 'spec')
  rt.specDir = layout.dirAbs
  setSessionAgent(specId, specAgent.id)

  try {
    upsertPendingRow({
      pendingId: specId,
      workspacePath,
      vendor: specAgent.vendor,
      agentId: specAgent.id,
      title: intent.title,
      ownerKind: 'intent',
      ownerId: intent.id,
    })
  } catch (err) {
    console.warn(`[c3:intents] spec session projection write failed: ${errMsg(err)}`)
  }

  registerPendingSpecLink(specId, intent.id)

  try {
    void deps
      .launchRun(rt, buildSpecInstructPrompt(intent, layout.fileAbs, workspacePath))
      .catch((err: unknown) => {
        clearPendingSpecLink(specId)
        progress?.('failed')
        console.warn(`[c3:intents] launchSpecSession (first) async fail: ${errMsg(err)}`)
      })
  } catch (err) {
    clearPendingSpecLink(specId)
    console.warn(`[c3:intents] launchSpecSession (first) sync fail: ${errMsg(err)}`)
  }

  return { success: true, sessionId: specId }
}

/** Internal: RESUME an existing spec session. The intent already has
 * `specSessionId` set. Validates the session is not running, restores the
 * runtime if dropped, then re-launches with a continuation prompt. Returns the
 * existing session id (no new session created).
 */
async function resumeSpecSession(
  workspacePath: string,
  intent: Intent,
  deps: SessionLaunchDeps,
  progress?: (stage: string) => void,
  _actor?: string | null,
): Promise<SessionLaunchResult> {
  if (!intent.specSessionId) {
    return { success: false, code: 'intent.specNotWritten' }
  }

  // Gate: already running
  if (isRunning(intent.specSessionId)) {
    return { success: false, code: 'intent.specSessionRunning' }
  }

  if (!intent.specPath) {
    return { success: false, code: 'intent.specNotWritten' }
  }

  const depCheck = prepareSpecDependencyContext2(
    workspacePath,
    intent,
    deps.broadcastIntents,
    progress,
  )
  if (!depCheck.success) return depCheck

  // Restore runtime if it was dropped (server restart / GC)
  if (!getRuntime(intent.specSessionId)) {
    const isPending = intent.specSessionId.startsWith(PENDING_SESSION_PREFIX)
    const baseline = isPending
      ? []
      : await loadHistory(workspacePath, intent.specSessionId).catch(() => [])
    const restored = ensureRuntime(
      intent.specSessionId,
      workspacePath,
      getDefaultMode(workspacePath),
      baseline,
      'spec',
    )
    const fileAbs = resolveSpecFileAbs(workspacePath, intent.specPath)
    restored.specDir = dirname(fileAbs)
    const specAgent = resolveSpecAgent()
    setSessionAgent(intent.specSessionId, specAgent.id)
  }

  // Build continuation prompt pointing to existing specPath
  const fileAbs = resolveSpecFileAbs(workspacePath, intent.specPath)
  const prompt = buildContinueSpecPrompt(intent, fileAbs, workspacePath)

  // Re-launch — no new pending link needed (specSessionId is already set)
  try {
    void deps.launchRun(getRuntime(intent.specSessionId)!, prompt).catch((err: unknown) => {
      progress?.('failed')
      console.warn(`[c3:intents] launchSpecSession (resume) async fail: ${errMsg(err)}`)
    })
  } catch (err) {
    console.warn(`[c3:intents] launchSpecSession (resume) sync fail: ${errMsg(err)}`)
  }

  return { success: true, sessionId: intent.specSessionId }
}
