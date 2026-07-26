/**
 * Tests for the four discussion tools exposed to automation LLM execution.
 * Contracts:
 *  - find: workspace + status filtering, slim fields only.
 *  - view: detail + seq-ordered messages; not-found / cross-workspace → isError.
 *  - start: only a `draft` with no live run; non-draft / live-run → isError.
 *  - continue: `completed` appends a human follow-up and starts a new run;
 *    `in_progress` + no live run RECOVERS without appending; draft / cancelled /
 *    live-run / empty follow-up → isError.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Identity id↔path mapping: synthetic test workspaces are unregistered.
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))
import type { Discussion } from '@ccc/shared/protocol'
import {
  MAX_AUTOMATION_METADATA_ENTRIES,
  MAX_AUTOMATION_METADATA_KEY_LEN,
  MAX_AUTOMATION_METADATA_VALUE_LEN,
} from '@ccc/shared'
import { resetDbForTests } from '../../kernel/infra/db.js'
import {
  appendMessage,
  createDiscussion,
  getDiscussion,
  listMessages,
  resetStoreForTests,
  setAgenda,
  updateDiscussionStatus,
} from './store.js'
import {
  runContinueDiscussion,
  runFindDiscussions,
  runStartDiscussion,
  runViewDiscussion,
  type ContinueDiscussionDeps,
  type DiscussionRunStarter,
  type StartDiscussionArgs,
} from './tool-defs.js'

const proj = '/abs/disc-tool-proj'
const otherProj = '/abs/disc-tool-other'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-disc-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

/** A run starter whose `hasDiscussionRun` is toggleable and `startDiscussionRun` records calls. */
function makeRunStarter(live = false): DiscussionRunStarter & {
  started: Discussion[]
  live: boolean
} {
  const state = {
    live,
    started: [] as Discussion[],
    hasDiscussionRun: () => state.live,
    startDiscussionRun: (d: Discussion) => {
      state.started.push(d)
    },
  }
  return state
}

function makeContinueDeps(live = false): ContinueDiscussionDeps & {
  started: Discussion[]
  messages: string[]
  refreshed: string[]
} {
  const base = makeRunStarter(live)
  const messages: string[] = []
  const refreshed: string[] = []
  return {
    ...base,
    hasDiscussionRun: base.hasDiscussionRun,
    startDiscussionRun: base.startDiscussionRun,
    broadcastDiscussionMessage: (_id, m) => messages.push(m.content),
    broadcastDiscussions: (p) => refreshed.push(p),
    messages,
    refreshed,
  }
}

function seed(workspacePath: string, title: string): Discussion {
  return createDiscussion({ workspacePath, title, type: 'general', goal: title })
}

describe('runFindDiscussions', () => {
  it('filters by workspace and status, returning slim fields only', () => {
    const draft = seed(proj, 'Draft one')
    const done = seed(proj, 'Done one')
    updateDiscussionStatus(done.id, 'completed')
    seed(otherProj, 'Other workspace')

    const all = runFindDiscussions(proj, {})
    expect(all.isError).toBeFalsy()
    expect(all.content[0].text).toContain('找到 2 条讨论')
    expect(all.content[0].text).toContain(draft.id)
    expect(all.content[0].text).toContain(done.id)
    // No cross-workspace leak.
    expect(all.content[0].text).not.toContain('Other workspace')
    // Slim: no full message body field.
    expect(all.content[0].text).not.toContain('messages')

    const onlyCompleted = runFindDiscussions(proj, { status: 'completed' })
    expect(onlyCompleted.content[0].text).toContain(done.id)
    expect(onlyCompleted.content[0].text).not.toContain(draft.id)
  })

  it('reports no matches for an empty workspace', () => {
    const res = runFindDiscussions(proj, {})
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('未找到匹配的讨论')
  })
})

describe('runViewDiscussion', () => {
  it('returns detail + seq-ordered messages for an owned discussion', () => {
    const d = seed(proj, 'Viewable')
    appendMessage({ discussionId: d.id, speakerKind: 'human', speakerName: 'Human', content: 'hi' })
    appendMessage({
      discussionId: d.id,
      speakerKind: 'organizer',
      speakerName: 'Org',
      content: 'reply',
    })
    const res = runViewDiscussion(proj, { discussionId: d.id })
    expect(res.isError).toBeFalsy()
    const parsed = JSON.parse(res.content[0].text) as {
      discussion: Discussion
      messages: Array<{ seq: number; content: string }>
    }
    expect(parsed.discussion.id).toBe(d.id)
    expect(parsed.messages.map((m) => m.content)).toEqual(['hi', 'reply'])
    expect(parsed.messages[0].seq).toBeLessThan(parsed.messages[1].seq)
  })

  it('rejects a cross-workspace discussion (isError)', () => {
    const d = seed(otherProj, 'Foreign')
    const res = runViewDiscussion(proj, { discussionId: d.id })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain(d.id)
  })

  it('rejects an unknown id (isError)', () => {
    const res = runViewDiscussion(proj, { discussionId: 'nope' })
    expect(res.isError).toBe(true)
  })
})

