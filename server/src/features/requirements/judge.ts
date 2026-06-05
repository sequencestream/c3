/**
 * Completion judge for the automation orchestrator. After a dev run's turn ends
 * normally, the orchestrator can't trust "the turn finished" to mean "the
 * requirement is done" — the dev skill is often checkpoint-driven, so a turn often ends
 * paused, not complete. This module asks a fresh, tool-less Claude
 * (see {@link askOneShot}) to judge the requirement primarily against the agent's
 * last message (what it accomplished), with code-change evidence — the uncommitted
 * `git diff` and recent commits — as SUPPORTING corroboration, not a hard gate.
 * Committing/pushing is c3's own job AFTER a `done` verdict (RM-A5), so an absent
 * diff/log must not, by itself, veto completion. Returns one of:
 *
 *  - `done`        — the requirement is achieved per a credible agent report;
 *                    change evidence, when present, corroborates it.
 *  - `in_progress` — FALLBACK only: not done, with NO human-intervention reason — a
 *                    pure dev-skill checkpoint or more self-driven steps left, so
 *                    a blind continue can safely advance it.
 *  - `stuck`       — needs a human (asked the user / AskUserQuestion, awaiting a
 *                    permission, lacks context, errored, gave up), or claims done
 *                    while the report itself is untrustworthy / self-contradictory /
 *                    plainly spinning AND no change evidence backs it. The
 *                    orchestrator STOPS.
 *
 * Priority of judgement (important): identify `stuck` FIRST (any human-intervention
 * signal wins), then `done` (requirement achieved per a credible report), and only
 * otherwise fall back to `in_progress`. `in_progress` is NOT a bias toward continue —
 * it is the residue after `stuck` and `done` are ruled out. This is what stops a
 * genuine human-decision point (an AskUserQuestion, an open question only the user
 * can answer) from being mis-read as in_progress and steamrolled by an automatic
 * continue that overrides the choice the user was supposed to make. Empty evidence is
 * NOT itself a stuck signal — evidence starvation (e.g. changes in a sub-repo, or
 * work c3 will commit later) must never masquerade as "未真实完成".
 *
 * Defence in depth: even if this judge mis-reads a turn that ended on an unanswered
 * AskUserQuestion as `in_progress`, the orchestrator's own `pendingQuestion` guard
 * (see automation.ts) forces a stop — the judge is the first line, not the only one.
 */
import type { Requirement } from '@ccc/shared/protocol'
import { askOneShot } from '../../kernel/agent/index.js'
import { resolveSessionLaunch } from '../../kernel/agent-config/index.js'

export type JudgeVerdict = { verdict: 'done' | 'in_progress' | 'stuck'; reason: string }

export interface JudgeEvidence {
  /**
   * Uncommitted working-tree changes (`git diff HEAD --stat`), multi-repo aware;
   * SUPPORTING corroboration only, may be empty (e.g. the agent self-committed, or
   * the workspace is multi-repo). Emptiness is not, by itself, evidence of failure.
   */
  diffStat: string
  /** Recent commit subjects (`git log --oneline`, multi-repo aware); the agent may self-commit. */
  recentLog: string
}

