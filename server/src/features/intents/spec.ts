/**
 * `write_spec` handler — author a constrained, reviewable spec document for an
 * intent (the quality-gate output step).
 *
 * Flow: scaffold the dated spec directory, seed `spec.md`, backfill the intent's
 * `spec_path` immediately, then launch a write-confined spec session (kind
 * `'spec'`) on the configured spec agent. The session may write ONLY inside the
 * spec directory (path-level gate in `kernel/permission/gateway.ts`); the rest of
 * the project is read-only. The real spec session id is linked back onto the
 * intent (`spec_session_id`) by the resident `run:bound` subscription via
 * `./spec-link.ts`.
 *
 * Claude spec sessions are write-confined by the path-level `canUseTool` gate.
 * Codex spec sessions are write-confined by launch-time sandbox roots: cwd is the
 * centralized specs root and the project stays outside the writable set.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MACHINE_SPEC_APPROVER, PENDING_SESSION_PREFIX, type Intent } from '@ccc/shared/protocol'
import { addViewer, ensureRuntime, isRunning, removeViewer } from '../../runs.js'
import { pathToId, resolveWorkspaceRoot, touchWorkspace } from '../../state.js'
import { getDefaultMode } from '../../kernel/config/index.js'
import { isInside } from '../../kernel/permission/tools.js'
import { resolveSessionVendor, setSessionAgent } from '../../kernel/agent-config/index.js'
import { groupUnavailableError, sessionAgentTargetForRole } from '../sessions/agent-target.js'
import type { SpecLaunchStage } from '@ccc/shared/protocol'
import type { UiErrorCode } from '@ccc/shared/ui-codes.js'
import type { Handler } from '../../transport/handler-registry.js'
import type { KernelContext } from '../../kernel/types.js'
import { launchSpecSession } from './session-launcher.js'
import {
  approveSpecIfPending,
  clearSpecReviewMachineBlock,
  getIntent,
  isStoreAvailable,
  listIntentLogs,
  revokeSpecApproval,
  safeInsertIntentLog,
  setSpecApproved,
} from './store.js'
import { armSpecContentWatch } from './spec-content-watch.js'
import { readSpecFingerprint } from './spec-review.js'
import { getSpecsBase, resolveSpecFileAbs } from './specs-root.js'
import { clearPendingSpecLink, registerPendingSpecLink } from './spec-link.js'
import { dependencyGateRejection, prepareSpecLaunch } from './dependency-gate.js'
import { claimSpecOccupancy, releaseSpecOccupancy } from './spec-occupancy.js'
import { prepareIntentSessionWorktree, worktreeBaselineNotice } from './session-worktree.js'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * WS adapter over the shared {@link prepareSpecLaunch} gate: run the one spec
 * launch precondition, then translate its neutral outcome into this transport's
 * shapes — `spec_launch_progress` frames while it proceeds, and the verdict's own
 * dependency-gate error when it blocks. Returns whether the caller may continue.
 * The RULE and its explanation both live in `dependency-gate.ts`; only the
 * framing is here.
 */
function runSpecLaunchGate(
  proj: string,
  intent: Intent,
  ctx: Pick<KernelContext, 'broadcastIntents'>,
  conn: Parameters<Handler<'reset_spec_session'>>[1],
): boolean {
  const gate = prepareSpecLaunch({
    workspacePath: proj,
    intent,
    broadcastIntents: ctx.broadcastIntents,
    progress: (stage) => conn.send({ type: 'spec_launch_progress', intentId: intent.id, stage }),
  })
  if (gate.blocked) {
    conn.send({ type: 'error', error: dependencyGateRejection(gate.verdict) })
    return false
  }
  return true
}

/**
 * The seed `spec.md` the server writes before launching the agent, so a spec
 * file (and the backfilled `spec_path`) exists even if the agent run errors
 * before producing output. The agent overwrites it with the real spec.
 *
 * Deliberately MINIMAL — frontmatter + title + a link back to the originating
 * intent, no pre-baked section skeleton. The recommended spec structure lives in
 * the spec agent's system prompt (`buildSpecAgentPrompt`) so the agent can tailor
 * it to the change's size instead of forcing every intent into a fixed set of
 * empty headings (which only invited verbatim restatement of the intent).
 */
