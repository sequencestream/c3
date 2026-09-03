import { describe, expect, it } from 'vitest'
import type {
  GenericEvent,
  PrBranchRef,
  PrEventAssociation,
  PrRef,
  PrRepo,
} from '@ccc/shared/event-model'
import type { AutomationTemplateBuildArgs } from './index'
import {
  ARCH_REVIEW_PROMPT,
  PR_STATUS_POLLER_PROMPT,
  WEEKLY_VULN_ANALYSIS_PROMPT,
  WEEKLY_WORKTREE_CLEANUP_PROMPT,
  PR_REVIEW_RUNNER_PROMPT,
  PR_REVIEW_FIX_PROMPT,
  TEMPLATE_MAX_WALL_CLOCK_MS,
  getAutomationTemplate,
} from './index'

/** Count physical lines in a template string, excluding leading/trailing blank lines. */
function countPhysicalLines(s: string): number {
  const trimmed = s.trim()
  if (!trimmed) return 0
  return trimmed.split('\n').length
}

describe('all templates', () => {
  const ids = [
    'pr-status-poller',
    'weekly-arch-review',
    'weekly-vuln-analysis',
    'weekly-worktree-cleanup',
    'pr-review-runner',
    'pr-review-fix',
    'custom-event-echo',
  ] as const

  it.each(ids)('%s exists and build() returns maxWallClockMs', (id) => {
    const template = getAutomationTemplate(id)
    expect(template).toBeDefined()
    const input = template!.build({ workspaceName: '/ws', agentId: 'a1' })
    expect(input.maxWallClockMs).toBe(TEMPLATE_MAX_WALL_CLOCK_MS)
  })

  it.each(ids)('%s has a registered titleKey and descriptionKey', (id) => {
    const template = getAutomationTemplate(id)
    expect(template).toBeDefined()
    expect(template!.titleKey).toMatch(/^automation\.list\.templates\./)
    expect(template!.descriptionKey).toMatch(/^automation\.list\.templates\./)
  })
})

describe('PR status poller automation template', () => {
  it('builds the enabled Claude reconciliation configuration', () => {
    const input = getAutomationTemplate('pr-status-poller')?.build({
      workspaceName: '/workspace',
      agentId: 'a1',
    })
    expect(input).toMatchObject({
      type: 'llm',
      vendor: 'claude',
      agentId: 'a1',
      cronExpression: '*/10 * * * *',
      mode: 'bypassPermissions',
      maxWallClockMs: 600_000,
    })
    expect(input?.toolAllowlist).toEqual(
      expect.arrayContaining([
        'Bash',
        'mcp__c3__find_intents',
        'mcp__c3__view_intent',
        'mcp__c3__publish_event',
      ]),
    )
  })

  it('grants the sync tool as the only PR-status write surface, decided by the forge', () => {
    // The forge-derived `sync_intent_pr_status` is the only PR-status write the
    // template grants: the allowlist and the prompt are one fact and must move
    // together, or the automation calls a tool it does not have — a silent loss of
    // the reconciliation it advertises.
    const input = getAutomationTemplate('pr-status-poller')?.build({
      workspaceName: '/workspace',
      agentId: 'a1',
    })
    expect(input?.toolAllowlist).toContain('mcp__c3__sync_intent_pr_status')
    expect(PR_STATUS_POLLER_PROMPT).toContain('mcp__c3__sync_intent_pr_status')
    // The prompt still never writes a status itself — c3 derives it from the forge
    // — and publish_event remains the subscription signal for downstream automations.
    expect(PR_STATUS_POLLER_PROMPT).toContain('never pass or assume a status value')
    expect(PR_STATUS_POLLER_PROMPT).toContain('publish_event')
  })

  it('prompt is ≤10 physical lines and retains core identifiers', () => {
    expect(countPhysicalLines(PR_STATUS_POLLER_PROMPT)).toBeLessThanOrEqual(10)
    expect(PR_STATUS_POLLER_PROMPT).toContain('reviewing')
    expect(PR_STATUS_POLLER_PROMPT).toContain('gh')
    expect(PR_STATUS_POLLER_PROMPT).toContain('merged')
    expect(PR_STATUS_POLLER_PROMPT).toContain('closed')
  })
})

