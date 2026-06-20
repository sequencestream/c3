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
 * Spec authoring is claude-only: the path-level write gate is a claude
 * `canUseTool` mechanism, so a non-claude spec agent is rejected up front (the
 * codex driver cannot path-confine writes).
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PENDING_SESSION_PREFIX, type Intent } from '@ccc/shared/protocol'
import { addViewer, ensureRuntime, removeViewer } from '../../runs.js'
import { pathToId, resolveWorkspaceRoot, touchWorkspace } from '../../state.js'
import { getDefaultMode, getSpecPath } from '../../kernel/config/index.js'
import {
  resolveSessionVendor,
  resolveSpecAgent,
  setSessionAgent,
} from '../../kernel/agent-config/index.js'
import type { Handler } from '../../transport/handler-registry.js'
import { getIntent, isStoreAvailable, setSpecApproved, setSpecPath } from './store.js'
import { computeSpecLayout } from './spec-path.js'
import { clearPendingSpecLink, registerPendingSpecLink } from './spec-link.js'

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The seed `spec.md` the server writes before launching the agent, so a spec
 * file (and the backfilled `spec_path`) exists even if the agent run errors
 * before producing output. The agent overwrites it with the real spec.
 */
export function buildSeedSpec(intent: Intent, nowIso: string): string {
  return `---
intent_id: ${intent.id}
title: ${intent.title}
status: draft
created: ${nowIso}
---

# Spec: ${intent.title}

> Generated from intent \`${intent.id}\`. This document is the single source of
> truth for this change. Describe WHAT and WHY — do not write implementation code.

## Intent

${intent.content}

## Scope

TODO

## Requirements

TODO

## Acceptance Criteria

TODO

## Out of Scope

TODO
`
}

/**
 * The per-run VISIBLE prompt that kicks off the spec session — intent body +
 * deliverable file only. The spec-authoring contract (Spec is Truth, the five-
 * dimension self-check, the write-confinement, ask-via-tool) is an internal system
 * instruction delivered via the spec agent's system prompt (`buildSpecAgentPrompt`),
 * not restated here, so it never renders as a visible user message
 * (hide-session-system-instructions).
 */
export function buildSpecInstructPrompt(intent: Intent, fileRel: string): string {
  return `Author the spec document for intent \`${intent.id}\`.

Intent title: ${intent.title}

Intent content:
${intent.content}

Read the relevant project material first, then write the spec to \`${fileRel}\` (overwrite the seeded template). When done, briefly summarise what you captured.`
}

/**
 * The per-run VISIBLE prompt that kicks off a RESET spec session — the user's new
 * steering input + intent title + the current spec content + the deliverable file.
 * All of these are visible business context / user input. The spec-authoring
 * contract rides the spec agent's system prompt (`buildSpecAgentPrompt`), not this
 * text (hide-session-system-instructions). Pure (no I/O) so the concatenation is
 * unit-testable.
 */
export function buildResetSpecPrompt(
  intent: Intent,
  fileRel: string,
  specContent: string,
  userInput: string,
): string {
  const steer = userInput.trim()
  const steerBlock = steer ? `New input from the user:\n${steer}\n\n` : ''
  return `Revise the spec document for intent \`${intent.id}\` based on fresh input.

${steerBlock}Intent title: ${intent.title}

Current spec content (\`${fileRel}\`):
${specContent}

Read the relevant project material first, then write the revised spec to \`${fileRel}\` (overwrite it). When done, briefly summarise what changed.`
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

  // Spec authoring is claude-only: the codex driver has no path-level write gate,
  // so it cannot confine writes to the spec directory. Reject up front rather
  // than author the spec without the write lock (C-SEC).
  const specAgent = resolveSpecAgent()
  if (specAgent.vendor === 'codex') {
    conn.send({ type: 'error', error: { code: 'intent.specAgentUnsupported' } })
    return
  }

  // Compute the dated layout and scaffold the directory + seed spec.md. The
  // directory must exist before the agent runs (its write lands inside it), and
  // a durable seed means spec_path is backfillable even if the launch fails.
  const layout = computeSpecLayout({
    workspacePath: proj,
    specPath: getSpecPath(proj),
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
  // even if the session below fails to launch.
  setSpecPath(intent.id, layout.fileRel)
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
      .launchRun(rt, buildSpecInstructPrompt(intent, layout.fileRel))
      .catch((err: unknown) => {
        clearPendingSpecLink(specId)
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
 * with the user's new input + the current spec content, replacing the prior
 * `spec_session_id` (re-linked on first bind). The escape hatch for a
 * context-rotted spec conversation: the old session stays queryable under Works
 * but is no longer the intent's linked spec session.
 *
 * Mirrors {@link writeSpecHandler} but reuses the EXISTING spec directory / path
 * (no scaffolding) and replies with a `session_selected` so the detail's `spec
 * session` tab switches to the new session immediately. Rejected when no spec was
 * ever written (`spec_path` null) — there is nothing to revise. Claude-only, same
 * as authoring (the codex driver cannot path-confine writes).
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
  if (specAgent.vendor === 'codex') {
    conn.send({ type: 'error', error: { code: 'intent.specAgentUnsupported' } })
    return
  }

  // Read the current spec content to seed the revision prompt. A read failure is
  // non-fatal: fall back to an empty body (the agent still has the new input).
  const fileAbs = join(proj, intent.specPath)
  let specContent = ''
  try {
    specContent = readFileSync(fileAbs, 'utf8')
  } catch (err) {
    console.warn(`[c3:intents] reset_spec_session spec read failed: ${errMsg(err)}`)
  }

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
      .launchRun(rt, buildResetSpecPrompt(intent, intent.specPath, specContent, msg.userInput))
      .catch((err: unknown) => {
        clearPendingSpecLink(specId)
        console.warn(`[c3:intents] reset_spec_session launch failed before bind: ${errMsg(err)}`)
      })
  } catch (err) {
    clearPendingSpecLink(specId)
    throw err
  }
}
