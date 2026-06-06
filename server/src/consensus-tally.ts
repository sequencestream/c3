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

/**
 * Return a shallow copy of `questions` with each question's `options` array
 * randomly reordered (Fisher–Yates driven by `rng`, default `Math.random`).
 * Only presentation order changes — labels/descriptions are untouched — so
 * parsing/tally/injection are unaffected: `matchOption` resolves a choice by
 * label **content**, never by option index, and `answerKey` sorts labels before
 * comparing. Giving each voter an independent ordering dilutes the LLM's
 * positional ("first option is safest") selection bias. Ask-path only;
 * allow/deny has no candidate list to reorder. `rng` is injectable so unit
 * tests stay deterministic.
 */
export function shuffleOptions(
  questions: AskQuestion[],
  rng: () => number = Math.random,
): AskQuestion[] {
  return questions.map((q) => {
    const options = [...q.options]
    for (let i = options.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[options[i], options[j]] = [options[j], options[i]]
    }
    return { ...q, options }
  })
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

/**
 * Tally the voters' allow/deny verdicts into an auto-resolve decision.
 *
 * `unanimous` always reports **literal** unanimity — every voter cast the same
 * `allow`/`deny` verdict, no abstention — regardless of `majority`. It is kept
 * separate from `decision` so the summary/UI can honestly distinguish a fully
 * unanimous outcome from one carried only by a majority.
 *
 * `decision` is the verdict the gateway auto-resolves on, or `null` ⇒ defer to
 * the human (the fail-safe default):
 * - `majority = false` (default, unanimous-only): `decision` is set only when the
 *   vote is unanimous; any split, abstention, or empty set ⇒ `null`.
 * - `majority = true`: abstentions are **not counted**; a **strict majority** of
 *   the cast allow/deny votes decides (`allow > deny` ⇒ allow, `deny > allow` ⇒
 *   deny). A **tie** (`2v2`), **no clear majority**, or **no cast vote** (all
 *   abstained / empty) ⇒ `null`. A unanimous vote is naturally a majority too,
 *   so `unanimous` and `decision` agree on the all-agree case.
 */
export function tally(
  votes: ConsensusVote[],
  majority = false,
): {
  unanimous: boolean
  decision: 'allow' | 'deny' | null
} {
  const decisions = votes.map((v) => v.decision)
  const allAllow = decisions.length > 0 && decisions.every((d) => d === 'allow')
  const allDeny = decisions.length > 0 && decisions.every((d) => d === 'deny')
  const unanimous = allAllow || allDeny
  if (!majority) {
    return { unanimous, decision: allAllow ? 'allow' : allDeny ? 'deny' : null }
  }
  const allow = decisions.filter((d) => d === 'allow').length
  const deny = decisions.filter((d) => d === 'deny').length
  return { unanimous, decision: allow > deny ? 'allow' : deny > allow ? 'deny' : null }
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
      lines.push(
        `    - ${stripRecommendation(o.label)}${o.description ? `: ${o.description}` : ''}`,
      ),
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
 * Trailing recommendation/preference markers an asker appends to an option label
 * (per the AskUserQuestion convention of flagging its recommended choice). We
 * strip ONLY a bracketed marker at the very end — `方案A (推荐)`, `Use X (Recommended)`,
 * `选项【建议】` — across `()（）[]【】` and the synonyms 推荐/建议/默认/recommended/
 * recommend/default. Unbracketed text is left intact so a legitimate label that
 * merely ends in such a word (e.g. `使用系统默认`) is never truncated.
 */
const REC_MARKER =
  /\s*[（(【[]\s*(?:推荐|建议|默认|recommended|recommend|default)\s*[)）】\]]\s*$/iu

/** Remove a trailing bracketed recommendation marker from a label; idempotent. */
export function stripRecommendation(label: string): string {
  return label.replace(REC_MARKER, '').trim()
}

/**
 * Resolve an advisor's free-form choice string to one of a question's option
 * labels. Advisors frequently echo the label with extra reasoning appended
 * (e.g. `"方案A：扩展协议: <why>"`) or embed it in a sentence; strict equality
 * would mis-record those as abstentions, so after the exact pass we fall back to
 * the longest label that prefixes / is prefixed by / is contained in the choice.
 * Longest-first ordering keeps a specific label (`方案A：扩展协议`) from losing to
 * a shorter sibling (`方案A`). Returns the canonical label, or null if none fit.
 *
 * Voter/decider prompts present the **de-biased** label (asker recommendation
 * markers stripped, see {@link stripRecommendation}), so an advisor naturally
 * echoes the stripped form. After the literal-exact pass we therefore compare
 * stripped-against-stripped and return the **original** label — restoring the
 * exact label `withAnswers` injects by, untouched by the de-bias. A no-op when
 * the label carries no marker (the literal exact pass already caught it).
 */
export function matchOption(choice: string, options: { label: string }[]): string | null {
  const c = choice.trim().toLowerCase()
  if (!c) return null
  const exact = options.find((o) => o.label.toLowerCase() === c)
  if (exact) return exact.label
  const cStripped = stripRecommendation(choice).toLowerCase()
  if (cStripped) {
    const strippedExact = options.find(
      (o) => stripRecommendation(o.label).toLowerCase() === cStripped,
    )
    if (strippedExact) return strippedExact.label
  }
  const byLenDesc = [...options].sort((a, b) => b.label.length - a.label.length)
  const prefix = byLenDesc.find((o) => {
    const l = o.label.toLowerCase()
    return l.length > 0 && (c.startsWith(l) || l.startsWith(c))
  })
  if (prefix) return prefix.label
  const sub = byLenDesc.find((o) => {
    const l = o.label.toLowerCase()
    return l.length >= 2 && (c.includes(l) || l.includes(c))
  })
  return sub ? sub.label : null
}

/**
 * Parse one advisor's reply into per-question answers, aligned to `questions`.
 * Labels are matched (tolerantly, see {@link matchOption}) to the option set;
 * unmatched/missing questions are returned as `abstain` (ignored by the tally).
 * Always returns one entry per question.
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
      const hit = matchOption(cl, q.options)
      if (hit && !optionLabels.includes(hit)) optionLabels.push(hit)
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

/**
 * Build the decider prompt: in ONE call, judge every split question and write the
 * human-facing summary. The decider sees each advisor's actual answer + reasoning,
 * so it can recognize an effective consensus the literal tally missed (a mis-parsed
 * reply, or differently-worded answers that mean the same option). It is asked to
 * adjudicate ONLY the split questions and must answer with exact option labels.
 */
export function deciderAskPrompt(
  perQuestion: QuestionConsensus[],
  questions: AskQuestion[],
): string {
  const split = perQuestion.filter((q) => !q.unanimous)
  const lines: string[] = [
    "You are the deciding agent. Several advisor agents answered, on the user's behalf,",
    "the questions an AI agent asked. Here is every advisor's actual answer and reasoning:",
    '',
  ]
  perQuestion.forEach((q) => {
    lines.push(`[${q.index}|${q.header || q.index}] ${q.question}`)
    q.answers.forEach((a) =>
      lines.push(
        `    - ${a.agentName}: ${
          a.abstain ? '弃权' : a.optionLabels.map(stripRecommendation).join('/') || a.custom || '?'
        }${a.reason ? ` — ${a.reason}` : ''}`,
      ),
    )
    const agreedClean = q.agreed
      ? q.agreed.split(', ').map(stripRecommendation).join(', ')
      : q.agreed
    lines.push(`    => ${q.unanimous ? `一致：${agreedClean}` : '意见分歧'}`)
  })
  lines.push('')
  if (split.length > 0) {
    lines.push(
      'Some questions above are marked 意见分歧. For EACH such question, judge whether the',
      'advisors actually reach an effective consensus — e.g. they picked the same option but a',
      'reply was mis-parsed, or differently-worded answers mean the same option. If they',
      'effectively agree, set "consensus":true and give the agreed answer using the EXACT option',
      'label(s) listed below; if they genuinely differ, set "consensus":false. Judge ONLY these:',
    )
    split.forEach((q) => {
      const opts = questions[q.index]?.options ?? []
      lines.push(
        `  [${q.index}] options: ${opts.map((o) => stripRecommendation(o.label)).join(' | ')}`,
      )
    })
    lines.push('')
  }
  lines.push(
    'Also write ONE short Chinese sentence summarizing the collective answers for a human who must confirm.',
    'Reply with ONLY a single-line JSON object, no other text:',
    '{"summary":"<chinese sentence>","questions":[{"index":0,"consensus":true,"choice":"<exact label>"|["<label>"]|"custom","custom":"<text or null>"}]}',
  )
  return lines.join('\n')
}

/**
 * Parse the decider's combined judge+summary reply. Returns the summary text and,
 * for each split question the decider ruled an effective consensus on, the agreed
 * answer in SDK string format (sorted labels comma-joined, or a custom reply) —
 * but ONLY when it resolves to valid option label(s) or a non-empty custom string.
 * `consensus:false`, unparseable, or unresolved entries are dropped (stay split).
 */
export function parseDeciderAsk(
  text: string,
  questions: AskQuestion[],
): { summary: string; overrides: Map<number, string> } {
  const overrides = new Map<number, string>()
  let summary = ''
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return { summary, overrides }
  let obj: { summary?: unknown; questions?: unknown }
  try {
    obj = JSON.parse(match[0]) as typeof obj
  } catch {
    return { summary, overrides }
  }
  if (typeof obj.summary === 'string') summary = oneLine(obj.summary)
  const arr = Array.isArray(obj.questions) ? obj.questions : []
  for (const raw of arr) {
    const e = raw as { index?: unknown; consensus?: unknown; choice?: unknown; custom?: unknown }
    if (e.consensus !== true) continue
    const idx = typeof e.index === 'number' ? e.index : Number(e.index)
    if (!Number.isInteger(idx) || !questions[idx]) continue
    const q = questions[idx]
    const rawChoices = Array.isArray(e.choice) ? e.choice : [e.choice]
    const labels: string[] = []
    for (const c of rawChoices) {
      const cl = String(c ?? '').trim()
      if (!cl || cl.toLowerCase() === 'custom') continue
      const hit = matchOption(cl, q.options)
      if (hit && !labels.includes(hit)) labels.push(hit)
    }
    const custom = typeof e.custom === 'string' && e.custom.trim() ? oneLine(e.custom) : ''
    if (labels.length > 0) overrides.set(idx, [...labels].sort().join(', '))
    else if (custom) overrides.set(idx, custom)
  }
  return { summary, overrides }
}

/** Deterministic ask-summary when the decider agent is unavailable or aborted. */
export function fallbackAskSummary(perQuestion: QuestionConsensus[]): string {
  const n = perQuestion.length
  const agreed = perQuestion.filter((q) => q.unanimous).length
  if (agreed === n) return `所有 agent 对全部 ${n} 个问题作答一致，可自动作答`
  return `agent 对 ${agreed}/${n} 个问题作答一致，其余需人工选择`
}

/**
 * Deterministic summary when the decider agent is unavailable or aborted. Reads
 * `(unanimous, decision)` straight off the tally so it self-describes all three
 * outcomes: a unanimous auto-resolve, a majority-carried auto-resolve (`decision`
 * set while `unanimous` is false — only under the majority toggle), and a
 * deferral to the human (no `decision`).
 */
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
  if (decision) {
    const verb = decision === 'allow' ? '允许' : '拒绝'
    if (unanimous) return `所有 agent 一致${verb}（${parts.join(', ')}）`
    return `多数派裁决${verb}（${parts.join(', ')}）`
  }
  return `agent 意见不一致（${parts.join(', ')}），需人工裁决`
}
