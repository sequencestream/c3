/**
 * Intent run-state reconciler — the "open_intent_chat" entry point
 * passes every `in_progress` intent through this to reconcile the derived
 * {@link IntentRunStatus} against the live process table.
 *
 * For each in_progress intent:
 * 1. If `lastDevSessionId` points to a STILL-RUNNING process → `running`.
 * 2. Otherwise (process dead — server restart, crash, or normal exit) →
 *    load the session transcript's **last 3 assistant messages**, run the
 *    completion judge (`done`/`in_progress`/`stuck`):
 *    - `done` → commit & push, update status to `done` (auto-complete — the
 *      explicit reconcile exception to RM-R9, unified for manual & automation).
 *    - `in_progress` / `stuck` → mark `dangling` (keep `in_progress` status).
 *
 * Pure + dependency-injected for testability: all side-effect access (runtime
 * registry, disk transcripts, AI judge, git, store) flows through the injected
 * {@link ReconcileDeps} object.
 */
import type { Intent, IntentRunStatus, IntentStatus } from '@ccc/shared/protocol'
import type { JudgeEvidence, JudgeVerdict } from './judge.js'

export interface ReconcileDeps {
  /** Whether a session currently has a turn executing in the background. */
  isRunning: (sessionId: string) => boolean
  /**
   * Load the last N assistant messages from a session's on-disk transcript.
   * Returns an array of plain-text assistant replies, most-recent first.
   * `workspacePath` is the workspace path (needed to resolve the SDK session dir).
   */
  loadTranscriptMessages: (
    workspacePath: string,
    sessionId: string,
    count: number,
  ) => Promise<string[]>
  /** The completion judge (tool-less one-shot Claude). */
  judgeCompletion: (input: {
    req: Intent
    lastMessages: string[]
    evidence: JudgeEvidence
    cwd: string
    signal: AbortSignal
  }) => Promise<JudgeVerdict>
  /** Commit uncommitted changes + push (or just push if tree is already clean). */
  commitAndPush: (
    workspacePath: string,
    message: string,
  ) => Promise<{ ok: boolean; committed: boolean; error?: string }>
  /** Persist a intent's status + broadcast the new list. */
  updateStatus: (id: string, status: IntentStatus) => void
}

/** One intent's reconcile outcome. */
export interface ReconcileItem {
  intentId: string
  runStatus: IntentRunStatus
  /** `true` when the judge returned `done` and the intent was auto-completed. */
  autoCompleted: boolean
}

/**
 * Reconcile all `in_progress` intents. The caller provides the pre-filtered
 * list of in_progress intents; this function returns the derived run-status
 * for each (and auto-completes those the judge confirms done).
 */
export async function reconcileInProgress(
  inProgressReqs: Intent[],
  workspacePath: string,
  deps: ReconcileDeps,
  signal: AbortSignal,
): Promise<ReconcileItem[]> {
  if (inProgressReqs.length === 0) return []

  const results: ReconcileItem[] = []

  for (const req of inProgressReqs) {
    // Branch 1: process still running → tracking.
    if (req.lastDevSessionId && deps.isRunning(req.lastDevSessionId)) {
      results.push({ intentId: req.id, runStatus: 'running', autoCompleted: false })
      continue
    }

    // Branch 2: process is dead (or never had a dev session).
    // Try to load the last 3 assistant messages from the session transcript.
    let runStatus: IntentRunStatus = 'dangling'
    let autoCompleted = false

    if (req.lastDevSessionId) {
      try {
        const messages = await deps.loadTranscriptMessages(workspacePath, req.lastDevSessionId, 3)
        // Judge with only the assistant messages (no git evidence — the process
        // is already dead and the working tree may be in any state; the judge
        // will decide from the messages alone).
        const verdict = await deps.judgeCompletion({
          req,
          lastMessages: messages,
          evidence: { diffStat: '', recentLog: '' },
          cwd: workspacePath,
          signal,
        })

        if (verdict.verdict === 'done' && !signal.aborted) {
          // Auto-complete: commit & push, then mark done.
          const res = await deps.commitAndPush(workspacePath, `feat: ${req.title}`)
          if (res.ok) {
            deps.updateStatus(req.id, 'done')
            runStatus = 'idle'
            autoCompleted = true
            console.log(
              `[c3:reconcile]「${req.title}」进程已死, judge 判定完成 → auto done (已提交${res.committed ? '' : '(无变更)'}/已推送)`,
            )
          } else {
            // Commit/push failed — keep dangling (don't auto-complete).
            console.warn(
              `[c3:reconcile]「${req.title}」judge 判 done 但提交失败:${res.error ?? '?'} → 保持 dangling`,
            )
          }
        } else if (!signal.aborted) {
          console.log(
            `[c3:reconcile]「${req.title}」进程已死, judge 判定 ${verdict.verdict}: ${verdict.reason} → dangling`,
          )
        }
        // If signal was aborted, the loop breaks below; don't push results.
      } catch {
        // Loading transcript or judge threw → keep dangling (safe fallback).
        console.warn(`[c3:reconcile]「${req.title}」进程已死但判 judge 失败 → dangling`)
      }
    }

    results.push({ intentId: req.id, runStatus, autoCompleted })

    if (signal.aborted) break
  }

  return results
}