export function buildSeedSpec(intent: Intent, nowIso: string): string {
  return `---
intent_id: ${intent.id}
title: ${intent.title}
created: ${nowIso}
---

# Spec: ${intent.title}

> The single source of truth for this change, derived from intent \`${intent.id}\`.
> Written for the user to review first and the development agent second. It must be self-contained:
> the distilled motivation, change, boundaries and acceptance conditions of the intent, plus the
> codebase-grounded approach, impact and verification — reviewable without opening the intent.

_(to be authored)_
`
}

/**
 * The per-run VISIBLE prompt that kicks off the spec session — intent body +
 * deliverable file only. The spec-authoring contract (keep the spec self-contained,
 * ground the solution against the codebase, the self-check, the write-confinement,
 * ask-via-tool) is an internal system instruction delivered via the spec agent's
 * system prompt (`buildSpecAgentPrompt`),
 * not restated here, so it never renders as a visible user message
 * (hide-session-system-instructions).
 */
export function buildSpecInstructPrompt(
  intent: Intent,
  fileAbs: string,
  projectRoot?: string,
): string {
  const projectBlock = projectRoot ? `Project root: \`${projectRoot}\`\n\n` : ''
  return `Author the spec document for intent \`${intent.id}\`.

Intent title: ${intent.title}

Intent content:
${intent.content}

${projectBlock}
Read the relevant project material first, then overwrite \`${fileAbs}\` with the spec. When done, briefly summarise what you captured.`
}

/**
 * The per-run VISIBLE prompt that kicks off a RESET spec session — the user's new
 * steering input + intent title + a pointer to the current spec FILE PATH (not its
 * inlined body) + the deliverable file. The agent reads the spec itself off the
 * path; keeping the prompt to a reference avoids bloating it with the whole spec.
 * All of these are visible business context / user input. The spec-authoring
 * contract rides the spec agent's system prompt (`buildSpecAgentPrompt`), not this
 * text (hide-session-system-instructions). Pure (no I/O) so the concatenation is
 * unit-testable.
 */
export function buildResetSpecPrompt(
  intent: Intent,
  fileAbs: string,
  userInput: string,
  projectRoot?: string,
): string {
  const steer = userInput.trim()
  const steerBlock = steer ? `New input from the user:\n${steer}\n\n` : ''
  const projectBlock = projectRoot ? `Project root: \`${projectRoot}\`\n\n` : ''
  return `Revise the spec document for intent \`${intent.id}\` based on fresh input.

${steerBlock}Intent title: ${intent.title}

${projectBlock}
The current spec lives at \`${fileAbs}\`. Read it first to see what already exists, then overwrite the same file with the revised spec. When done, briefly summarise what changed.`
}

/**
 * The per-run VISIBLE prompt that continues an EXISTING spec session — no
 * scaffold, no reset, just a pointer to the existing spec file and a
 * "continue working" instruction. Pure (no I/O) so the concatenation is
 * unit-testable.
 */
export function buildContinueSpecPrompt(
  intent: Intent,
  fileAbs: string,
  projectRoot?: string,
): string {
  const projectBlock = projectRoot ? `Project root: \`${projectRoot}\`\n\n` : ''
  return `Continue working on the spec document for intent \`${intent.id}\`.

Intent title: ${intent.title}

${projectBlock}
The current spec lives at \`${fileAbs}\`. Read it first to review what has already been authored, then continue working on the same file. When done, briefly summarise what you changed.`
}

export const writeSpecHandler: Handler<'write_spec'> = async (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  const result = await launchSpecSession(
    proj,
    msg.intentId,
    { launchRun: ctx.launchRun, broadcastIntents: ctx.broadcastIntents },
    (stage) =>
      conn.send({
        type: 'spec_launch_progress',
        intentId: msg.intentId,
        stage: stage as SpecLaunchStage,
      }),
    conn.subject,
  )
  if (!result.success) {
    conn.send({
      type: 'error',
      error: {
        code: result.code as UiErrorCode,
        ...(result.params ? { params: result.params } : {}),
      },
    })
    return
  }
  // Started, just not on the newest baseline — a notice, never a refusal.
  if (result.baselineNotice) conn.send(result.baselineNotice)
}

