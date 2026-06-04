/**
 * The read-only research step run when a discussion is created. It reuses the
 * `discussion-research` gate (see `claude.ts`): the agent may read project material
 * (Read/Grep/Glob/…) and search the web (WebFetch/WebSearch) but cannot write, run
 * shells, or spawn sub-agents. There is no save tool — the server captures the
 * agent's final text and writes it back to the discussion's `researchResult` field
 * (the user's original `context` is left untouched).
 */
import type { Discussion, ResearchMessage } from '@ccc/shared/protocol'
import { getDiscussionType, type DiscussionTypeDef } from '@ccc/shared/discussion-types'
import { runClaude, REQUIREMENT_DISALLOWED_TOOLS } from '../claude.js'

/** System-prompt append that frames the unattended, read-only research run. */
export const DISCUSSION_RESEARCH_PROMPT = `你是讨论的「上下文研究员」。你的唯一任务:为一个即将开始的讨论补全背景资料(context)。
- 只读:可用 Read/Grep/Glob 阅读本项目材料,可用 WebSearch/WebFetch 联网检索补充背景;不要写文件、不要执行命令、不要提问。
- 围绕讨论的「类型 + 目标」收集真正相关的事实、现状、约束、未知点/待澄清项。
- 只描述现状:严禁提供任何可选方案、候选方案、解决思路、倾向性建议或结论;只客观陈述「当前项目情况」,把判断与发散留给讨论本身。
- 把用户给出的原始 context 视为线索,在其基础上核实与扩充,而非简单复述。
- 最终只输出补全后的 context 正文本身(结构化要点即可),不要寒暄、不要解释你做了什么。`

/**
 * Build the research agent's user prompt from the discussion's type/goal/context.
 * Pure (no I/O) so it can be unit tested. `def` defaults to the discussion's type
 * when omitted (kept as a param so tests don't depend on the catalog).
 */
export function buildResearchPrompt(
  input: { goal: string; context: string; projectPath: string },
  def: DiscussionTypeDef | undefined,
): string {
  const typeLine = def ? `讨论类型:${def.label} —— ${def.description}` : '讨论类型:(未指定)'
  const ctx = input.context.trim()
  return [
    typeLine,
    `讨论目标:${input.goal.trim() || '(未填写)'}`,
    `项目路径:${input.projectPath}`,
    ctx ? `用户提供的初始上下文:\n${ctx}` : '用户未提供初始上下文。',
    '',
    '请阅读项目相关材料并联网补充背景,产出补全后的 context 正文(只输出 context 本身)。',
  ].join('\n')
}

/**
 * Outcome of a research run. `ok` is `false` only when the agent run threw — the
 * caller uses it to gate auto-start (a failed research never auto-starts the
 * discussion; it stays a `draft` for a manual Start). `researchResult` is the
 * completed text on success, or `''` on empty output / failure — the user's
 * original `context` is never substituted in, so a research miss leaves
 * `researchResult` empty rather than echoing the user's input.
 */
export interface DiscussionResearchResult {
  ok: boolean
  researchResult: string
}

/** One streamed research item before the server stamps `discussionId`/`createdAt`. */
export type ResearchStreamItem = Pick<ResearchMessage, 'seq' | 'kind' | 'content'>

/** Options for {@link researchDiscussionContext}. `onMessage` streams the run's turns. */
export interface ResearchRunOptions {
  /**
   * Called for each observable research turn so the caller can broadcast it live:
   * an `assistant_text` turn (`kind: 'text'`) or a tool call (`kind: 'tool'`,
   * `content` is the tool name). `seq` is monotonic (1-based) within this run.
   */
  onMessage?: (item: ResearchStreamItem) => void
}

/**
 * Decide whether a discussion is eligible for auto-start after research completes.
 * Pure (no I/O) so it is unit-tested. Eligible only when the (re-fetched) record
 * still exists, is a `draft`, and has no live run — guarding against a discussion
 * that was manually Started or cancelled while research was in flight.
 */
export function canAutoStartDiscussion(
  discussion: Discussion | null | undefined,
  hasActiveRun: boolean,
): boolean {
  return !!discussion && discussion.status === 'draft' && !hasActiveRun
}

/**
 * Run the read-only research agent for a freshly-created discussion and resolve to
 * its completed `researchResult` plus an `ok` flag. Best-effort: on empty output
 * `researchResult` is `''`; `ok=false` only when the run threw, so a research miss
 * never blocks creation. The discussion's `context` is read as a clue but never
 * written back.
 */
export async function researchDiscussionContext(
  discussion: Discussion,
  opts: ResearchRunOptions = {},
): Promise<DiscussionResearchResult> {
  const def = getDiscussionType(discussion.type)
  const prompt = buildResearchPrompt(
    { goal: discussion.goal, context: discussion.context, projectPath: discussion.projectPath },
    def,
  )
  const abort = new AbortController()
  let captured = ''
  let seq = 0
  let ok = true
  try {
    await runClaude({
      prompt,
      cwd: discussion.projectPath,
      signal: abort.signal,
      // Pinned to `default` so the gateway's canUseTool always fires.
      permissionMode: 'default',
      appendSystemPrompt: DISCUSSION_RESEARCH_PROMPT,
      disallowedTools: REQUIREMENT_DISALLOWED_TOOLS,
      gate: 'discussion-research',
      send: (m) => {
        // The agent's last assistant turn is the completed context; every assistant
        // turn and tool call is also streamed out so the right pane shows the run
        // flowing live (best-effort — a streaming throw must not fail research).
        if (m.type === 'assistant_text') {
          captured = m.text
          opts.onMessage?.({ seq: ++seq, kind: 'text', content: m.text })
        } else if (m.type === 'tool_use') {
          opts.onMessage?.({ seq: ++seq, kind: 'tool', content: m.toolName })
        }
      },
    })
  } catch (err) {
    ok = false
    console.warn(
      `[c3] discussion research failed (${discussion.id}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  const out = captured.trim()
  return { ok, researchResult: out }
}
