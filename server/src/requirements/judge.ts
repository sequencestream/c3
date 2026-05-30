/**
 * Completion judge for the automation orchestrator. After a dev run's turn ends
 * normally, the orchestrator can't trust "the turn finished" to mean "the
 * requirement is done" — `/sdd-lite` is checkpoint-driven, so a turn often ends
 * paused for approval, not complete. This module asks a fresh, tool-less Claude
 * (see {@link askOneShot}) to judge the requirement against the agent's last
 * message AND the working-tree diff (objective evidence), returning one of:
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
    '你是一个开发完成度评审员。下面是一个需求、负责开发它的 agent 在本轮最后输出的消息,以及代码改动证据(未提交的 git diff 统计 + 最近的提交记录)。',
    '请判断该需求是否「真实完成」。',
    '',
    `# 需求标题\n${req.title}`,
    `# 需求内容\n${req.content}`,
    '',
    '# agent 最后的消息',
    lastMessage || '(无文本输出)',
    '',
    '# 未提交改动 git diff --stat (相对 HEAD)',
    ev.diffStat || '(无未提交改动)',
    '',
    '# 最近提交 git log --oneline',
    ev.recentLog || '(无提交记录)',
    '',
    '# 判定规则(重要)',
    '- 代码改动证据可能出现在「未提交改动」或「最近提交」任一处——agent 经常会自己 commit,导致未提交改动为空。**只要任一处存在与需求相符的改动,即视为有实际改动**,不要因为未提交改动为空就判定未完成。',
    '- done: agent 表示功能已实现(并尽量自验证),且改动证据(diff 或最近提交之一)与需求相符。判定倾向:当 agent 明确表示已完成、且证据不矛盾时,判 done。',
    '- in_progress: agent 停在检查点等待批准/确认、明确表示还有后续步骤未做、或在征求一个可以用「继续」回答的许可。',
    '- stuck: agent 报错/放弃/反复失败,或在询问一个无法自动回答、必须人工决策的问题;或声称完成但完全没有任何相符的代码改动证据。',
    '',
    '只输出一个 JSON 对象,不要解释,不要代码块包裹,格式严格为:',
    '{"verdict":"done|in_progress|stuck","reason":"一句话中文说明"}',
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