describe('weekly architecture review automation template', () => {
  it('builds the Friday claude review configuration', () => {
    const input = getAutomationTemplate('weekly-arch-review')?.build({
      workspaceName: '/workspace',
      agentId: 'a1',
    })
    expect(input).toMatchObject({
      type: 'llm',
      vendor: 'claude',
      agentId: 'a1',
      cronExpression: '0 18 * * 5',
      mode: 'bypassPermissions',
      maxWallClockMs: 600_000,
    })
    expect(input?.toolAllowlist).toEqual(
      expect.arrayContaining([
        'Read',
        'Grep',
        'Glob',
        'Bash',
        'mcp__c3__find_intents',
        'mcp__c3__view_intent',
        'mcp__c3__save_intent_directly',
      ]),
    )
    // The directly-writing automation tool must NOT pull in the confirmation-gated save.
    expect(input?.toolAllowlist).not.toContain('mcp__c3__save_intents')
  })

  it('prompt is ≤10 lines and retains core scoring logic markers', () => {
    expect(countPhysicalLines(ARCH_REVIEW_PROMPT)).toBeLessThanOrEqual(10)
    expect(ARCH_REVIEW_PROMPT).toContain('7 DAYS')
    expect(ARCH_REVIEW_PROMPT).toContain('find_intents')
    expect(ARCH_REVIEW_PROMPT).toContain('draft')
    expect(ARCH_REVIEW_PROMPT).toContain('<=3')
    expect(ARCH_REVIEW_PROMPT).toContain('STRONG signals')
    expect(ARCH_REVIEW_PROMPT).toContain('PRODUCE INTENTS ONLY')
  })
})

describe('weekly vulnerability analysis automation template', () => {
  it('builds the Monday claude weekly configuration', () => {
    const input = getAutomationTemplate('weekly-vuln-analysis')?.build({
      workspaceName: '/workspace',
      agentId: 'a1',
    })
    expect(input).toMatchObject({
      type: 'llm',
      vendor: 'claude',
      agentId: 'a1',
      cronExpression: '0 9 * * 1',
      mode: 'bypassPermissions',
      maxWallClockMs: 600_000,
    })
    expect(input?.toolAllowlist).toEqual(
      expect.arrayContaining([
        'Read',
        'Grep',
        'Glob',
        'Bash',
        'mcp__c3__find_intents',
        'mcp__c3__view_intent',
        'mcp__c3__save_intent_directly',
      ]),
    )
    // Draft-writing template must NOT pull in the confirmation-gated save.
    expect(input?.toolAllowlist).not.toContain('mcp__c3__save_intents')
  })

  it('prompt is ≤10 lines and retains core security markers', () => {
    expect(countPhysicalLines(WEEKLY_VULN_ANALYSIS_PROMPT)).toBeLessThanOrEqual(10)
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('7 DAYS')
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('security')
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('vulnerability')
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('Injection')
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('find_intents')
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('DRAFT')
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('<=3')
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('PRODUCE INTENTS ONLY')
    // Hard boundary: analysis only, never auto-fix / commit / PR / full audit.
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain('never open a PR')
    expect(WEEKLY_VULN_ANALYSIS_PROMPT).toContain(
      'NOT a whole-repository historical security audit',
    )
  })
})

describe('weekly expired worktree cleanup automation template', () => {
  it('builds the Sunday claude cleanup configuration', () => {
    const template = getAutomationTemplate('weekly-worktree-cleanup')
    const input = template?.build({
      workspaceName: '/workspace',
      agentId: 'a1',
    })

    expect(template).toBeDefined()
    expect(input).toMatchObject({
      type: 'llm',
      vendor: 'claude',
      agentId: 'a1',
      cronExpression: '0 3 * * 0',
      mode: 'bypassPermissions',
      maxWallClockMs: 600_000,
    })
    expect(input?.toolAllowlist).toEqual(
      expect.arrayContaining([
        'Read',
        'Grep',
        'Glob',
        'Bash',
        'mcp__c3__find_intents',
        'mcp__c3__view_intent',
      ]),
    )
    expect(input?.toolAllowlist).not.toContain('mcp__c3__save_intents')
    expect(input?.toolAllowlist).not.toContain('mcp__c3__save_intent_directly')
  })

  it('prompt is ≤10 lines and retains core safety gates', () => {
    expect(countPhysicalLines(WEEKLY_WORKTREE_CLEANUP_PROMPT)).toBeLessThanOrEqual(10)
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('more than 7 days old')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('intent-')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('mcp__c3__view_intent')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('done or cancelled')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('orphan managed worktree')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('git status --porcelain')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain(
      '<c3-home>/worktrees/<projectDirName>/intent-*/',
    )
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('Never delete active-intent worktrees')
  })

  it('prompt retains conservative worktree and branch deletion behavior', () => {
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('git worktree remove')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('git branch -d')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('intent/')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('git ls-remote origin')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('git push origin --delete')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).toContain('Never use wildcards')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).not.toContain('git worktree remove -f')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).not.toContain('git worktree remove --force')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).not.toContain('git branch -D')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).not.toContain('mcp__c3__save_intents')
    expect(WEEKLY_WORKTREE_CLEANUP_PROMPT).not.toContain('mcp__c3__save_intent_directly')
  })
})

