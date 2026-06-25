import type { AgentConfig, CreateScheduleInput } from '@ccc/shared/protocol'

export interface ScheduleTemplateBuildArgs {
  workspaceId: string
  agentId: string
}

export interface ScheduleTemplate {
  id: string
  titleKey: 'schedule.list.templates.prPoller.title' | 'schedule.list.templates.archReview.title'
  descriptionKey:
    | 'schedule.list.templates.prPoller.description'
    | 'schedule.list.templates.archReview.description'
  build(args: ScheduleTemplateBuildArgs): CreateScheduleInput
}

export const PR_STATUS_POLLER_PROMPT = `Reconcile GitHub PR status for this workspace.

1. Find candidate intents, inspect each candidate, and process only intents whose prStatus is reviewing and which have a prUrl or prId.
2. Use Bash with gh to query the real GitHub PR status. Do not change intents whose PR is still open/reviewing.
3. If a PR is merged, call save_intent_pr_info with prStatus "merged" and done true. If it is closed without merging, call save_intent_pr_info with prStatus "closed" and leave done unset.
4. Only when a status actually changed, call publish_pr_event with result "success", operation "merge" or "close", the PR identity/state, and association.intentId.

Do not reopen PRs, merge PRs, resolve conflicts, or change intents outside this reconciliation.`

const PR_STATUS_POLLER: ScheduleTemplate = {
  id: 'pr-status-poller',
  titleKey: 'schedule.list.templates.prPoller.title',
  descriptionKey: 'schedule.list.templates.prPoller.description',
  build: ({ workspaceId, agentId }) => ({
    type: 'llm',
    config: { prompt: PR_STATUS_POLLER_PROMPT },
    workspaceId,
    agentId,
    vendor: 'claude',
    triggerType: 'cron',
    cronExpression: '*/10 * * * *',
    mode: 'bypassPermissions',
    toolAllowlist: [
      'Read',
      'Grep',
      'Glob',
      'Bash',
      'mcp__c3__find_intents',
      'mcp__c3__view_intent',
      'mcp__c3__save_intent_pr_info',
      'mcp__c3__publish_pr_event',
    ],
  }),
}

export const ARCH_REVIEW_PROMPT = `You are the weekly architecture-stability reviewer for this workspace. Review the LAST 7 DAYS of git activity and turn only the highest-value architecture improvement points into DRAFT intents for human review. You NEVER change code.

WINDOW (incremental only, never a full audit)
- Use Bash with git to inspect the recent window, e.g. \`git log --since="7 days ago" --stat\` and the matching diffs (\`git diff --since\`-equivalent ranges). Look only at what changed this week, not the whole codebase.

GROUND TRUTH FOR "ESTABLISHED CONSTRAINTS"
- Read doc/constitution.md, doc/architecture/architecture.md, and doc/adr/adr.md with the Read tool. Judge "violates an established architectural boundary" against these (e.g. cross-layer calls, bypassing the single protocol source shared/src/protocol.ts, bypassing the vendor-neutral abstraction).

SCORING ADMISSION (be strict — prefer too few over too many)
- A candidate is HIGH-VALUE only when it hits >=2 STRONG signals:
  1. Violates an established architectural constraint (constitution / architecture / adr boundary broken this week — drift to correct early).
  2. High leverage / broad blast radius — a core abstraction many modules depend on, or a design flaw on a shared path; fixing one place benefits many.
  3. Architecture debt actively worsening (trend) — this week shows a god-file swelling, a new circular dependency, an abstraction leak spreading, or the same logic being copy-pasted further.
  4. High-churn hotspot — the same file/module repeatedly changed within the week; the design has not settled and refactoring ROI is highest there.
- BONUS signals only refine priority (never make a point high-value on their own): 5. concentrated risk / large blast radius (core path lacking boundaries, error handling, or test coverage); 6. low-cost high-ROI (clear boundary, controlled change, writable acceptance — not a sweeping rewrite); 7. blocks upcoming evolution (current structure is in the way; cheaper to fix now).

MUST EXCLUDE (low value — noise)
- Pure style / naming / formatting (leave to lint/format) — do NOT file an intent.
- One-off scripts, test fixtures, soon-to-be-removed code.
- Subjective preferences with no objective basis; speculative over-engineering (YAGNI).

DE-DUPLICATE FIRST
- Before filing ANYTHING, call find_intents to search existing intents (by keyword/module). If a candidate is already covered by an existing intent, SKIP it. Use view_intent when you need to confirm overlap.

OUTPUT
- File at most 3 intents this run (<=3, prefer fewer; quality over quantity). Default priority P2 or P3.
- Call save_intent_directly to create each surviving candidate as a DRAFT intent (it lands as draft for human review/activation — there is no confirmation popup). Write a clear title, a concise English shortEnTitle, content stating the evidence (which files/commits this week, which strong signals hit) and a concrete acceptance.
- PRODUCE INTENTS ONLY. Never write/edit files, never refactor, never run change commands. Bash is only for reading git and the constraint docs.`

const WEEKLY_ARCH_REVIEW: ScheduleTemplate = {
  id: 'weekly-arch-review',
  titleKey: 'schedule.list.templates.archReview.title',
  descriptionKey: 'schedule.list.templates.archReview.description',
  build: ({ workspaceId, agentId }) => ({
    type: 'llm',
    config: { prompt: ARCH_REVIEW_PROMPT },
    workspaceId,
    agentId,
    vendor: 'claude',
    triggerType: 'cron',
    cronExpression: '0 18 * * 5',
    mode: 'bypassPermissions',
    toolAllowlist: [
      'Read',
      'Grep',
      'Glob',
      'Bash',
      'mcp__c3__find_intents',
      'mcp__c3__view_intent',
      'mcp__c3__save_intent_directly',
    ],
  }),
}

/** Register new schedule templates here; the list UI is intentionally generic. */
export const SCHEDULE_TEMPLATES: readonly ScheduleTemplate[] = [
  PR_STATUS_POLLER,
  WEEKLY_ARCH_REVIEW,
]

export function getScheduleTemplate(id: string): ScheduleTemplate | undefined {
  return SCHEDULE_TEMPLATES.find((template) => template.id === id)
}

export function findEnabledVendorAgent(
  agents: readonly AgentConfig[],
  vendor: 'claude',
): AgentConfig | undefined {
  return agents.find((agent) => agent.vendor === vendor && agent.enabled !== false)
}
