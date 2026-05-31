/**
 * Completion judge for the automation orchestrator. After a dev run's turn ends
 * normally, the orchestrator can't trust "the turn finished" to mean "the
 * requirement is done" — `/sdd-lite` is checkpoint-driven, so a turn often ends
 * paused, not complete. This module asks a fresh, tool-less Claude
 * (see {@link askOneShot}) to judge the requirement against the agent's last
 * message AND code-change evidence — both the uncommitted `git diff` and recent
 * commits, since `/sdd-lite` may self-commit (clean tree) — returning one of:
 *
 *  - `done`        — implemented and self-verified, with consistent change evidence.
 *  - `in_progress` — FALLBACK only: not done, with NO human-intervention reason — a
 *                    pure `/sdd-lite` checkpoint or more self-driven steps left, so
 *                    a blind "继续" can safely advance it.
 *  - `stuck`       — needs a human (asked the user / AskUserQuestion, awaiting a
 *                    permission, lacks context, errored, gave up), or claims done
 *                    with no consistent change evidence. The orchestrator STOPS.
 *
 * Priority of judgement (important): identify `stuck` FIRST (any human-intervention
 * signal wins), then `done` (real completion with evidence), and only otherwise
 * fall back to `in_progress`. `in_progress` is NOT a bias toward "继续" — it is the
 * residue after `stuck` and `done` are ruled out. This is what stops a genuine
 * human-decision point (an AskUserQuestion, an open question only the user can
 * answer) from being mis-read as in_progress and steamrolled by an automatic
 * "继续" that overrides the choice the user was supposed to make.
 *
 * Defence in depth: even if this judge mis-reads a turn that ended on an unanswered
 * AskUserQuestion as `in_progress`, the orchestrator's own `pendingQuestion` guard
 * (see automation.ts) forces a stop — the judge is the first line, not the only one.
 */
import type { Requirement } from '@ccc/shared/protocol'
import { askOneShot } from '../claude.js'
import { resolveSessionLaunch } from '../settings.js'

export type JudgeVerdict = { verdict: 'done' | 'in_progress' | 'stuck'; reason: string }

export interface JudgeEvidence {
  /** Uncommitted working-tree changes (`git diff HEAD --stat`); may be empty. */
  diffStat: string
  /** Recent commit subjects (`git log --oneline`); the agent may self-commit. */
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
    'Judge whether the requirement is TRULY complete.',
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
    '- Code-change evidence may appear in EITHER the uncommitted changes OR the recent commits — the agent often commits its own work, leaving the uncommitted diff empty. **If either source contains changes consistent with the requirement, treat that as real changes**; do NOT judge it incomplete merely because the uncommitted diff is empty.',
    '- **stuck — check FIRST. The turn ended needing a HUMAN, so this requirement must STOP, not auto-continue.** Return stuck if ANY of these hold: the agent is asking the user a question / presenting options / seeking a preference, direction, scope, or trade-off decision (this includes any use of the **AskUserQuestion** tool — a real decision point a blind "继续" would wrongly answer); it is waiting on a permission / tool authorization no one can grant; it is blocked for lack of context or information only a human can supply; it errored, gave up, or repeatedly failed; OR it claims completion but there is no consistent code-change evidence at all. A genuine human-decision point is stuck, NOT in_progress.',
    "- **done — only if not stuck.** The agent states the feature is implemented (ideally self-verified) AND the change evidence (the diff or a recent commit) is consistent with the requirement. Real evidence is required — do NOT return done on the agent's word alone when no consistent change evidence exists (that case is stuck).",
    '- **in_progress — FALLBACK only, when it is neither stuck nor done.** The agent paused at a pure `/sdd-lite` checkpoint that a plain "继续" can advance (no human choice needed), or it explicitly says there are remaining steps it will carry out itself. This is NOT a default-to-continue: if there is any human-intervention signal above, it is stuck, not in_progress.',
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