describe('PR review runner automation template', () => {
  it('builds the event-claude review configuration', () => {
    const input = getAutomationTemplate('pr-review-runner')?.build({
      workspaceName: '/workspace',
      agentId: 'a1',
    })
    expect(input).toMatchObject({
      type: 'llm',
      vendor: 'claude',
      agentId: 'a1',
      triggerType: 'event',
      cronExpression: '',
      mode: 'bypassPermissions',
      maxWallClockMs: 600_000,
    })
    expect((input?.config as Record<string, unknown>).embedEventContext).toBe(true)
    expect(input?.eventFilters).toEqual([
      { type: 'pr:create' },
      { type: 'pr:update', statuses: ['success'] },
    ])
    expect(input?.toolAllowlist).toEqual(
      expect.arrayContaining([
        'Read',
        'Grep',
        'Glob',
        'Bash',
        'mcp__c3__sync_intent_pr_status',
        'mcp__c3__publish_event',
      ]),
    )
    // Review-only: must NOT have file-edit or intent-saving tools.
    expect(input?.toolAllowlist).not.toContain('Edit')
    expect(input?.toolAllowlist).not.toContain('Write')
    expect(input?.toolAllowlist).not.toContain('mcp__c3__save_intents')
    expect(input?.toolAllowlist).not.toContain('mcp__c3__save_intent_directly')
  })

  it('prompt retains review-only identity — never modify files', () => {
    expect(PR_REVIEW_RUNNER_PROMPT).toContain('pr:review')
    expect(PR_REVIEW_RUNNER_PROMPT).toContain('publish_event')
    expect(PR_REVIEW_RUNNER_PROMPT).toContain('gh pr diff')
    expect(PR_REVIEW_RUNNER_PROMPT).toContain('Do not modify any files')
    // A forge-observed terminal state is reconciled through the sync tool, and the
    // tool name must match what the allowlist actually grants.
    expect(PR_REVIEW_RUNNER_PROMPT).toContain('mcp__c3__sync_intent_pr_status')
  })
})

describe('PR review fix automation template', () => {
  it('builds the event-claude fix configuration', () => {
    const input = getAutomationTemplate('pr-review-fix')?.build({
      workspaceName: '/workspace',
      agentId: 'a1',
    })
    expect(input).toMatchObject({
      type: 'llm',
      vendor: 'claude',
      agentId: 'a1',
      triggerType: 'event',
      cronExpression: '',
      mode: 'bypassPermissions',
      maxWallClockMs: 600_000,
    })
    expect((input?.config as Record<string, unknown>).embedEventContext).toBe(true)
    expect(input?.eventFilters).toEqual([{ type: 'pr:review', statuses: ['failure'] }])
    expect(input?.toolAllowlist).toEqual(
      expect.arrayContaining([
        'Read',
        'Grep',
        'Glob',
        'Bash',
        'Edit',
        'Write',
        'mcp__c3__sync_intent_pr_status',
        'mcp__c3__publish_event',
      ]),
    )
  })

  it('prompt retains fix identity — publish pr:update on success', () => {
    expect(PR_REVIEW_FIX_PROMPT).toContain('pr:update')
    expect(PR_REVIEW_FIX_PROMPT).toContain('publish_event')
    expect(PR_REVIEW_FIX_PROMPT).toContain('diagnose')
    expect(PR_REVIEW_FIX_PROMPT).toContain('fix')
    // A forge-observed terminal state is reconciled through the sync tool.
    expect(PR_REVIEW_FIX_PROMPT).toContain('mcp__c3__sync_intent_pr_status')
    // Fix prompt must allow editing unlike the runner.
    expect(PR_REVIEW_FIX_PROMPT).toContain('editing files')
    expect(PR_REVIEW_FIX_PROMPT).not.toContain('Do not modify any files')
  })
})

/**
 * The two PR templates embed their triggering event verbatim, so their prompts
 * must describe the real `pr:*` payload: `data` carries `{ pr, repo, ref,
 * association }` — the number is `data.pr.number`, the repository is
 * `data.repo.owner` / `data.repo.name`, and `association` holds intent linkage
 * only. Typing the fixture with the shared interfaces turns a schema change into
 * a compile error instead of a silently stale prompt.
 */
