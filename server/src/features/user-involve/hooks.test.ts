/**
 * `createPermissionRequestHandler` — the CREATE side of the wait-user-involve
 * lifecycle. Asserts the handler persists an event with the caller-provided
 * `source` (NOT a hard-coded 'session') and broadcasts the refreshed todo list,
 * so a codex intent prompt lands in WorkCenter under the right tab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AnyConsensusOutcome,
  ServerToClient,
  WaitUserInvolveSource,
} from '@ccc/shared/protocol'
// The store maps `workspace_path` → opaque `workspaceId` via `pathToId`, dropping
// rows whose workspace is unregistered. These synthetic test paths are unregistered,
// so mock `pathToId` as identity (mirrors store.test.ts) — events stay listable.
vi.mock('../../state.js', () => ({ pathToId: (p: string) => p }))
import { resetDbForTests } from '../../kernel/infra/db.js'
import { listEvents, resetStoreForTests } from './store.js'
import { createConsensusAutoHandler, createPermissionRequestHandler } from './hooks.js'
import type { ConsensusAutoCtx, PermissionRequestCtx } from '../../kernel/permission/index.js'

const proj = '/abs/hooks-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-hooks-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

function ctx(
  source: WaitUserInvolveSource,
  over: Partial<PermissionRequestCtx> = {},
): PermissionRequestCtx {
  return {
    requestId: 'req-1',
    toolName: 'mcp__c3__save_intents',
    input: { intents: [] },
    sessionId: 'sess-1',
    workspacePath: proj,
    source,
    ...over,
  }
}

describe('createPermissionRequestHandler', () => {
  it('persists an event with the caller-provided source and broadcasts the todo list', () => {
    const sent: ServerToClient[] = []
    const handler = createPermissionRequestHandler({
      broadcaster: { toAll: (m: ServerToClient) => sent.push(m) } as never,
    })

    handler(ctx('intent'))

    const events = listEvents(proj, 'todo')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      source: 'intent',
      sourceId: 'sess-1',
      requestId: 'req-1',
      toolName: 'mcp__c3__save_intents',
      status: 'todo',
    })
    // Broadcast carries the refreshed list.
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ type: 'wait_user_events' })
  })

  it('honours source=work (no longer hard-coded)', () => {
    const handler = createPermissionRequestHandler({ broadcaster: { toAll: vi.fn() } as never })
    handler(ctx('work', { requestId: 'req-2', sessionId: 'work-9' }))
    const events = listEvents(proj, 'todo')
    expect(events).toHaveLength(1)
    expect(events[0].source).toBe('work')
  })

  it('honours source=spec (spec-authoring prompts no longer collapse to a session)', () => {
    const handler = createPermissionRequestHandler({ broadcaster: { toAll: vi.fn() } as never })
    handler(ctx('spec', { requestId: 'req-3', sessionId: 'spec-7' }))
    const events = listEvents(proj, 'todo')
    expect(events).toHaveLength(1)
    expect(events[0].source).toBe('spec')
  })
})

const toolOutcome: AnyConsensusOutcome = {
  kind: 'tool',
  votes: [{ agentId: 'a2', agentName: 'Reviewer', decision: 'allow', reason: 'safe edit' }],
  summary: 'All voters allowed',
  unanimous: true,
  decision: 'allow',
}

function autoCtx(over: Partial<ConsensusAutoCtx> = {}): ConsensusAutoCtx {
  return {
    requestId: 'auto-1',
    toolName: 'edit_file',
    input: { path: 'a.ts' },
    sessionId: 'sess-auto',
    workspacePath: proj,
    source: 'work',
    outcome: toolOutcome,
    ...over,
  }
}

describe('createConsensusAutoHandler', () => {
  it("records a non-blocking 'auto' event carrying the consensus outcome", () => {
    const handler = createConsensusAutoHandler()
    handler(autoCtx())

    // It is NOT a todo (never bumps the badge) — it lands under the 'auto' status.
    expect(listEvents(proj, 'todo')).toHaveLength(0)
    const autos = listEvents(proj, 'auto')
    expect(autos).toHaveLength(1)
    expect(autos[0]).toMatchObject({
      status: 'auto',
      source: 'work',
      sourceId: 'sess-auto',
      toolName: 'edit_file',
    })
    expect(autos[0].outcome).toEqual(toolOutcome)
  })

  it('round-trips an ask-consensus outcome', () => {
    const askOutcome: AnyConsensusOutcome = {
      kind: 'ask',
      perQuestion: [
        {
          index: 0,
          question: 'Proceed?',
          header: 'Proceed',
          multiSelect: false,
          answers: [],
          unanimous: true,
          agreed: 'Yes',
        },
      ],
      fullyUnanimous: true,
      agreedAnswers: { Proceed: 'Yes' },
      summary: 'Agreed',
    }
    const handler = createConsensusAutoHandler()
    handler(autoCtx({ toolName: 'AskUserQuestion', outcome: askOutcome }))
    const autos = listEvents(proj, 'auto')
    expect(autos).toHaveLength(1)
    expect(autos[0].outcome).toEqual(askOutcome)
  })
})
