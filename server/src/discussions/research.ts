/**
 * The read-only research step run when a discussion is created. It reuses the
 * `discussion-research` gate (see `claude.ts`): the agent may read project material
 * (Read/Grep/Glob/…) and search the web (WebFetch/WebSearch) but cannot write, run
 * shells, or spawn sub-agents. There is no save tool — the server captures the
 * agent's final text and writes it back as the discussion's completed `context`.
 */
import type { Discussion } from '@ccc/shared/protocol'
import { getDiscussionType, type DiscussionTypeDef } from '@ccc/shared/discussion-types'
import { runClaude, REQUIREMENT_DISALLOWED_TOOLS } from '../claude.js'

/** System-prompt append that frames the unattended, read-only research run. */
export const DISCUSSION_RESEARCH_PROMPT = `你是讨论的「上下文研究员」。你的唯一任务:为一个即将开始的讨论补全背景资料(context)。
- 只读:可用 Read/Grep/Glob 阅读本项目材料,可用 WebSearch/WebFetch 联网检索补充背景;不要写文件、不要执行命令、不要提问。
- 围绕讨论的「类型 + 目标」收集真正相关的事实、现状、约束、已知方案与未知点。
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
 * Run the read-only research agent for a freshly-created discussion and resolve to
 * its completed `context`. Best-effort: on any failure (or empty output) resolves to
 * the discussion's existing context, so a research miss never blocks creation.
 */
export async function researchDiscussionContext(discussion: Discussion): Promise<string> {
  const def = getDiscussionType(discussion.type)
  const prompt = buildResearchPrompt(
    { goal: discussion.goal, context: discussion.context, projectPath: discussion.projectPath },
    def,
  )
  const abort = new AbortController()
  let captured = ''
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
        // The agent's last assistant turn is the completed context.
        if (m.type === 'assistant_text') captured = m.text
      },
    })
  } catch (err) {
    console.warn(
      `[c3] discussion research failed (${discussion.id}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  const out = captured.trim()
  return out || discussion.context
}