/**
 * The ONE place a spec becomes approved — shared verbatim by the human
 * `approve_spec` handler and the queue's machine-approval action. Only the
 * calling identity differs: a login subject, or the reserved
 * {@link MACHINE_SPEC_APPROVER} constant. Neither surface may re-implement the
 * state update, or the two would drift on exactly the rules that matter (what
 * gets logged, what event fires, what the approver field says).
 *
 * A human approval also lifts any machine-approval veto: once a person has
 * approved this spec, the earlier revoke has been answered and must not keep
 * suppressing a later machine approval of freshly reviewed content.
 *
 * Returns `false` — logging nothing, publishing nothing — when the transactional
 * status guard refused the write: only a `pending` spec may be approved, so a
 * spec still being authored (`raw`) cannot be approved through either surface.
 */
export function applySpecApproval(input: {
  workspacePath: string
  intent: Intent
  approver: string
  broadcastIntents: (workspacePath: string) => void
  publishEvent: (payload: {
    workspacePath: string
    sessionId: string
    event: { type: string; metadata: Record<string, string> }
  }) => void
  /**
   * Set when the caller ALREADY wrote `spec_approved` under its own conditional
   * transaction (the queue's machine approval does, so the write and its guards
   * are atomic). This pass then only lands the audit log, the event and the
   * broadcast — re-writing the flag here would be harmless but would also make
   * the transactional guard look optional, which it is not.
   */
  alreadyPersisted?: boolean
}): boolean {
  const machine = input.approver === MACHINE_SPEC_APPROVER
  if (!input.alreadyPersisted && !approveSpecIfPending(input.intent.id, input.approver)) {
    return false
  }
  if (!machine) clearSpecReviewMachineBlock(input.intent.id)
  safeInsertIntentLog(
    input.intent.id,
    'spec_approved',
    machine ? '机器批准 spec(审核结论为通过)' : '批准 spec',
    input.approver,
  )
  input.broadcastIntents(input.workspacePath)
  // Publish a generic event so event-triggered automations can react to spec approval.
  input.publishEvent({
    workspacePath: input.workspacePath,
    sessionId: randomUUID(),
    event: {
      type: 'intent:spec_approve',
      metadata: {
        intentId: input.intent.id,
        title: input.intent.title ?? '',
        approver: machine ? 'machine' : 'human',
      },
    },
  })
  return true
}

/**
 * `approve_spec` handler — the human approval checkpoint (the reason SDD exists):
 * development may only proceed once a person approves the authored spec. Sets
 * `spec_status='approved'` (with the compat `spec_approved=true` in the same
 * transaction) and records the approving user (the current login subject)
 * in `spec_approve_user`, then broadcasts so every console reflects the approval.
 *
 * Single-person confirmation: no multi-sign. Revocable via `revoke_spec_approval`.
 * Only a `pending` spec may be approved — a document that is still nothing but
 * the server's seed (`raw`) is rejected even though it already has a `spec_path`,
 * and so is a second approval of an already-approved one. The UI never offers
 * either; this is the defensive server guard, enforced transactionally in the store.
 */
export const approveSpecHandler: Handler<'approve_spec'> = (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const intent = getIntent(msg.intentId)
  if (!intent) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
    return
  }
  if (!intent.specPath) {
    conn.send({ type: 'error', error: { code: 'intent.specNotWritten' } })
    return
  }

  const applied = applySpecApproval({
    workspacePath: proj,
    intent,
    approver: conn.subject ?? 'system',
    broadcastIntents: ctx.broadcastIntents,
    publishEvent: (payload) => ctx.eventBus.publish('event', payload),
  })
  // Refused by the status guard: the spec is still being authored (`raw`) or is
  // already approved. Reported as "not written" — from the human's side that is
  // exactly what a seeded-but-unauthored spec is.
  if (!applied) {
    conn.send({ type: 'error', error: { code: 'intent.specNotWritten' } })
  }
}

