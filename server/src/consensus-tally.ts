/**
 * Pure consensus helpers — vote parsing, tallying, prompt + summary building.
 *
 * Kept dependency-free (no SDK import) so the decision logic is unit-testable in
 * isolation, mirroring `permissions.ts`. The orchestration that actually spawns
 * advisor queries lives in `consensus.ts`.
 */

import type { AgentAnswer, ConsensusVote, QuestionConsensus } from '@ccc/shared/protocol'

/** The shape of one `AskUserQuestion` question (subset of the SDK input we use). */
export interface AskQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description?: string }[]
}

/** Extract the questions array from an `AskUserQuestion` tool input, or null. */
export function askQuestions(input: unknown): AskQuestion[] | null {
  const qs = (input as { questions?: unknown })?.questions
  if (!Array.isArray(qs) || qs.length === 0) return null
  const out: AskQuestion[] = []
  for (const q of qs) {
    const o = q as Partial<AskQuestion>
    if (typeof o.question !== 'string' || !Array.isArray(o.options)) return null
    out.push({
      question: o.question,
      header: typeof o.header === 'string' ? o.header : '',
      multiSelect: o.multiSelect === true,
      options: o.options.map((op) => ({
        label: String((op as { label?: unknown }).label ?? ''),
        description: (op as { description?: string }).description,
      })),
    })
  }
  return out
}

/** Collapse whitespace/newlines into a single line. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** Extract an allow/deny verdict from an advisor's free-form reply. */
export function parseVote(text: string): { decision: 'allow' | 'deny'; reason: string } | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as { decision?: unknown; reason?: unknown }
      const d = String(obj.decision ?? '').toLowerCase()
      if (d === 'allow' || d === 'deny') {
        return { decision: d, reason: typeof obj.reason === 'string' ? oneLine(obj.reason) : '' }
      }
    } catch {
      /* fall through to keyword scan */
    }
  }
  const low = text.toLowerCase()
  const allow = /\ballow\b/.test(low)
  const deny = /\bdeny\b/.test(low)
  if (allow && !deny) return { decision: 'allow', reason: oneLine(text).slice(0, 200) }
  if (deny && !allow) return { decision: 'deny', reason: oneLine(text).slice(0, 200) }
  return null
}

/** Whether all voters returned the same allow/deny verdict, and which. */
export function tally(votes: ConsensusVote[]): {
  unanimous: boolean
  decision: 'allow' | 'deny' | null
} {
  const decisions = votes.map((v) => v.decision)
  const allAllow = decisions.length > 0 && decisions.every((d) => d === 'allow')
  const allDeny = decisions.length > 0 && decisions.every((d) => d === 'deny')
  return {
    unanimous: allAllow || allDeny,
    decision: allAllow ? 'allow' : allDeny ? 'deny' : null,
  }
}

export function voterPrompt(toolName: string, input: unknown, context: string): string {
  return [
    'You are an advisor judging whether another AI agent should be permitted to run a tool.',
    '',
    'Recent conversation context:',
    context || '(none)',
    '',
    `The agent wants to use the tool "${toolName}" with this input:`,
    '```json',
    JSON.stringify(input, null, 2),
    '```',
    '',
    'Decide whether this action should be ALLOWED or DENIED.',
    'Reply with ONLY a single-line JSON object, no other text:',
    '{"decision":"allow"|"deny","reason":"<one short sentence>"}',
  ].join('\n')
}

// ---- AskUserQuestion: per-question answering instead of allow/deny ----

/** Build the advisor prompt that asks one agent to answer every question. */
export function askVoterPrompt(questions: AskQuestion[], context: string): string {
  const lines: string[] = [
    "You are an advisor answering, on the user's behalf, the questions another AI agent is asking.",
    '',
    'Recent conversation context:',
    context || '(none)',
    '',
    'Questions (answer EVERY one):',
  ]
  questions.forEach((q, i) => {
    lines.push(`[${i}] ${q.question}${q.multiSelect ? ' (multi-select)' : ''}`)
    q.options.forEach((o) =>
      lines.push(`    - ${o.label}${o.description ? `: ${o.description}` : ''}`),
    )
  })
  lines.push(
    '',
    'For each question, pick the option label(s) that best answer it. If no option fits, set',
    '"choice" to "custom" and put your answer in "custom". Match labels EXACTLY.',
    'Reply with ONLY a single-line JSON object, no other text:',
    '{"answers":[{"index":0,"choice":"<exact label>"|["<label>","<label>"]|"custom","custom":"<text or null>","reason":"<one short sentence>"}]}',
  )
  return lines.join('\n')
}