function buildPrompt(req: Requirement, lastMessages: string[], ev: JudgeEvidence): string {
  // Render each message with a numbered divider; at least one message is always present.
  const messages = lastMessages.length
    ? lastMessages
        .map((m, i) => `# 消息 ${i + 1}（时间倒序:最旧在上）\n${m || '(无文本输出)'}`)
        .join('\n\n')
    : '(无文本输出)'
  return [
    'You are a development-completion reviewer. Below are a requirement, the last message the agent developing it produced this turn, and code-change evidence (the uncommitted git diff stat + recent commit log).',
    'Judge whether the requirement is TRULY complete, PRIMARILY from what the agent reports it accomplished. Code-change evidence is SUPPORTING corroboration, NOT a precondition.',
    '',
    `# Requirement title\n${req.title}`,
    `# Requirement content\n${req.content}`,
    '',
    "# Agent's last message(s)",
    messages,
    '',
    '# Uncommitted changes — git diff --stat (vs HEAD)',
    ev.diffStat || '(no uncommitted changes)',
    '',
    '# Recent commits — git log --oneline',
    ev.recentLog || '(no commits)',
    '',
    '# Verdict rules (decide in THIS order: stuck → done → in_progress)',
    "- Requirement achievement is JUDGED PRIMARILY FROM THE AGENT REPORT. Code-change evidence (uncommitted diff OR recent commits) is SUPPORTING corroboration only and is OFTEN LEGITIMATELY EMPTY — the agent may have committed its own work, the workspace may be multi-repo, or c3 will commit later (committing is c3's job AFTER this verdict). **NEVER judge incomplete merely because the evidence is empty.** When evidence IS present and consistent with the requirement, let it strengthen a `done`.",
    '- **stuck — check FIRST. The turn ended needing a HUMAN, so this requirement must STOP, not auto-continue.** Return stuck if ANY of these hold: the agent is asking the user a question / presenting options / seeking a preference, direction, scope, or trade-off decision (this includes any use of the **AskUserQuestion** tool — a real decision point a blind continue would wrongly answer); it is waiting on a permission / tool authorization no one can grant; it is blocked for lack of context or information only a human can supply; it errored, gave up, or repeatedly failed; OR it claims completion while the report ITSELF is untrustworthy — self-contradictory, vague hand-waving, or plainly spinning (no concrete work described) — AND no change evidence backs it. A genuine human-decision point is stuck, NOT in_progress. **Empty evidence alone is NOT a stuck signal — a credible, concrete completion report with no diff is `done`, not stuck.**',
    "- **done — only if not stuck.** The agent credibly reports the requirement is implemented (ideally self-verified) and what it describes is consistent with the requirement. This is the PRIMARY signal: a concrete, self-consistent completion report is enough for `done` even when the change evidence is empty (the work may be committed, in a sub-repo, or awaiting c3's commit). Present evidence corroborates but is not required; only an untrustworthy/spinning report with no evidence falls through to stuck.",
    '- **in_progress — FALLBACK only, when it is neither stuck nor done.** The agent paused at a pure dev-skill checkpoint that a plain continue can advance (no human choice needed), or it explicitly says there are remaining steps it will carry out itself. This is NOT a default-to-continue: if there is any human-intervention signal above, it is stuck, not in_progress.',
    '',
    'Output a single JSON object only — no explanation, not wrapped in a code block — strictly in the form:',
    '{"verdict":"done|in_progress|stuck","reason":"one-line explanation"}',
  ].join('\n')
}

/** Extract the first JSON object from text and coerce it to a verdict. */
function parseVerdict(text: string): JudgeVerdict {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(text.slice(start, end + 1)) as Partial<JudgeVerdict>
      if (obj.verdict === 'done' || obj.verdict === 'in_progress' || obj.verdict === 'stuck') {
        return { verdict: obj.verdict, reason: String(obj.reason ?? '').slice(0, 300) }
      }
    } catch {
      /* fall through to the stuck fallback */
    }
  }
  return { verdict: 'stuck', reason: `无法解析判定结果: ${text.slice(0, 120) || '(judge 无输出)'}` }
}

export async function judgeCompletion(input: {
  req: Requirement
  lastMessages: string[]
  evidence: JudgeEvidence
  cwd: string
  signal: AbortSignal
}): Promise<JudgeVerdict> {
  const launch = resolveSessionLaunch(null)
  const text = await askOneShot({
    prompt: buildPrompt(input.req, input.lastMessages, input.evidence),
    cwd: input.cwd,
    signal: input.signal,
    model: launch.model,
    envOverrides: launch.envOverrides,
  })
  const verdict = parseVerdict(text)
  console.log(`[c3:automation] judge「${input.req.title}」→ ${verdict.verdict}: ${verdict.reason}`)
  return verdict
}