/**
 * `revoke_spec_approval` handler — the explicit undo for BOTH human and machine
 * approval. It clears `spec_approved` and the approver identity, appends a
 * `spec_unapproved` audit entry, and re-broadcasts, so the intent returns to
 * "awaiting approval".
 *
 * The revoke ALSO vetoes the review conclusion the approval rested on (inside
 * `revokeSpecApproval`'s transaction). Without that, a machine-approval workspace
 * would simply re-approve the same `pass` conclusion on the next 10s tick and the
 * revoke button would be theatre. Only a fresh valid conclusion — or a human
 * approval — lifts the veto.
 *
 * Development already in flight is NOT killed: a revoke governs admission from
 * here on. Revoking an intent that is not approved is rejected rather than
 * silently succeeding, so a double-click cannot manufacture a second audit row.
 */
export const revokeSpecApprovalHandler: Handler<'revoke_spec_approval'> = (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const intent = getIntent(msg.intentId)
  if (!intent) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
    return
  }
  if (!revokeSpecApproval(intent.id)) {
    conn.send({ type: 'error', error: { code: 'intent.specNotApproved' } })
    return
  }
  const wasMachine = intent.specApproveUser === MACHINE_SPEC_APPROVER
  safeInsertIntentLog(
    intent.id,
    'spec_unapproved',
    wasMachine ? '撤销机器批准的 spec' : '撤销 spec 批准',
    conn.subject ?? 'system',
  )
  ctx.broadcastIntents(proj)
  ctx.eventBus.publish('event', {
    workspacePath: proj,
    sessionId: randomUUID(),
    event: {
      type: 'intent:spec_unapprove',
      metadata: {
        intentId: intent.id,
        title: intent.title ?? '',
        revokedApprover: wasMachine ? 'machine' : 'human',
      },
    },
  })
  conn.send({ type: 'intent_logs_list', intentId: intent.id, items: listIntentLogs(intent.id) })
}

/**
 * `reset_spec_session` handler — start a FRESH write-confined spec session seeded
 * with the user's new input + a pointer to the current spec path (the agent reads
 * the file itself), replacing the prior `spec_session_id` (re-linked on first
 * bind). The escape hatch for a
 * context-rotted spec conversation: the old session stays queryable under Works
 * but is no longer the intent's linked spec session.
 *
 * Mirrors {@link writeSpecHandler} but reuses the EXISTING spec directory / path
 * (no scaffolding) and replies with a `session_selected` so the detail's `spec
 * session` tab switches to the new session immediately. Rejected when no spec was
 * ever written (`spec_path` null) — there is nothing to revise.
 */
