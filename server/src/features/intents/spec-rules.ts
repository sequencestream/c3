/**
 * The spec writing/review discipline, as ONE structured ruleset.
 *
 * Three consumers read this file and none of them re-writes a rule in prose:
 *   - the authoring prompt is a PROJECTION of the entries below,
 *   - the review prompt states the same defects in the reviewer's own voice,
 *   - the read-only analyzer walks the `detect` lists of the entries it can check.
 *
 * So a rule exists in exactly one place: change it here and all three follow.
 *
 * The stage is deliberately warn-only. Every severity is `warn` and no consumer
 * may branch on it to refuse work — a detector that has never run against real
 * traffic has no standing to block it, and the comparison that would justify
 * blocking has not been collected yet. For the same reason nothing here counts
 * words or sentence LENGTH: the length-shaped rules are shapes to read for, and
 * a detector that could enforce a threshold would make the threshold the rule.
 */

/** Which complexity tier a rule is aimed at. `'all'` = every tier. */
export type SpecRuleTier = 'simple' | 'normal' | 'complex' | 'all'

/**
 * The machine-checkable shapes behind a rule. `detect: []` means judgement
 * only — the prompt carries it, nothing checks it.
 *
 * None of these may become a word / character / sentence-length count: the
 * discipline deliberately has no such threshold, and inventing one in the
 * detector would smuggle the very rule the writing side refuses.
 */
export type SpecRuleDetectionKind =
  | 'duplicate_normative_fact'
  | 'navigation_as_constraint'
  | 'redundant_handoff_section'
  | 'empty_heading'
  | 'repeated_connective'
  | 'passive_voice'

export interface SpecRule {
  /** Stable identity, also the metric row key. */
  readonly id: string
  readonly tier: SpecRuleTier
  readonly severity: 'warn'
  /** The machine-checkable shapes behind this rule; empty = judgement only. */
  readonly detect: readonly SpecRuleDetectionKind[]
  /** One entry of the discipline, written for the reader of the prompt it lands in. */
  readonly statement: string
}

/** The three line budgets, as prompt guidance only — the analyzer never counts lines. */
export const SPEC_TIER_LINE_BUDGETS = [
  { tier: 'simple', budget: 'Target 8–20 lines.' },
  { tier: 'normal', budget: 'Target at most 40 lines.' },
  { tier: 'complex', budget: 'Target at most 70 lines.' },
] as const satisfies readonly { tier: SpecRuleTier; budget: string }[]

/** The cap that keeps the ruleset from growing back into the prose blob it replaced. */
export const SPEC_RULE_LIMIT = 7

export const SPEC_RULES: readonly SpecRule[] = [
  {
    id: 'self-contained',
    tier: 'all',
    severity: 'warn',
    detect: [],
    statement:
      '**Self-contained** — a reviewer reads this document alone and approves or rejects it without opening the intent or the source. Restate the motivation, the observable change, the scope boundaries and non-goals, and the acceptance conditions in your own words, at the altitude the decision needs; do not copy the intent verbatim, dump its fields, or contradict it.',
  },
  {
    id: 'design-altitude',
    tier: 'all',
    severity: 'warn',
    detect: ['redundant_handoff_section'],
    statement:
      '**Design altitude** — state the chosen approach, the flows, the core logic, the state and its transitions, and the rules that govern them, concretely but at design altitude. Do not exhaustively transcribe the code: per-file checklists, inventories of source paths and symbols, and step-by-step line edits duplicate the source and drift out of sync. Cover the implementation approach inline where it belongs. There is no separate implementation-handoff section, and do not list an implementation ORDER — sequence is an implementation detail and the source is the authority.',
  },
  {
    id: 'one-subject-per-section',
    tier: 'all',
    severity: 'warn',
    detect: ['empty_heading'],
    statement:
      '**One subject per section** — carry the hierarchy in the writing with grouped subsections or nested bullets: open with the overall frame of the affected capability, decompose it layer by layer, and only then land on the concrete change points. Never flatten it into one level of loose bullets, never create a heading with no substantive content, and never pad a section to fill the structure.',
  },
  {
    id: 'navigation-not-constraint',
    tier: 'all',
    severity: 'warn',
    detect: ['navigation_as_constraint'],
    statement:
      '**Navigation, not constraint** — file paths, symbol names and line numbers are NON-NORMATIVE NAVIGATION: they help a reader locate something and MUST NOT carry a constraint, an acceptance condition, or the only statement of a fact. Name a specific capability, contract, component or data field when it sharpens a decision, and give a file path for the FEW touchpoints that carry that decision — it is not a licence to enumerate every file and symbol.',
  },
  {
    id: 'no-duplicate-fact',
    tier: 'all',
    severity: 'warn',
    detect: ['duplicate_normative_fact'],
    statement:
      '**Necessary and non-duplicative** — state every normative fact exactly once. A list the source can rebuild and that does not change a decision is not a constraint, and neither is a second statement of something an earlier section already settled. Where something does NOT change, write one sentence saying which capability or layer stays as it is and why, and let the source be the inventory.',
  },
  {
    id: 'section-shape',
    tier: 'all',
    severity: 'warn',
    detect: [],
    statement:
      "**Section shape** — choose the smallest structure that fully explains the decision, judged by the change's real codebase impact rather than the length of the intent. Non-goals are one bullet. Add a diagram only when an architectural relationship, a multi-component collaboration, or a state transition is complex enough that a picture pays for itself. Use short paragraphs and concrete bullets; use a table only when it makes a comparison clearer; never add a `status` label, because approval is a system gate that writes no status back.",
  },
  {
    id: 'sentence-form',
    tier: 'all',
    severity: 'warn',
    detect: ['repeated_connective', 'passive_voice'],
    statement:
      '**Sentence form** — when a sentence runs long enough that a reader must go back to find where it ends, break it at a semantic boundary. Put the conclusion of a section first. Use any one connective at most once per section. Where a "被 / 由 / 经" passive leaves the actor vague, rewrite it in the active voice. These are shapes to read for, not numbers to hit.',
  },
] as const satisfies readonly SpecRule[]

/** Every rule that carries at least one machine-checkable shape. */
export function specRulesWithDetection(): readonly SpecRule[] {
  return SPEC_RULES.filter((rule) => rule.detect.length > 0)
}

/** The rule a detection kind belongs to — the analyzer's route from a hit back to its entry. */
export function specRuleForDetection(kind: SpecRuleDetectionKind): SpecRule | undefined {
  return SPEC_RULES.find((rule) => rule.detect.includes(kind))
}
