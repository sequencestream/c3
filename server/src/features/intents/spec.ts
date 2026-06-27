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
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PENDING_SESSION_PREFIX, type Intent } from '@ccc/shared/protocol'
import { addViewer, ensureRuntime, removeViewer } from '../../runs.js'
import { pathToId, resolveWorkspaceRoot, touchWorkspace } from '../../state.js'
import {
  getDefaultMainBranch,
  getDefaultMode,
  getGitBranchMode,
} from '../../kernel/config/index.js'
import { isInside } from '../../kernel/permission/tools.js'
import {
  resolveSessionVendor,
  resolveSpecAgent,
  setSessionAgent,
} from '../../kernel/agent-config/index.js'
import type { Handler } from '../../transport/handler-registry.js'
import { getIntent, isStoreAvailable, listIntents, setSpecApproved, setSpecPath } from './store.js'
import { computeSpecLayout } from './spec-path.js'
import { getSpecsBase, resolveSpecFileAbs } from './specs-root.js'
import { clearPendingSpecLink, registerPendingSpecLink } from './spec-link.js'
import { findDependencyBlockingMainline } from './dependency-gate.js'
import { pullCurrentBranch } from './worktree.js'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function prepareSpecDependencyContext(
  proj: string,
  intent: Intent,
  conn: Parameters<Handler<'write_spec'>>[1],
): boolean {
  if (getGitBranchMode(proj) === 'worktree') {
    const blocking = findDependencyBlockingMainline(
      intent.dependsOn,
      listIntents(proj),
      getDefaultMainBranch(proj),
    )
    if (blocking) {
      conn.send({
        type: 'error',
        error: {
          code: 'intent.dependencyNotMerged',
          params: { title: blocking.title, id: blocking.id },
        },
      })
      return false
    }
  }
  conn.send({ type: 'spec_launch_progress', intentId: intent.id, stage: 'pulling-code' })
  const pull = pullCurrentBranch(proj)
  if (!pull.ok) {
    console.warn(`[c3:intents] spec session pull failed; continuing: ${pull.message ?? 'unknown'}`)
  }
  conn.send({ type: 'spec_launch_progress', intentId: intent.id, stage: 'launching' })
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
> Written for the user to review first and the development agent second. The intent already carries
> the requirements (Why / What / Acceptance / Non-goals); this spec explains only the grounded
> change, impact, and verification needed for this codebase.

_(to be authored)_
`
}

/**
 * The per-run VISIBLE prompt that kicks off the spec session — intent body +
 * deliverable file only. The spec-authoring contract (don't restate the intent,
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

export const writeSpecHandler: Handler<'write_spec'> = (ctx, conn, msg) => {
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

  const specAgent = resolveSpecAgent()
  if (!prepareSpecDependencyContext(proj, intent, conn)) return

  // Compute the dated layout under the FIXED centralized spec root and scaffold
  // the directory + seed spec.md. The directory must exist before the agent runs
  // (its write lands inside it), and a durable seed means spec_path is
  // backfillable even if the launch fails.
  const layout = computeSpecLayout({
    specRoot: getSpecsBase(proj),
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
  try {
    mkdirSync(layout.dirAbs, { recursive: true })
    writeFileSync(layout.fileAbs, buildSeedSpec(intent, new Date().toISOString()), 'utf8')
  } catch (err) {
    conn.send({
      type: 'error',
      error: { code: 'intent.specWriteFailed', params: { message: errMsg(err) } },
    })
    return
  }

  // Backfill spec_path immediately and broadcast, so the ledger reflects the spec
  // even if the session below fails to launch. The stored path is ABSOLUTE (the
  // spec lives outside the workspace under the centralized root).
  setSpecPath(intent.id, layout.fileAbs)
  ctx.broadcastIntents(proj)

  // Launch the write-confined spec session: pin the spec agent, confine writes to
  // the spec dir, register the pending→real link for the spec_session_id backfill.
  const specId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const rt = ensureRuntime(specId, proj, getDefaultMode(proj), [], 'spec')
  rt.specDir = layout.dirAbs
  setSessionAgent(specId, specAgent.id)
  registerPendingSpecLink(specId, intent.id)
  try {
    void ctx
      .launchRun(rt, buildSpecInstructPrompt(intent, layout.fileAbs, proj))
      .catch((err: unknown) => {
        clearPendingSpecLink(specId)
        conn.send({ type: 'spec_launch_progress', intentId: intent.id, stage: 'failed' })
        console.warn(`[c3:intents] write_spec launch failed before bind: ${errMsg(err)}`)
      })
  } catch (err) {
    clearPendingSpecLink(specId)
    throw err
  }
}

/**
 * `approve_spec` handler — the human approval checkpoint (the reason SDD exists):
 * development may only proceed once a person approves the authored spec. Sets
 * `spec_approved=true` and records the approving user (the current login subject)
 * in `spec_approve_user`, then broadcasts so every console reflects the approval.
 *
 * Single-person confirmation: no multi-sign and no un-approve in this phase. A
 * spec must exist first (`spec_path` non-null) — approving before authoring is
 * rejected (the UI never offers it, this is the defensive server guard).
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

  setSpecApproved(intent.id, true, conn.subject)
  ctx.broadcastIntents(proj)
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
  const specAgent = resolveSpecAgent()
  if (!prepareSpecDependencyContext(proj, intent, conn)) return

  // The reset prompt only references the spec PATH; the agent reads the file
  // itself, so the server no longer pre-reads it. We still resolve the absolute
  // path: `rt.specDir` and the path handed to the prompt both depend on it. The
  // stored spec path is absolute (centralized root); resolve robustly.
  const fileAbs = resolveSpecFileAbs(proj, intent.specPath)

  // Stop viewing whatever this connection had open, then start the fresh session.
  if (conn.viewing) removeViewer(conn.viewing, conn.deliver)
  const specId = `${PENDING_SESSION_PREFIX}${randomUUID()}`
  const rt = ensureRuntime(specId, proj, getDefaultMode(proj), [], 'spec')
  rt.specDir = dirname(fileAbs)
  setSessionAgent(specId, specAgent.id)
  registerPendingSpecLink(specId, intent.id)
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
      .launchRun(rt, buildResetSpecPrompt(intent, fileAbs, msg.userInput, proj))
      .catch((err: unknown) => {
        clearPendingSpecLink(specId)
        conn.send({ type: 'spec_launch_progress', intentId: intent.id, stage: 'failed' })
        console.warn(`[c3:intents] reset_spec_session launch failed before bind: ${errMsg(err)}`)
      })
  } catch (err) {
    clearPendingSpecLink(specId)
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