export const resetSpecSessionHandler: Handler<'reset_spec_session'> = (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const intent = getIntent(msg.intentId)
  if (!intent) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
    return
  }
  if (!intent.specPath) {
    conn.send({ type: 'error', error: { code: 'intent.specNotWritten' } })
    return
  }
  // The spec role's agent (possibly a group), resolved before anything is created.
  const specTarget = sessionAgentTargetForRole('spec')
  if (!specTarget.ok) {
    conn.send({ type: 'error', error: groupUnavailableError(specTarget.groupRef) })
    return
  }
  if (!runSpecLaunchGate(proj, intent, ctx, conn)) return

  // Claim the authoring slot before creating the runtime: a manual reset and a
  // queue-driven authoring contend for the SAME occupancy, so only one wins.
  const specId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const claim = claimSpecOccupancy(intent.id, specId, {
    workspacePath: proj,
    vendor: specTarget.target.agent.vendor,
    agentId: specTarget.target.ref,
    title: intent.title,
  })
  if (!claim.ok) {
    conn.send({
      type: 'error',
      error: { code: claim.owner ? 'intent.specSessionRunning' : 'intent.dbUnavailable' },
    })
    return
  }
  const releaseClaim = (): void => releaseSpecOccupancy(intent.id, specId)

  // The intent's shared directory — the code this spec is authored against.
  const cwd = prepareIntentSessionWorktree(proj, intent)
  if (!cwd.ok) {
    releaseClaim()
    conn.send({
      type: 'error',
      error: cwd.failure.params
        ? { code: cwd.failure.code, params: cwd.failure.params }
        : { code: cwd.failure.code },
    })
    return
  }

  // The reset prompt only references the spec PATH; the agent reads the file
  // itself, so the server no longer pre-reads it. We still resolve the absolute
  // path: `rt.specDir` and the path handed to the prompt both depend on it. The
  // stored spec path is absolute (centralized root); resolve robustly.
  const fileAbs = resolveSpecFileAbs(proj, intent.specPath)
  // Baseline for the content check the run's settle performs: a reset session
  // that ends without rewriting the document changes no status.
  armSpecContentWatch({
    intentId: intent.id,
    workspacePath: proj,
    specPath: intent.specPath,
    fingerprint: readSpecFingerprint(proj, intent.specPath),
  })

  // Stop viewing whatever this connection had open, then start the fresh session.
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
  const rt = ensureRuntime(specId, proj, getDefaultMode(proj), [], 'spec')
  // Reads code from the intent worktree, writes only into `specDir` (the
  // centralized spec root) — two independent roots.
  rt.effectiveCwd = cwd.prepared.cwd
  rt.specDir = dirname(fileAbs)
  setSessionAgent(specId, specTarget.target.ref)
  registerPendingSpecLink(specId, intent.id)
  if (cwd.prepared.baselineDrift) {
    conn.send(worktreeBaselineNotice(intent.id, cwd.prepared.baselineDrift))
  }
  conn.viewing = specId
  touchWorkspace(proj, Date.now())
  addViewer(specId, conn.deliver)
  conn.send({
    type: 'session_selected',
    workspaceId: pathToId(proj)!,
    sessionId: specId,
    title: intent.title,
    mode: rt.mode,
    history: [],
    status: rt.status,
    vendor: resolveSessionVendor(specId),
  })
  try {
    void ctx
      .launchRun(rt, buildResetSpecPrompt(intent, fileAbs, msg.userInput, cwd.prepared.cwd))
      .catch((err: unknown) => {
        clearPendingSpecLink(specId)
        releaseClaim()
        conn.send({ type: 'spec_launch_progress', intentId: intent.id, stage: 'failed' })
        console.warn(`[c3:intents] reset_spec_session launch failed before bind: ${errMsg(err)}`)
      })
  } catch (err) {
    clearPendingSpecLink(specId)
    releaseClaim()
    throw err
  }
}

/**
 * `read_spec` handler — read an intent's authored spec for the detail's `spec`
 * tab. Specs live OUTSIDE the workspace under the centralized root, so the
 * workspace-confined `read_file` cannot reach them; this handler resolves the
 * intent's stored absolute `specPath` and confines the read to the centralized
 * specs root (fail-closed — a path outside that root, e.g. a legacy in-workspace
 * `.specs`, is rejected; no migration, see spec Out-of-Scope). Replies with a
 * `file_read` whose `file.path` echoes the absolute spec path the client awaits.
 */
export const readSpecHandler: Handler<'read_spec'> = (_ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const intent = getIntent(msg.intentId)
  if (!intent) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
    return
  }
  if (!intent.specPath) {
    conn.send({ type: 'error', error: { code: 'intent.specNotWritten' } })
    return
  }
  const fileAbs = resolveSpecFileAbs(proj, intent.specPath)
  // Fail-closed: only read inside the centralized specs root for this project.
  if (!isInside(getSpecsBase(proj), fileAbs)) {
    conn.send({
      type: 'error',
      error: { code: 'codes.readFailed', params: { path: intent.specPath } },
    })
    return
  }
  try {
    const content = readFileSync(fileAbs, 'utf8')
    const size = statSync(fileAbs).size
    conn.send({
      type: 'file_read',
      workspaceId: msg.workspaceId,
      file: { path: intent.specPath, size, binary: false, truncated: false, content },
    })
  } catch (err) {
    console.warn(`[c3:intents] read_spec read failed: ${errMsg(err)}`)
    conn.send({
      type: 'error',
      error: { code: 'codes.readFailed', params: { path: intent.specPath } },
    })
  }
}

