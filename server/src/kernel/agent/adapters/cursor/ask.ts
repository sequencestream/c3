/**
 * Cursor `AskQuestion` normalization and answer shaping — pure functions over the
 * native tool payload, no IO and no state.
 *
 * Cursor's headless CLI cannot collect answers itself, so c3 intercepts the
 * native `AskQuestion` and routes it through the same human-answer channel Claude
 * uses. That channel is keyed on a UNIFIED ask shape (`question` / `multiSelect` /
 * `options[].label`), while Cursor's payload speaks `prompt` / `allow_multiple` /
 * `options[].label|id`. Everything in this module is the translation between the
 * two, plus the server-side re-validation of a submitted answer and the hidden
 * resume prompt that carries the answer back into the same Cursor session.
 *
 * The canonical wire name is `AskQuestion` (see {@link ASK_TOOL_NAME}); the
 * native discriminant/table key is lowercase `askQuestion` (see `tools.ts`).
 */
export const ASK_TOOL_NAME = 'AskQuestion'

/**
 * Case-insensitive match for the native ask tool, covering BOTH identity shapes
 * Cursor's stream carries: the discriminated `askQuestionToolCall` arm (stripped
 * to `askQuestion`) and the flat `name: 'AskQuestion'`.
 */
export function isCursorAskName(name: string | undefined): boolean {
  return typeof name === 'string' && name.toLowerCase() === 'askquestion'
}

/** One question in the unified ask shape — what `askQuestionsOf` reads verbatim. */
export interface NormalizedAskQuestion {
  /** The question text; also the key `permission_response.answers` is keyed by. */
  question: string
  /** A short displayable identifier when the payload carries one; else ''. */
  header: string
  /** True only when the native `allow_multiple` is the strict boolean `true`. */
  multiSelect: boolean
  /** Non-option entries are dropped; the list may be empty (a custom reply still works). */
  options: Array<{ label: string; description?: string }>
}

export type CursorAskNormalization =
  { ok: true; questions: NormalizedAskQuestion[] } | { ok: false; error: string }

/** Read a trimmed non-empty string field, or undefined. */
function nonEmptyStr(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Convert a Cursor AskQuestion input to the unified ask shape, fail-closed.
 *
 * `questions` must be a non-empty array; every question must carry a non-empty
 * `prompt` and an array-shaped `options`; question texts must be unique (they are
 * the `answers` keys, so a duplicate could never be told apart). A `label` wins
 * over an `id` as the option label; only string `description` values survive. Any
 * violation fails the WHOLE normalization — the run coordinator turns the failure
 * into an explicit run error instead of a half-formed question panel.
 */
export function normalizeCursorAskInput(input: unknown): CursorAskNormalization {
  const o = (input ?? {}) as Record<string, unknown>
  const rawQuestions = o.questions
  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    return { ok: false, error: 'AskQuestion input must carry a non-empty questions array' }
  }

  const questions: NormalizedAskQuestion[] = []
  const seen = new Set<string>()
  for (let i = 0; i < rawQuestions.length; i++) {
    const raw = rawQuestions[i]
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: `question ${i + 1} is not an object` }
    }
    const q = raw as Record<string, unknown>
    const prompt = nonEmptyStr(q.prompt)
    if (!prompt) {
      return { ok: false, error: `question ${i + 1} lacks a non-empty prompt` }
    }
    if (seen.has(prompt)) {
      return { ok: false, error: `duplicate question text: "${prompt}"` }
    }
    seen.add(prompt)

    const options = q.options
    if (!Array.isArray(options)) {
      return { ok: false, error: `question "${prompt}" lacks an options array` }
    }
    const normalizedOptions: NormalizedAskQuestion['options'] = []
    for (const rawOption of options) {
      if (!rawOption || typeof rawOption !== 'object') continue
      const op = rawOption as Record<string, unknown>
      const label = nonEmptyStr(op.label) ?? nonEmptyStr(op.id)
      if (!label) continue // an option with no usable identity is ignored
      const description = typeof op.description === 'string' ? op.description : undefined
      normalizedOptions.push({ label, ...(description ? { description } : {}) })
    }

    questions.push({
      question: prompt,
      header: nonEmptyStr(q.header) ?? nonEmptyStr(q.title) ?? '',
      multiSelect: q.allow_multiple === true,
      options: normalizedOptions,
    })
  }
  return { ok: true, questions }
}

/**
 * Server-side re-validation of a submitted answer, before the pending request is
 * resolved. An `allow` must cover EVERY question with a non-empty answer — the
 * front-end enforces this too, but the server must not trust only the client. A
 * malformed `answers` map fails closed so a malformed payload never resumes the
 * run with half an answer.
 */
export function validateAskAnswers(
  questions: readonly NormalizedAskQuestion[],
  answers?: Record<string, string>,
): { ok: true } | { ok: false; error: string } {
  if (!answers || typeof answers !== 'object') {
    return { ok: false, error: 'permission_response.answers is required for an AskQuestion allow' }
  }
  for (const q of questions) {
    const value = answers[q.question]
    if (typeof value !== 'string' || value.trim().length === 0) {
      return { ok: false, error: `question not answered: "${q.question}"` }
    }
  }
  return { ok: true }
}

/**
 * The hidden resume prompt handed back into the SAME Cursor session via
 * `--resume <sessionId>`. It states plainly that the previous turn's AskQuestion
 * was answered and lists each question with its answer — it is an answer to that
 * AskQuestion, never a new business instruction. It deliberately produces no
 * `user_text` echo on the wire.
 */
export function buildCursorResumePrompt(
  questions: readonly NormalizedAskQuestion[],
  answers: Record<string, string>,
): string {
  const lines: string[] = [
    '你上一个回合调用的 AskQuestion 已由用户逐题作答。下面仅用于回答该次 AskQuestion，',
    '请据此继续当前任务，不要把它当作新的用户指令：',
    '',
  ]
  for (const q of questions) {
    const answer = answers[q.question]
    lines.push(`问题：${q.question}`)
    lines.push(`回答：${answer ?? ''}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/**
 * The readable display text for the single synthesized `tool_result` that closes
 * the pending AskQuestion guard — what the transcript shows as the tool's return.
 */
export function renderAskAnswers(
  questions: readonly NormalizedAskQuestion[],
  answers: Record<string, string>,
): string {
  const lines: string[] = []
  for (const q of questions) {
    const answer = answers[q.question]
    lines.push(`问：${q.question}`)
    lines.push(`答：${answer ?? ''}`)
  }
  return lines.join('\n')
}