describe('runStartDiscussion', () => {
  it('starts a draft with no live run', () => {
    const d = seed(proj, 'Startable')
    const deps = makeRunStarter()
    const res = runStartDiscussion(proj, { discussionId: d.id }, deps)
    expect(res.isError).toBeFalsy()
    expect(deps.started.map((x) => x.id)).toEqual([d.id])
  })

  it('rejects a non-draft discussion', () => {
    const d = seed(proj, 'Already running')
    updateDiscussionStatus(d.id, 'in_progress')
    const deps = makeRunStarter()
    const res = runStartDiscussion(proj, { discussionId: d.id }, deps)
    expect(res.isError).toBe(true)
    expect(deps.started).toHaveLength(0)
  })

  it('rejects a draft that already has a live run', () => {
    const d = seed(proj, 'Live draft')
    const deps = makeRunStarter(true)
    const res = runStartDiscussion(proj, { discussionId: d.id }, deps)
    expect(res.isError).toBe(true)
    expect(deps.started).toHaveLength(0)
  })

  it('rejects a cross-workspace discussion', () => {
    const d = seed(otherProj, 'Foreign draft')
    const deps = makeRunStarter()
    const res = runStartDiscussion(proj, { discussionId: d.id }, deps)
    expect(res.isError).toBe(true)
    expect(deps.started).toHaveLength(0)
  })
})

describe('runStartDiscussion — metadata', () => {
  /** The discussion's persisted metadata, read straight back out of the store. */
  const persisted = (id: string): Record<string, string> => getDiscussion(id)!.metadata

  it('omitted metadata leaves the discussion at its default empty map', () => {
    const d = seed(proj, 'No metadata')
    const deps = makeRunStarter()
    expect(runStartDiscussion(proj, { discussionId: d.id }, deps).isError).toBeFalsy()
    expect(persisted(d.id)).toEqual({})
    expect(deps.started[0].metadata).toEqual({})
  })

  it('persists a valid map before starting, and the started snapshot carries it', () => {
    const d = seed(proj, 'With metadata')
    const deps = makeRunStarter()
    const res = runStartDiscussion(
      proj,
      { discussionId: d.id, metadata: { team: 'infra', ticket: 'C3-42' } },
      deps,
    )
    expect(res.isError).toBeFalsy()
    expect(persisted(d.id)).toEqual({ team: 'infra', ticket: 'C3-42' })
    expect(deps.started[0].metadata).toEqual({ team: 'infra', ticket: 'C3-42' })
  })

  it('is readable back through view_discussion', () => {
    const d = seed(proj, 'Readable')
    runStartDiscussion(proj, { discussionId: d.id, metadata: { team: 'infra' } }, makeRunStarter())
    const view = runViewDiscussion(proj, { discussionId: d.id })
    expect(view.isError).toBeFalsy()
    const parsed = JSON.parse(view.content[0].text) as { discussion: Discussion }
    expect(parsed.discussion.metadata).toEqual({ team: 'infra' })
  })

  it('accepts the exact capacity / length boundaries', () => {
    const d = seed(proj, 'Boundary')
    const metadata: Record<string, string> = {}
    for (let i = 0; i < MAX_AUTOMATION_METADATA_ENTRIES; i++) metadata[`k${i}`] = 'v'
    metadata.k0 = 'x'.repeat(MAX_AUTOMATION_METADATA_VALUE_LEN)
    const longKey = 'k'.repeat(MAX_AUTOMATION_METADATA_KEY_LEN)
    delete metadata[`k${MAX_AUTOMATION_METADATA_ENTRIES - 1}`]
    metadata[longKey] = 'v'
    const deps = makeRunStarter()
    expect(
      runStartDiscussion(proj, { discussionId: d.id, metadata }, deps).isError,
    ).toBeFalsy()
    expect(Object.keys(persisted(d.id))).toHaveLength(MAX_AUTOMATION_METADATA_ENTRIES)
    expect(persisted(d.id)[longKey]).toBe('v')
  })

  it('trims keys/values and drops entries that trim to empty (hygiene, not an error)', () => {
    const d = seed(proj, 'Hygiene')
    const deps = makeRunStarter()
    const res = runStartDiscussion(
      proj,
      { discussionId: d.id, metadata: { '  team  ': '  infra  ', blank: '   ', '  ': 'v' } },
      deps,
    )
    expect(res.isError).toBeFalsy()
    expect(persisted(d.id)).toEqual({ team: 'infra' })
  })

  /** Every rejection must leave the record untouched AND never call the starter. */
  const rejects = (label: string, metadata: unknown): void => {
    it(`rejects ${label} — isError, nothing written, nothing started`, () => {
      const d = seed(proj, `Reject ${label}`)
      const deps = makeRunStarter()
      const res = runStartDiscussion(
        proj,
        { discussionId: d.id, metadata } as StartDiscussionArgs,
        deps,
      )
      expect(res.isError).toBe(true)
      expect(persisted(d.id)).toEqual({})
      expect(deps.started).toHaveLength(0)
    })
  }

  const overCapacity: Record<string, string> = {}
  for (let i = 0; i <= MAX_AUTOMATION_METADATA_ENTRIES; i++) overCapacity[`k${i}`] = 'v'

  rejects('an over-capacity map', overCapacity)
  rejects('an over-long key', { ['k'.repeat(MAX_AUTOMATION_METADATA_KEY_LEN + 1)]: 'v' })
  rejects('an over-long value', { k: 'x'.repeat(MAX_AUTOMATION_METADATA_VALUE_LEN + 1) })
  rejects('a nested object value', { k: { nested: 'v' } })
  rejects('a non-string (number) value', { k: 1 })
  rejects('an array input', ['a', 'b'])

  it('validates BEFORE the discussion lookup — a bad map on an unknown id still errors', () => {
    const deps = makeRunStarter()
    const res = runStartDiscussion(
      proj,
      { discussionId: 'nope', metadata: { k: 1 } } as unknown as StartDiscussionArgs,
      deps,
    )
    expect(res.isError).toBe(true)
    expect(deps.started).toHaveLength(0)
  })

  it('continue_discussion never rewrites the persisted metadata', () => {
    const d = seed(proj, 'Continued')
    runStartDiscussion(proj, { discussionId: d.id, metadata: { team: 'infra' } }, makeRunStarter())
    updateDiscussionStatus(d.id, 'completed')
    const deps = makeContinueDeps()
    expect(
      runContinueDiscussion(proj, { discussionId: d.id, text: '再来一轮' }, deps).isError,
    ).toBeFalsy()
    expect(persisted(d.id)).toEqual({ team: 'infra' })
    expect(deps.started[0].metadata).toEqual({ team: 'infra' })
  })
})

