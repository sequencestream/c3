/**
 * Completion judge for the automation orchestrator. After a dev run's turn ends
 * normally, the orchestrator can't trust "the turn finished" to mean "the
 * requirement is done" — `/sdd-lite` is checkpoint-driven, so a turn often ends
 * paused for approval, not complete. This module asks a fresh, tool-less Claude
 * (see {@link askOneShot}) to judge the requirement against the agent's last
 * message AND code-change evidence — both the uncommitted `git diff` and recent
 * commits, since `/sdd-lite` may self-commit (clean tree) — returning one of:
 *
 *  - `done`        — implemented and self-verified; commit & move on.
 *  - `in_progress` — paused at a checkpoint / awaiting "继续" / more steps to go.
 *  - `stuck`       — errored, gave up, or needs a human decision it can't make.
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

function buildPrompt(req: Requirement, lastMessage: string, ev: JudgeEvidence): string {
  return [
    'You are a development-completion reviewer. Below are a requirement, the last message the agent developing it produced this turn, and code-change evidence (the uncommitted git diff stat + recent commit log).',
    'Judge whether the requirement is TRULY complete.',
    '',
    `# Requirement title\n${req.title}`,
    `# Requirement content\n${req.content}`,
    '',
    "# Agent's last message",
    lastMessage || '(no text output)',
    '',
    '# Uncommitted changes — git diff --stat (vs HEAD)',
    ev.diffStat || '(no uncommitted changes)',
    '',
    '# Recent commits — git log --oneline',
    ev.recentLog || '(no commits)',
    '',
    '# Verdict rules (important)',
    '- Code-change evidence may appear in EITHER the uncommitted changes OR the recent commits — the agent often commits its own work, leaving the uncommitted diff empty. **If either source contains changes consistent with the requirement, treat that as real changes**; do NOT judge it incomplete merely because the uncommitted diff is empty.',
    '- done: the agent states the feature is implemented (and ideally self-verified), and the change evidence (the diff or a recent commit) is consistent with the requirement. Bias: when the agent clearly says it is complete and the evidence does not contradict it, return done.',
    '- in_progress: the agent paused at a checkpoint awaiting approval/confirmation, explicitly says there are remaining steps, or is asking for a permission that can be answered with "continue".',
    '- stuck: the agent errored / gave up / repeatedly failed, is asking a question that cannot be answered automatically and needs a human decision, or claims completion but there is no consistent code-change evidence at all.',
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
  lastMessage: string
  evidence: JudgeEvidence
  cwd: string
  signal: AbortSignal
}): Promise<JudgeVerdict> {
  const launch = resolveSessionLaunch(null)
  const text = await askOneShot({
    prompt: buildPrompt(input.req, input.lastMessage, input.evidence),
    cwd: input.cwd,
    signal: input.signal,
    model: launch.model,
    envOverrides: launch.envOverrides,
  })
  const verdict = parseVerdict(text)
  console.log(`[c3:automation] judge「${input.req.title}」→ ${verdict.verdict}: ${verdict.reason}`)
  return verdict
}
