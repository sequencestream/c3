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

function buildPrompt(req: Requirement, lastMessage: string, diffStat: string): string {
  return [
    '你是一个严格的开发完成度评审员。下面是一个需求、负责开发它的 agent 在本轮最后输出的消息、以及当前工作区相对 HEAD 的 git diff 统计。',
    '请判断该需求是否「真实完成」。',
    '',
    `# 需求标题\n${req.title}`,
    `# 需求内容\n${req.content}`,
    '',
    '# agent 最后的消息',
    lastMessage || '(无文本输出)',
    '',
    '# git diff --stat (相对 HEAD)',
    diffStat || '(无改动)',
    '',
    '# 判定规则',
    '- done: agent 明确说明功能已实现且已自验证(测试/运行)通过,且 diff 中有与需求相符的实际改动。',
    '- in_progress: agent 停在检查点等待批准/确认、表示还有后续步骤、或在征求可以用「继续」回答的许可。',
    '- stuck: agent 报错、放弃、反复失败,或在询问一个无法自动回答、必须人工决策的问题;或声称完成但 diff 无相符改动。',
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
  return { verdict: 'stuck', reason: `无法解析判定结果: ${text.slice(0, 120)}` }
}

export async function judgeCompletion(input: {
  req: Requirement
  lastMessage: string
  diffStat: string
  cwd: string
  signal: AbortSignal
}): Promise<JudgeVerdict> {
  const launch = resolveSessionLaunch(null)
  const text = await askOneShot({
    prompt: buildPrompt(input.req, input.lastMessage, input.diffStat),
    cwd: input.cwd,
    signal: input.signal,
    model: launch.model,
    envOverrides: launch.envOverrides,
  })
  return parseVerdict(text)
}
