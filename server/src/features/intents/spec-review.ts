/**
 * Spec review — the read-only second opinion between "a spec exists" and "a spec
 * may be developed against".
 *
 * This module owns the three framing-free pieces the review flow needs:
 *   1. the spec **content fingerprint** every conclusion is bound to,
 *   2. the `submit_spec_review` tool contract + its core logic, and
 *   3. the prompts a review session runs on.
 *
 * The reviewer never echoes a fingerprint back. The one captured when the review
 * session was launched rides the per-run MCP binding, and the submit path
 * compares it against the spec's live content: a spec edited mid-review makes the
 * judgement stale and it is dropped, never interpreted as a pass. That keeps the
 * "which content was judged" fact out of the model's hands entirely.
 *
 * A conclusion is submitted EXPLICITLY through this one narrow tool. It is never
 * inferred from the reviewer's prose or from how its run happened to end — an
 * agent that crashes, rambles or says "looks fine" in text has submitted nothing.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Intent, SpecReviewVerdict, UiLang } from '@ccc/shared/protocol'
import { MAX_SPEC_REVIEW_REWORK_ROUNDS, SPEC_REVIEW_VERDICTS } from '@ccc/shared/protocol'
import { UI_LANG_NAMES } from '../../kernel/config/index.js'
import { resolveSpecFileAbs } from './specs-root.js'
import type { IntentToolResult } from './tool-defs.js'
import { getIntent, isStoreAvailable, recordSpecReview, safeInsertIntentLog } from './store.js'

/** The fingerprint of a spec's content. Stable, cheap, and collision-free enough
 * to answer the only question asked of it: "is this the same document?" */
export function specFingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Read an intent's spec and fingerprint it. Returns `null` when the intent has no
 * spec path or the file cannot be read — an unreadable spec is NOT an empty spec,
 * so callers must treat `null` as "cannot review right now", never as a change.
 */
export function readSpecFingerprint(workspacePath: string, specPath: string | null): string | null {
  if (!specPath) return null
  try {
    return specFingerprint(readFileSync(resolveSpecFileAbs(workspacePath, specPath), 'utf8'))
  } catch {
    return null
  }
}

// ---- The `submit_spec_review` tool contract ----

export const submitSpecReviewSchema = {
  verdict: z
    .enum(SPEC_REVIEW_VERDICTS)
    .describe('审核结论:pass=可据此开发;changes_requested=需修改后才可开发'),
  reason: z
    .string()
    .min(1)
    .describe(
      '结论理由。changes_requested 时必须具体说明缺什么、哪里与代码现状不符,' +
        '撰写方会拿这段理由直接返工;pass 时简述判断依据。',
    ),
}

export type SubmitSpecReviewArgs = { verdict: SpecReviewVerdict; reason: string }

export const submitSpecReviewDesc =
  '提交本次 spec 审核的结论(这是你唯一的产出方式,不写任何文件)。' +
  '结论只认这个工具:写在回复正文里的判断不算数,运行结束也不代表通过。' +
  '每次审核只提交一次;重复提交同一结论不会重复计数。'

/** What the caller needs to bind per review run. */
export interface SpecReviewBindingFacts {
  /** The intent under review — bound at launch, never supplied by the model. */
  intentId: string
  /** The review session id, for the audit trail. */
  sessionId: string | null
  /** The spec fingerprint captured when this review was launched. */
  fingerprint: string
}

/**
 * Persist one review conclusion. Every rejection path returns an `isError`
 * result the reviewer can read, and writes nothing:
 *   - the ledger is unavailable, or the bound intent is gone / has no spec;
 *   - the spec's live content no longer matches what was reviewed (stale).
 *
 * A duplicate submission of the identical conclusion is reported as accepted but
 * counts nothing — idempotency lives in `recordSpecReview`'s single transaction,
 * so a retried tool call cannot inflate the rework counter.
 */
export function runSubmitSpecReview(
  workspacePath: string,
  facts: SpecReviewBindingFacts,
  args: SubmitSpecReviewArgs,
): IntentToolResult {
  const fail = (msg: string): IntentToolResult => ({
    content: [{ type: 'text', text: msg }],
    isError: true,
  })
  if (!isStoreAvailable()) return fail('意图库不可用,审核结论未能记录。')
  const intent = getIntent(facts.intentId)
  if (!intent) return fail('待审核的意图已不存在,结论未记录。')

  const live = readSpecFingerprint(workspacePath, intent.specPath)
  if (live === null) return fail('spec 当前不可读,结论未记录。')

  const outcome = recordSpecReview({
    intentId: facts.intentId,
    sessionId: facts.sessionId,
    verdict: args.verdict,
    reason: args.reason.trim(),
    fingerprint: facts.fingerprint,
    liveFingerprint: live,
  })

  if (outcome === 'stale') {
    return fail('spec 在本次审核期间已被改写,该结论针对的内容已不存在,未记录。请重新审核最新内容。')
  }
  if (outcome === 'unknown') return fail('待审核的意图已不存在,结论未记录。')
  if (outcome === 'duplicate') {
    return { content: [{ type: 'text', text: '该结论此前已记录,本次为重复提交,未重复计数。' }] }
  }

  safeInsertIntentLog(
    facts.intentId,
    'spec_reviewed',
    `spec 审核结论: ${args.verdict === 'pass' ? '通过' : '需修改'} — ${args.reason.trim()}`,
    'automation',
  )
  return {
    content: [
      {
        type: 'text',
        text: args.verdict === 'pass' ? '结论已记录:通过。' : '结论已记录:需修改。',
      },
    ],
  }
}