/**
 * Parse one advisor's reply into per-question answers, aligned to `questions`.
 * Labels are matched case-insensitively to the option set; unmatched/missing
 * questions are returned as `abstain` (ignored by the tally). Always returns one
 * entry per question.
 */
export function parseAskVote(
  text: string,
  questions: AskQuestion[],
  agentId: string,
  agentName: string,
): AgentAnswer[] {
  let parsed: { index?: unknown; choice?: unknown; custom?: unknown; reason?: unknown }[] = []
  const match = text.match(/\{[\s\S]*\}/)
  if (match) {
    try {
      const obj = JSON.parse(match[0]) as { answers?: unknown }
      if (Array.isArray(obj.answers)) parsed = obj.answers as typeof parsed
    } catch {
      /* leave parsed empty ⇒ all abstain */
    }
  }
  const byIndex = new Map<number, (typeof parsed)[number]>()
  parsed.forEach((a) => {
    const idx = typeof a.index === 'number' ? a.index : Number(a.index)
    if (Number.isInteger(idx)) byIndex.set(idx, a)
  })

  return questions.map((q, i): AgentAnswer => {
    const a = byIndex.get(i)
    if (!a) return { agentId, agentName, optionLabels: [], reason: '', abstain: true }
    const reason = typeof a.reason === 'string' ? oneLine(a.reason) : ''
    const rawChoices = Array.isArray(a.choice) ? a.choice : [a.choice]
    const optionLabels: string[] = []
    for (const c of rawChoices) {
      const cl = String(c ?? '').trim()
      if (!cl || cl.toLowerCase() === 'custom') continue
      const hit = q.options.find((o) => o.label.toLowerCase() === cl.toLowerCase())
      if (hit) optionLabels.push(hit.label)
    }
    const custom = typeof a.custom === 'string' && a.custom.trim() ? oneLine(a.custom) : undefined
    if (optionLabels.length === 0 && !custom) {
      return { agentId, agentName, optionLabels: [], reason, abstain: true }
    }
    return { agentId, agentName, optionLabels, ...(custom ? { custom } : {}), reason }
  })
}

/** Normalize one agent's answer to a comparable/SDK-ready string (labels sorted). */
export function answerKey(a: AgentAnswer): string {
  if (a.optionLabels.length > 0) return [...a.optionLabels].sort().join(', ')
  return a.custom ?? ''
}

/**
 * Roll up all voters' answers to one question. Unanimous ⇒ every voter produced
 * a parseable answer (≥1, none abstained) and they all normalize identically.
 */
export function tallyQuestion(
  q: AskQuestion,
  index: number,
  answers: AgentAnswer[],
): QuestionConsensus {
  const active = answers.filter((a) => !a.abstain)
  const keys = active.map(answerKey)
  const unanimous =
    active.length === answers.length && active.length > 0 && keys.every((k) => k === keys[0])
  return {
    index,
    question: q.question,
    header: q.header,
    multiSelect: q.multiSelect,
    answers,
    unanimous,
    agreed: unanimous ? keys[0] : null,
  }
}

/** Deterministic ask-summary when the decider agent is unavailable or aborted. */
export function fallbackAskSummary(perQuestion: QuestionConsensus[]): string {
  const n = perQuestion.length
  const agreed = perQuestion.filter((q) => q.unanimous).length
  if (agreed === n) return `所有 agent 对全部 ${n} 个问题作答一致，可自动作答`
  return `agent 对 ${agreed}/${n} 个问题作答一致，其余需人工选择`
}

/** Deterministic summary when the decider agent is unavailable or aborted. */
export function fallbackSummary(
  votes: ConsensusVote[],
  unanimous: boolean,
  decision: 'allow' | 'deny' | null,
): string {
  const counts = votes.reduce<Record<string, number>>((acc, v) => {
    acc[v.decision] = (acc[v.decision] ?? 0) + 1
    return acc
  }, {})
  const parts = Object.entries(counts).map(([d, n]) => `${n} ${d}`)
  if (unanimous && decision) {
    return `所有 agent 一致${decision === 'allow' ? '允许' : '拒绝'}（${parts.join(', ')}）`
  }
  return `agent 意见不一致（${parts.join(', ')}），需人工裁决`
}
