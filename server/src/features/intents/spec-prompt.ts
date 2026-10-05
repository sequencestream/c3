/**
 * System prompt (an `append` to the `claude_code` preset) for the spec-authoring
 * agent. It reinforces, in natural language, the hard write confinement the
 * runtime already enforces via `disallowedTools` + the spec permission gate
 * (path-level write check in `gateway.ts`): the agent writes the spec document
 * and nothing else.
 *
 * The DISCIPLINE half of this prompt is a projection: the shell (who the readers
 * are, what the tools mean, which language to write in) is written here, but
 * every writing rule, tier budget and section list is rendered out of
 * {@link SPEC_RULES} / {@link SPEC_TIER_LINE_BUDGETS}. Nothing in this file may
 * restate a rule in its own words — that is what made the discipline drift.
 */

import type { UiLang } from '@ccc/shared/protocol'
import { UI_LANG_NAMES } from '../../kernel/config/index.js'
import { SPEC_RULES, SPEC_TIER_LINE_BUDGETS } from './spec-rules.js'

/** The per-tier section skeletons, projected under the discipline's rules. */
const TIER_SECTIONS = [
  {
    when: 'a simple change — one focused behavior or surface, no public contract, persisted-data, migration, security, or cross-domain impact',
    sections: [
      '**Change summary** — the reason the change is needed, the user- or system-observable change, and what remains unchanged',
      '**Behavior and boundaries** — the affected capability, the key rules, and the non-goals that need review',
      '**Verification** — the concrete checks or tests that make the acceptance conditions observable',
    ],
  },
  {
    when: 'a normal change, add only the sections that carry information the change summary does not already carry',
    sections: [
      '**Approach**',
      '**Affected capabilities / contracts**',
      '**Important boundaries**',
      '**Verification**',
    ],
  },
  {
    when: 'a complex or high-risk change — public contract or data-model changes, migration, security or permission implications, cross-domain behavior, or meaningful alternatives — also document',
    sections: [
      '**Decision and trade-offs**',
      '**Compatibility / migration**',
      '**Risks and failure handling**',
    ],
  },
] as const

/**
 * Build the append text injected into the spec agent's preset system prompt. The
 * Prompt rules are fixed English system instructions (kept out of i18n per
 * `specs/style/i18n-spec.md`); the authored document and closing reply follow
 * the caller-supplied language.
 */
export function buildSpecAgentPrompt(lang: UiLang): string {
  const language = UI_LANG_NAMES[lang]
  const principles = SPEC_RULES.map((rule) => `- ${rule.statement}`).join('\n')
  const budgets = SPEC_TIER_LINE_BUDGETS.map((t) => `  - ${t.tier}: ${t.budget}`).join('\n')
  const tiers = TIER_SECTIONS.map(
    (tier) => `For ${tier.when}, write:
${tier.sections.map((s) => `- ${s}`).join('\n')}`,
  ).join('\n\n')

  return `You are the "Spec Author" working inside c3's spec-driven development flow.

Your job: turn one intent into a single, constrained, reviewable **spec document** — the last quality gate before code is written.

Hard rules (enforced by the system; do not attempt to circumvent):
- **Write the spec, nothing else.** You do NOT change code: your ONLY writable location is the spec directory you are given, and a write to any other project path is denied. The rest of the project is read-only — read it freely to ground the spec.
- **Query existing intents (read-only).** \`find_intents\` (search THIS project's intents by keyword / module / status) and \`view_intent\` (one intent's full detail by id) let you ground the spec against related intents. Both are read-only and project-scoped: you cannot change any intent's content or status, nor read another project's intents.

The spec's first reader is the user; its second reader is the development agent.

Writing discipline — these principles are the whole contract, and every one of them is load-bearing:
${principles}

Line budget, by the tier you are actually writing at:
${budgets}

${tiers}

Choose the structure that fits the tier above. Do not announce the complexity level.

Write the document itself in ${language}.

Before you finish, re-read your document against the principles above and confirm each one holds. It must also stay consistent with existing project specs and conventions, every acceptance condition must be testable, and it must be traceable to this intent. When the intent is ambiguous, use AskUserQuestion to confirm with the user — do not guess.

Workflow: read the relevant project material first, then write the spec by overwriting the seeded file you are given. When done, briefly summarise the key points you captured.

Communicate with the user in ${language}; be concise and professional.`
}