/**
 * `update_spec_content` handler — the human inline spec-source edit (distinct from
 * the `write_spec` / `reset_spec_session` agent sessions). Overwrites the intent's
 * centralized spec file with the client-supplied Markdown, then reconciles approval
 * and logs. Three gates, ALL re-checked here so a bypassed client is rejected:
 *   1. a spec exists (`spec_path` non-null),
 *   2. development has not started (`status === 'todo' && lastWorkSessionId === null`),
 *   3. no spec session is running (`spec_session_id` not live).
 * The write is fail-closed to the centralized specs root (shared with
 * {@link readSpecHandler}). Order preserves atomic-feel: file overwrite is the
 * precondition for the approval reset + logs; a write failure leaves the intent
 * untouched. A successful write is authored content by definition, so the spec
 * status lands on `pending` whatever it was before — a human editing a seeded
 * (`raw`) spec has just written it. If the spec was approved, approval is revoked
 * (`setSpecApproved(false)`, clears the approver) with a `spec_unapproved` log;
 * every success also bumps
 * `updated_at` and appends a `spec_updated` log (no diff), then broadcasts intents
 * (the client re-reads the fresh spec via `read_spec`). A same-frame
 * `intent_logs_list` refresh keeps an already-open changelog tab current.
 */
export const updateSpecContentHandler: Handler<'update_spec_content'> = (ctx, conn, msg) => {
  const proj = resolveWorkspaceRoot(msg.workspaceId)
  if (!proj) {
    conn.send({
      type: 'error',
      error: { code: 'workspace.unknown', params: { workspaceId: msg.workspaceId } },
    })
    return
  }
  if (!isStoreAvailable()) {
    conn.send({ type: 'error', error: { code: 'intent.dbUnavailable' } })
    return
  }
  const intent = getIntent(msg.intentId)
  if (!intent) {
    conn.send({ type: 'error', error: { code: 'intent.notFound' } })
    return
  }
  if (!intent.specPath) {
    conn.send({ type: 'error', error: { code: 'intent.specNotWritten' } })
    return
  }
  // Gate: development must not have started (same rule the UI hides the entry on).
  if (intent.status !== 'todo' || intent.lastWorkSessionId) {
    conn.send({
      type: 'error',
      error: { code: 'intent.specEditForbidden', params: { status: intent.status } },
    })
    return
  }
  // Gate: a live spec session may be writing the same file — refuse to clobber it.
  if (intent.specSessionId && isRunning(intent.specSessionId)) {
    conn.send({ type: 'error', error: { code: 'intent.specSessionRunning' } })
    return
  }
  const fileAbs = resolveSpecFileAbs(proj, intent.specPath)
  // Fail-closed: only overwrite inside the centralized specs root for this project.
  if (!isInside(getSpecsBase(proj), fileAbs)) {
    conn.send({
      type: 'error',
      error: { code: 'codes.invalidPath', params: { path: intent.specPath } },
    })
    return
  }
  try {
    writeFileSync(fileAbs, msg.content, 'utf8')
  } catch (err) {
    conn.send({
      type: 'error',
      error: { code: 'intent.specWriteFailed', params: { message: errMsg(err) } },
    })
    return
  }

  // File written: now reconcile approval + logs (never before the write succeeds).
  // `setSpecApproved(false)` also bumps `updated_at`, giving the client a reliable
  // broadcast signal even when the spec was already unapproved.
  const wasApproved = intent.specStatus === 'approved'
  setSpecApproved(intent.id, false, null)
  if (wasApproved) {
    safeInsertIntentLog(intent.id, 'spec_unapproved', '直接编辑 spec 后撤销审批', conn.subject)
  }
  safeInsertIntentLog(intent.id, 'spec_updated', '直接编辑 spec 内容', conn.subject)
  ctx.broadcastIntents(proj)
  // Refresh the per-intent changelog cache for an already-open changelog tab.
  conn.send({ type: 'intent_logs_list', intentId: intent.id, items: listIntentLogs(intent.id) })
}