// ---- Prompts ----

/**
 * The system prompt for the review agent. It restates in natural language the
 * confinement the runtime already enforces (read-only gate + disallowed tools),
 * so the agent does not waste turns attempting writes it cannot perform — the
 * prompt layer and the tool layer say the same thing, and the tool layer is what
 * actually binds.
 */
export function buildSpecReviewAgentPrompt(lang: UiLang): string {
  return `You are the "Spec Reviewer" in c3's spec-driven development flow.

Your job: judge ONE authored spec and report a structured verdict. You are the last automated check before development may be scheduled against this document.

Hard rules (enforced by the system; do not attempt to circumvent):
- **You are strictly read-only.** You have NO writable location — not the spec directory, not the repository, not anywhere. Every write tool, shell command, sub-agent and slash command is blocked. Do not try to fix the spec yourself: the spec belongs to its author, and rework happens by sending it back with reasons.
- **Report through \`submit_spec_review\` only.** A judgement written in your reply text is not a conclusion, and finishing your run is not a conclusion. Call the tool exactly once with \`verdict\` and a concrete \`reason\`.
- **Read freely to ground the judgement.** The repository source is readable, and \`find_intents\` / \`view_intent\` let you check this project's related intents. Use them — a spec that contradicts the codebase or a sibling intent is exactly what you are here to catch.

Judge the spec on whether it is safe and sufficient to develop against:
- **Self-contained** — a reviewer (and the development agent) can act on it without opening the originating intent.
- **Grounded** — its claims about the codebase hold when you check them. Names, contracts and constraints it asserts should actually exist as described.
- **Consistent** — it does not contradict the project's existing conventions, specs, or related intents.
- **Verifiable** — its acceptance conditions are concrete enough to be observed.
- **Complete for its size** — the decisions a developer must not have to invent are present. Do not demand ceremony a small change does not need.

Return \`changes_requested\` when a real defect would mislead development: a wrong or unverifiable claim about the code, a missing decision, an untestable acceptance condition, a contradiction. Say precisely what is wrong and what would fix it — your reason is handed to the author verbatim as the rework brief.

Return \`pass\` when the spec is good enough to build from. Do not withhold a pass over style, wording, or a section you would personally have organised differently. Rework rounds are capped at ${MAX_SPEC_REVIEW_REWORK_ROUNDS}; spending one on a preference rather than a defect burns a round the spec may genuinely need later.

Write the reason in ${UI_LANG_NAMES[lang]}; be concise and specific.`
}

/**
 * The visible turn that kicks off a review: which intent, which document, and
 * the requirements the spec is supposed to satisfy. The review contract itself
 * rides the system prompt above, so it never renders as a visible message
 * (hide-session-system-instructions).
 */
export function buildSpecReviewPrompt(
  intent: Intent,
  fileAbs: string,
  projectRoot?: string,
): string {
  const projectBlock = projectRoot ? `Project root: \`${projectRoot}\`\n\n` : ''
  const rework =
    intent.specReviewReworkRounds > 0
      ? `\nThis spec has already been through ${intent.specReviewReworkRounds} rework round(s) (cap: ${MAX_SPEC_REVIEW_REWORK_ROUNDS}).\n`
      : ''
  return `Review the spec document for intent \`${intent.id}\`.

Intent title: ${intent.title}

Intent content:
${intent.content}

${projectBlock}The spec to review lives at \`${fileAbs}\`. Read it, check its claims against the project source, then call \`submit_spec_review\` with your verdict and reason.${rework}`
}

/**
 * The rework turn sent to the spec AUTHOR's session after a `changes_requested`
 * conclusion. It carries the reviewer's reason verbatim — the author reworks
 * against the actual objection, not a summary of it.
 */
export function buildSpecReworkPrompt(
  intent: Intent,
  fileAbs: string,
  reviewReason: string,
  round: number,
  projectRoot?: string,
): string {
  const projectBlock = projectRoot ? `Project root: \`${projectRoot}\`\n\n` : ''
  return `The spec for intent \`${intent.id}\` did not pass review (round ${round} of ${MAX_SPEC_REVIEW_REWORK_ROUNDS}).

Reviewer's findings:
${reviewReason}

Intent title: ${intent.title}

${projectBlock}The spec lives at \`${fileAbs}\`. Address every point above and overwrite the same file. Where you disagree with a finding, say so explicitly in your summary rather than silently leaving it unaddressed.`
}
