/**
 * Dev-launch prompt construction — pure, feature-private (ADR-0009).
 *
 * `start_development` turns one intent into the first user prompt of a background
 * development session. The prompt has three shapes, decided by the workspace's
 * `devSkill` and `sddEnabled`:
 *
 *   1. `devSkill` configured → the dev skill slash-command is the prefix
 *      (SDD's work-session instruct is NOT stacked on top — devSkill wins).
 *   2. no `devSkill`, SDD on → the SDD work-session instruct is the prefix, so a
 *      plain dev session works in the spec-driven, checkpoint-governed way.
 *   3. SDD off, no `devSkill` → bare `title + content + deps` (the historic shape,
 *      kept byte-for-byte for backward compatibility).
 *
 * When SDD is on, a spec-path note is appended at the END pointing the agent at
 * the intent's approved `spec.md` (the single source of truth) — regardless of
 * which prefix applies (devSkill or instruct).
 *
 * This is a pure string builder so the three branches are unit-testable without
 * launching a run.
 */

/**
 * The SDD work-session instruct — prefixed to a plain dev session's first prompt
 * when SDD is on and no `devSkill` is configured. It installs, in natural
 * language, the spec-driven, checkpoint-governed working contract (the same hard
 * constraints the c3 SDD flow expects). The English skeleton is fixed, kept out
 * of i18n per `specs/style/i18n-spec.md` (it shapes agent behaviour, not console
 * UI).
 */
export const SDD_WORK_SESSION_INSTRUCT = `You are a spec-driven development agent working inside c3's spec-driven development (SDD) flow. Your job is to deliver the change described below by the approved spec — code, tests, and companion docs as ONE complete delivery — while keeping the human in control through restatement, checkpoints, and evidence.

Hard constraints (do not circumvent):
- **Spec is Truth.** The approved spec is the single source of truth for this change. Read it FIRST and develop to satisfy it. Where the intent text and the spec disagree, the spec wins.
- **Restate First.** Before writing any code, restate — in your own words — the goal, the scope boundary, and the acceptance criteria you will deliver against. Surface unknowns and assumptions explicitly.
- **Checkpoint Before Execute.** Before any irreversible or wide-blast-radius action (large refactors, deletions, schema/migration changes, anything outward-facing), pause and state the plan, then proceed only once it is sound. Decompose the work and advance in small, verifiable steps.
- **Done by Evidence.** A task is done only when proven by evidence — passing tests, a clean typecheck/lint, or observed behaviour — never by assertion. Report failures faithfully with their output; never claim success you have not verified.
- **Reverse Sync.** When implementation reality diverges from the spec (a constraint was wrong, a better design emerged, scope shifted), update the spec to match what you actually built — keep the spec and the code in sync, do not let them drift.
- **Ask via Tool.** When something is genuinely ambiguous or a decision is the human's to make, use AskUserQuestion to confirm — do not guess and do not silently pick.

Pause and hand back to the human when: the spec is internally inconsistent or contradicts existing project conventions; the change needs a decision outside the stated scope; an acceptance criterion cannot be met as written; or an action would be hard to reverse and you are not certain it is correct.

Now develop the following intent.`

/**
 * The spec-path note appended to the dev prompt when SDD is on. Points the agent
 * at the intent's approved spec document (relative to the workspace root).
 */
export function buildDevSpecNote(specPath: string): string {
  return `Approved spec for this intent: \`${specPath}\`. Read it first — it is the single source of truth (Spec is Truth). Develop to satisfy it, and reverse-sync the spec if implementation reality diverges.`
}

/** Inputs for {@link buildDevPrompt} — everything the three branches need. */
export interface DevPromptArgs {
  /** The intent title. */
  title: string
  /** The intent content (the free-text body). */
  content: string
  /** Ids of intents this one depends on; appended as a `依赖需求` note when non-empty. */
  dependsOn: readonly string[]
  /** Normalized dev skill prefix (e.g. `/dev`); `''` when none configured. */
  devSkill: string
  /** Whether spec-driven development is enabled for the workspace. */
  sddEnabled: boolean
  /** The intent's approved spec path (relative to the workspace); `null` when none. */
  specPath: string | null
}

/**
 * Build the first user prompt for a development session from one intent. See the
 * module header for the three branches; SDD-off + no-devSkill is byte-for-byte
 * the historic `${title}\n\n${content}${depNote}`.
 */
export function buildDevPrompt(args: DevPromptArgs): string {
  const depNote = args.dependsOn.length ? `\n\n依赖需求:${args.dependsOn.join(', ')}` : ''
  // Prefix precedence: a configured devSkill wins; otherwise SDD's work-session
  // instruct applies when SDD is on; otherwise no prefix. The two never stack.
  let prefix = ''
  if (args.devSkill) {
    prefix = `${args.devSkill} `
  } else if (args.sddEnabled) {
    prefix = `${SDD_WORK_SESSION_INSTRUCT}\n\n`
  }
  // Spec-path note: appended at the end whenever SDD is on and a spec exists,
  // regardless of which prefix applies.
  const specNote = args.sddEnabled && args.specPath ? `\n\n${buildDevSpecNote(args.specPath)}` : ''
  return `${prefix}${args.title}\n\n${args.content}${depNote}${specNote}`
}