describe('runContinueDiscussion', () => {
  it('completed → appends a human follow-up and starts a new run', () => {
    const d = seed(proj, 'Concluded')
    updateDiscussionStatus(d.id, 'completed')
    const deps = makeContinueDeps()
    const res = runContinueDiscussion(proj, { discussionId: d.id, text: '再深入一点' }, deps)
    expect(res.isError).toBeFalsy()
    expect(deps.messages).toEqual(['再深入一点'])
    expect(listMessages(d.id).map((m) => m.content)).toEqual(['再深入一点'])
    expect(deps.refreshed).toEqual([proj])
    expect(deps.started).toHaveLength(1)
    expect(deps.started[0].status).toBe('in_progress')
  })

  it('completed with empty follow-up → isError, no run, no message', () => {
    const d = seed(proj, 'Concluded empty')
    updateDiscussionStatus(d.id, 'completed')
    const deps = makeContinueDeps()
    const res = runContinueDiscussion(proj, { discussionId: d.id, text: '   ' }, deps)
    expect(res.isError).toBe(true)
    expect(deps.started).toHaveLength(0)
    expect(listMessages(d.id)).toHaveLength(0)
  })

  it('in_progress with no live run → RECOVERS without appending a message', () => {
    const d = seed(proj, 'Dangling')
    updateDiscussionStatus(d.id, 'in_progress')
    setAgenda(d.id, ['a', 'b', 'c'], 1)
    const deps = makeContinueDeps()
    const res = runContinueDiscussion(proj, { discussionId: d.id }, deps)
    expect(res.isError).toBeFalsy()
    expect(deps.messages).toHaveLength(0)
    expect(listMessages(d.id)).toHaveLength(0)
    expect(deps.started).toHaveLength(1)
    // Resumes from the persisted record (agenda position preserved).
    expect(deps.started[0].id).toBe(d.id)
    expect(deps.started[0].agendaIndex).toBe(1)
    expect(deps.started[0].status).toBe('in_progress')
  })

  it('in_progress WITH a live run → isError (no double start)', () => {
    const d = seed(proj, 'Live in_progress')
    updateDiscussionStatus(d.id, 'in_progress')
    const deps = makeContinueDeps(true)
    const res = runContinueDiscussion(proj, { discussionId: d.id }, deps)
    expect(res.isError).toBe(true)
    expect(deps.started).toHaveLength(0)
  })

  it('draft → isError', () => {
    const d = seed(proj, 'Still draft')
    const deps = makeContinueDeps()
    const res = runContinueDiscussion(proj, { discussionId: d.id, text: 'x' }, deps)
    expect(res.isError).toBe(true)
    expect(deps.started).toHaveLength(0)
  })

  it('cancelled → isError', () => {
    const d = seed(proj, 'Cancelled')
    updateDiscussionStatus(d.id, 'cancelled')
    const deps = makeContinueDeps()
    const res = runContinueDiscussion(proj, { discussionId: d.id }, deps)
    expect(res.isError).toBe(true)
    expect(deps.started).toHaveLength(0)
  })

  it('cross-workspace → isError', () => {
    const d = seed(otherProj, 'Foreign completed')
    updateDiscussionStatus(d.id, 'completed')
    const deps = makeContinueDeps()
    const res = runContinueDiscussion(proj, { discussionId: d.id, text: 'x' }, deps)
    expect(res.isError).toBe(true)
    expect(deps.started).toHaveLength(0)
  })
})