const PR_EVENT_DATA: {
  pr: PrRef
  repo: PrRepo
  ref: PrBranchRef
  association: PrEventAssociation
} = {
  pr: {
    number: 231,
    id: 'PR_kwABC',
    url: 'https://github.com/acme/demo/pull/231',
    title: 'feat: x',
    state: 'OPEN',
  },
  repo: { provider: 'github', host: 'github.com', owner: 'acme', name: 'demo' },
  ref: { head: 'feat/x', base: 'main' },
  association: { intentId: 'i-1', intentTitle: 'An intent' },
}

/**
 * What a SERVER-published `pr:create` actually looks like: only `pr.url`, `ref`
 * and `association.intentId` are filled in — no `pr.number` and no `repo` — so a
 * prompt that reads the number/repo directly must offer a recovery path.
 */
const SERVER_PR_CREATE_EVENT: GenericEvent = {
  type: 'pr:create',
  status: 'success',
  metadata: { operation: 'create' },
  data: {
    pr: { url: PR_EVENT_DATA.pr.url! },
    ref: { head: 'intent/abc-1', base: 'main' },
    association: { intentId: 'i-1' },
  },
}

/** Every `data.<container>.<field>` path the real event can carry. */
const VALID_EVENT_DATA_PATHS = new Set(
  Object.entries(PR_EVENT_DATA).flatMap(([container, fields]) =>
    Object.keys(fields).map((field) => `${container}.${field}`),
  ),
)

/** The `data.<container>.<field>` paths a prompt tells the agent to read. */
function referencedEventDataPaths(prompt: string): string[] {
  return [...prompt.matchAll(/\bdata\.([A-Za-z]+)\.([A-Za-z]+)\b/g)].map(
    (match) => `${match[1]}.${match[2]}`,
  )
}

describe('PR template prompts match the real pr:* event shape', () => {
  const prompts = [
    ['pr-review-runner', PR_REVIEW_RUNNER_PROMPT],
    ['pr-review-fix', PR_REVIEW_FIX_PROMPT],
  ] as const

  it.each(prompts)('%s only references event data paths that exist', (_id, prompt) => {
    const referenced = referencedEventDataPaths(prompt)
    expect(referenced.length).toBeGreaterThan(0)
    for (const path of referenced) expect(VALID_EVENT_DATA_PATHS).toContain(path)
  })

  it.each(prompts)('%s reads number and repo from the right containers', (_id, prompt) => {
    expect(prompt).toContain('data.pr.number')
    expect(prompt).toContain('data.repo.owner')
    expect(prompt).toContain('data.repo.name')
    // The association carries intent linkage only — never the PR number or repo.
    expect(prompt).not.toMatch(/\bpr\.owner\b/)
    expect(prompt).not.toMatch(/\bpr\.repo\b/)
    expect(prompt).not.toMatch(/association\.(number|owner|repo|name)\b/)
    expect(prompt).toContain('intentId')
  })

  it.each(prompts)('%s recovers the fields a server-published event omits', (_id, prompt) => {
    const data = SERVER_PR_CREATE_EVENT.data as Record<string, Record<string, unknown>>
    // Guard the premise: the server-side create path fills neither of these.
    expect(data.pr.number).toBeUndefined()
    expect(data.repo).toBeUndefined()
    // So the prompt must fall back to the URL, the local remote and a head-branch lookup.
    expect(prompt).toContain('data.pr.url')
    expect(prompt).toContain('gh repo view --json owner,name')
    expect(prompt).toContain('gh pr list --head')
    expect(prompt).toContain('data.ref.head')
  })
})

describe('custom event echo automation template', () => {
  it('builds the command echo configuration', () => {
    const input = getAutomationTemplate('custom-event-echo')?.build({
      workspaceName: '/workspace',
      agentId: '',
    })
    expect(input).toMatchObject({
      type: 'command',
      config: { command: 'echo hello' },
      vendor: 'claude',
      triggerType: 'event',
      cronExpression: '',
      mode: 'bypassPermissions',
      maxWallClockMs: 600_000,
    })
    // command template does NOT carry agentId.
    expect(input).not.toHaveProperty('agentId')
    expect(input?.eventFilters).toEqual([{ type: 'my:create-event' }])
    expect(input?.toolAllowlist).toEqual([])
  })

  it('does not carry LLM-specific tools', () => {
    const template = getAutomationTemplate('custom-event-echo')
    expect(template).toBeDefined()
    const input = template!.build({ workspaceName: '/workspace' } as AutomationTemplateBuildArgs)
    expect(input.toolAllowlist).toEqual([])
    expect(input.type).toBe('command')
    expect(input.config).not.toHaveProperty('prompt')
    expect(input.config).toHaveProperty('command')
  })
})
