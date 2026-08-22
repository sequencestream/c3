/**
 * The interactive comm-agent's `save_intents` handler.
 *
 * The human authorization for an interactive save is the user's explicit
 * confirmation IN THE CONVERSATION: the comm agent lists every proposed intent in
 * full and waits for a textual go-ahead before it calls the tool. The handler
 * therefore persists straight away — no `permission_request` frame, no
 * `waitForDecision`, no wait-user-involve event. What stays here is what the wire
 * cannot supply: the current-intent batch constraint, the single-intent comm
 * back-link normalization, and the store's own atomic validation.
 *
 * Pure + dependency-injected (broadcast), so it is unit-testable without the wire,
 * and so this feature module never imports the transport layer (no
 * `transport ↔ features` cycle — the composition root passes the binding in by
 * structure).
 *
 * The automation-only `save_intent_directly` stays separate: an unattended run has
 * no conversation partner to confirm with, so it lands `draft` rows for review in
 * the intent list instead.
 */
import { runSaveConfirmed, type IntentToolResult, type SaveArgs } from './tool-defs.js'
import { findIntentIdByAnySessionId } from './store.js'
import { getRuntime } from '../../runs.js'

export interface CommSaveDeps {
  broadcastIntents: (workspacePath: string) => void
}

/** Per-run binding (structurally the transport's `IntentMcpBinding`, imported by value). */
export interface CommSaveBinding {
  workspacePath: string
  getRunId: () => string
}

/** Persist a batch confirmed by the user in the conversation. */
export function runCommSave(
  deps: CommSaveDeps,
  binding: CommSaveBinding,
  args: SaveArgs,
): IntentToolResult {
  const runId = binding.getRunId()
  const ownerIntentId = findIntentIdByAnySessionId(runId)
  if (ownerIntentId) {
    const occurrences = args.intents.filter((intent) => intent.id === ownerIntentId).length
    if (occurrences !== 1) {
      return {
        content: [
          { type: 'text', text: `保存被拒绝:批次必须恰好一次包含当前意图 id="${ownerIntentId}"。` },
        ],
        isError: true,
      }
    }
  }
  // No permission decision means no approving subject: `intent_logs.actor` falls
  // back to `'system'` in the store.
  const initiatedBySubject = getRuntime(runId)?.initiatedBySubject ?? null
  return runSaveConfirmed(
    binding.workspacePath,
    normalizeSessionBackLink(args, runId),
    deps.broadcastIntents,
    undefined,
    initiatedBySubject,
  )
}

/**
 * Single-intent comm back-link normalization.
 *
 * The comm agent's prompt injects THIS run's session id (a `pending:…` id at
 * prompt-build time, before the SDK binds) for the model to echo back into
 * `intentSessionId`. By save time the run is bound, so `runId` is the real
 * comm-session id — the same id the chat row was re-keyed to and that
 * `open_intent_session` resolves against. We therefore overwrite the model-supplied
 * value with `runId` so the persisted back-link is always resolvable (the value
 * is server-authoritative; the model only decides WHETHER to set it, and only on
 * a single-intent batch). A multi-item batch is left untouched — the store
 * ignores the field there anyway.
 */
function normalizeSessionBackLink(args: SaveArgs, runId: string): SaveArgs {
  if (args.intents.length !== 1 || args.intents[0].intentSessionId === undefined) return args
  return { intents: [{ ...args.intents[0], intentSessionId: runId }] }
}
