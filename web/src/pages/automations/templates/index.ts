import type { AgentConfig, CreateAutomationInput } from '@ccc/shared/protocol'

export interface AutomationTemplateBuildArgs {
  workspaceId: string
  agentId: string
}

export interface AutomationTemplate {
  id: string
  titleKey:
    | 'automation.list.templates.prPoller.title'
    | 'automation.list.templates.archReview.title'
    | 'automation.list.templates.vulnAnalysis.title'
    | 'automation.list.templates.worktreeCleanup.title'
  descriptionKey:
    | 'automation.list.templates.prPoller.description'
    | 'automation.list.templates.archReview.description'
    | 'automation.list.templates.vulnAnalysis.description'
    | 'automation.list.templates.worktreeCleanup.description'
  build(args: AutomationTemplateBuildArgs): CreateAutomationInput
}

export const PR_STATUS_POLLER_PROMPT = `Reconcile GitHub PR status for this workspace.

1. Find candidate intents, inspect each candidate, and process only intents whose prStatus is reviewing and which have a prUrl or prId.
2. Use Bash with gh to query the real GitHub PR status. Do not change intents whose PR is still open/reviewing.
3. If a PR is merged, call save_intent_pr_info with prStatus "merged" and done true. If it is closed without merging, call save_intent_pr_info with prStatus "closed" and leave done unset.
4. Only when a status actually changed, call publish_pr_event with result "success", operation "merge" or "close", the PR identity/state, and association.intentId.

Do not reopen PRs, merge PRs, resolve conflicts, or change intents outside this reconciliation.`

const PR_STATUS_POLLER: AutomationTemplate = {
  id: 'pr-status-poller',
  titleKey: 'automation.list.templates.prPoller.title',
  descriptionKey: 'automation.list.templates.prPoller.description',
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

const WEEKLY_ARCH_REVIEW: AutomationTemplate = {
  id: 'weekly-arch-review',
  titleKey: 'automation.list.templates.archReview.title',
  descriptionKey: 'automation.list.templates.archReview.description',
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

export const WEEKLY_VULN_ANALYSIS_PROMPT = `You are the weekly security-vulnerability analyst for this workspace. Review the LAST 7 DAYS of git activity and turn only the highest-value, confirmed security findings into DRAFT intents for human review. You NEVER change code.

WINDOW (incremental only, never a full audit)
- Use Bash with git to inspect the recent window, e.g. \`git log --since="7 days ago" --stat\` and the matching diffs (\`git diff\`-equivalent ranges). Look ONLY at code introduced or changed this week — this is NOT a whole-repository historical security audit.

VULNERABILITY CLASSES (what counts as a "vulnerability")
- Injection: SQL injection, command/shell injection, path traversal, unsafe deserialization, template/eval injection.
- Authentication / authorization bypass: missing or weak auth checks, broken access control, privilege escalation, IDOR.
- Secret / credential leakage: hardcoded tokens, keys, passwords, or connection strings committed this week; secrets logged or exposed over the wire.
- Sandbox escape / scope-of-authority violation: breaking out of the sandbox or worktree boundary, tool-allowlist bypass, executing untrusted input with elevated capability.
- Same-class security defects newly introduced in this week's code (e.g. unvalidated input on a security-relevant path, SSRF, missing output encoding/XSS).

GROUND TRUTH
- Read the readable project docs with the Read tool when judging a finding — e.g. doc/constitution.md, doc/architecture/architecture.md, and the relevant doc/domains/ and doc/non-functional/ security material — so a report reflects the system's real trust boundaries.

MUST EXCLUDE (not a vulnerability — noise)
- General code quality, style, naming, formatting, or architecture/design suggestions — those belong to lint/format and the architecture review, NOT here.
- One-off scripts, test fixtures, soon-to-be-removed code, and purely theoretical issues with no reachable exploit path.
- Speculative findings you cannot tie to concrete changed lines/commits this week.

DE-DUPLICATE FIRST
- Before filing ANYTHING, call find_intents to search existing intents (by keyword/module/CWE-like term). If a candidate is already covered by an existing intent, SKIP it. Use view_intent when you need to confirm overlap.

CONTROL VOLUME / ACCEPT FALSE POSITIVES
- Model analysis can be wrong. File at most 3 intents this run (<=3, prefer fewer; quality over quantity). Everything lands as a DRAFT for human confirmation — never assume a finding is real without evidence, and never push it straight into development.

OUTPUT
- Call save_intent_directly to create each surviving candidate as a DRAFT intent (it lands as draft for human review/activation — there is no confirmation popup). Write a clear title, a concise English shortEnTitle, and content stating the evidence (which files/commits this week, the vulnerability class, the concrete attack/impact) plus a concrete acceptance criterion for the fix.
- PRODUCE INTENTS ONLY. Never write/edit files, never refactor, never commit, never open a PR, never run change commands. Bash is only for reading git history and project docs.`

const WEEKLY_VULN_ANALYSIS: AutomationTemplate = {
  id: 'weekly-vuln-analysis',
  titleKey: 'automation.list.templates.vulnAnalysis.title',
  descriptionKey: 'automation.list.templates.vulnAnalysis.description',
  build: ({ workspaceId, agentId }) => ({
    type: 'llm',
    config: { prompt: WEEKLY_VULN_ANALYSIS_PROMPT },
    workspaceId,
    agentId,
    vendor: 'claude',
    triggerType: 'cron',
    cronExpression: '0 9 * * 1',
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

export const WEEKLY_WORKTREE_CLEANUP_PROMPT = `You are the weekly expired c3 worktree cleanup runner for this workspace.

GOAL
- Delete only c3-managed worktrees under <c3-home>/worktrees/<projectDirName>/intent-*/ when they are stale and safe.
- A worktree is stale only when its last change is more than 7 days old.
- Always report every deleted and skipped worktree with the path, parsed intent ID when available, branch name when available, and the exact reason or cleanup outcome.

DISCOVERY
1. Determine the workspace project root and c3 home used by this c3 installation.
2. Inspect only directories matching <c3-home>/worktrees/<projectDirName>/intent-*/.
3. Ignore every path outside that managed prefix. Never inspect or delete user-created worktrees elsewhere.

PER-WORKTREE DECISION TREE
For each candidate directory:
1. Verify it is a valid git worktree by checking for a .git marker. If missing, skip with reason "broken worktree entry".
2. Compute lastChange as the newest of:
   - git log -1 --format=%ct HEAD
   - mtimes for dirty, staged, or untracked files reported by git status --porcelain
   If no commit or file-change signal exists, skip with reason "no reliable age signal".
3. If now - lastChange is less than or equal to 7 days, skip with reason "recent changes".
4. Run git status --porcelain. If output is non-empty, skip with reason "uncommitted changes".
5. Extract the UUID from the intent-<uuid> directory name.
6. Call mcp__c3__view_intent for that UUID when it is present:
   - If the intent exists and its status is done or cancelled, continue.
   - If the intent exists with any other status, skip with reason "intent active".
   - If the intent is missing or the lookup cannot find a row, continue and record that the worktree is an orphan managed worktree.
   - If the lookup fails for another reason, skip with reason "intent lookup failed".
7. Read the current branch with git rev-parse --abbrev-ref HEAD. Continue only when the branch starts with intent/. Skip protected, ambiguous, detached, or non-c3 branch names with reason "branch not c3-managed".
8. Delete the worktree with git worktree remove <path>. If it fails, skip remaining cleanup for that worktree and log the failure.
9. Delete the local branch from the project root with git branch -d <branch>. If it fails, log the branch deletion failure and do not attempt remote deletion for that branch.
10. If local branch deletion succeeded, check whether origin has exactly the same remote branch using git ls-remote origin <branch>. If it exists, run git push origin --delete <branch>. If it does not exist or the push fails, log that outcome and continue.

SAFETY RULES
- Never delete a worktree with uncommitted, staged, or untracked changes.
- Never delete active-intent worktrees.
- Never delete branches unless the name starts with intent/ and the local branch was associated with the removed worktree.
- Never use force flags for worktree or branch deletion.
- Never use wildcards or glob branch deletion.
- Continue processing remaining worktrees after a skip or cleanup failure.

FINAL LOG
Finish with a concise summary:
- deleted count
- skipped count
- local branches deleted
- remote branches deleted
- remote branch deletions skipped or failed`

const WEEKLY_WORKTREE_CLEANUP: AutomationTemplate = {
  id: 'weekly-worktree-cleanup',
  titleKey: 'automation.list.templates.worktreeCleanup.title',
  descriptionKey: 'automation.list.templates.worktreeCleanup.description',
  build: ({ workspaceId, agentId }) => ({
    type: 'llm',
    config: { prompt: WEEKLY_WORKTREE_CLEANUP_PROMPT },
    workspaceId,
    agentId,
    vendor: 'claude',
    triggerType: 'cron',
    cronExpression: '0 3 * * 0',
    mode: 'bypassPermissions',
    toolAllowlist: [
      'Read',
      'Grep',
      'Glob',
      'Bash',
      'mcp__c3__find_intents',
      'mcp__c3__view_intent',
    ],
  }),
}

/** Register new automation templates here; the list UI is intentionally generic. */
export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  PR_STATUS_POLLER,
  WEEKLY_ARCH_REVIEW,
  WEEKLY_VULN_ANALYSIS,
  WEEKLY_WORKTREE_CLEANUP,
]

export function getAutomationTemplate(id: string): AutomationTemplate | undefined {
  return AUTOMATION_TEMPLATES.find((template) => template.id === id)
}

export function findEnabledVendorAgent(
  agents: readonly AgentConfig[],
  vendor: 'claude',
): AgentConfig | undefined {
  return agents.find((agent) => agent.vendor === vendor && agent.enabled !== false)
}
