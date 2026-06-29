/**
 * Integration tests for the `save_intents` MCP tool handler (US-4).
 *
 * The handler now owns its confirmation gate (`gatedSave`): it emits a
 * `permission_request`, blocks on the user's decision, and persists only on
 * `allow`. The persistence tests use {@link mkServer} (an auto-allow gate) to
 * exercise the post-confirmation contract — persist via the store, notify via
 * `broadcastIntents`, return a `CallToolResult` (with `isError` on failure /
 * db-unavailable). A separate block drives the gate itself (allow / deny /
 * ordering), proving the handler is the single confirmation point and therefore
 * immune to a vendor allow-rule that would skip `canUseTool`.
 *
 * We drive the real handler the SDK registered (`instance._registeredTools`),
 * not a re-implementation, so the test fails if the tool's wiring changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Stub only the registry id↔path mapping (identity): synthetic test workspaces
// are unregistered, so resolve/pathToId would otherwise return null.
vi.mock('../../state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../state.js')>()),
  resolveWorkspaceRoot: (id: string) => id,
  pathToId: (p: string) => p,
}))
import { z } from 'zod'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { Intent } from '@ccc/shared/protocol'
import { resetDbForTests } from '../../kernel/infra/db.js'
import { createIntentMcpServer } from './save-tool.js'
import { saveIntentDirectlySchema, saveSchema } from './tool-defs.js'
import { getIntent, insertIntents, listIntents, resetStoreForTests, updateStatus } from './store.js'

interface CallToolResult {
  content: { type: string; text: string }[]
  isError?: boolean
}
type Handler = (args: unknown, extra: unknown) => Promise<CallToolResult>

/** Reach into the SDK MCP server instance for an actual registered tool handler. */
function getHandler(servers: Record<string, McpServerConfig>, toolName: string): Handler {
  // The `c3` server config carries the live MCP server `instance`; its
  // `_registeredTools` map holds the handler the SDK will invoke for a tool call.
  const c3 = servers.c3 as unknown as {
    instance: { _registeredTools: Record<string, { handler: Handler }> }
  }
  return c3.instance._registeredTools[toolName].handler
}

function getSaveHandler(servers: Record<string, McpServerConfig>): Handler {
  return getHandler(servers, 'save_intents')
}

/**
 * Build the c3 server with a save gate that auto-ALLOWS — the post-confirmation
 * path the persistence tests exercise. `onSaved` maps to the gate's
 * `broadcastIntents` (the refresh callback), so the existing assertions about the
 * broadcast firing with the project path stay valid. The save handler now runs
 * `gatedSave` itself (codex-parity), so a confirmed save needs `waitForDecision`
 * to resolve `allow`.
 */
function mkServer(
  workspacePath: string,
  onSaved: (p: string) => void = () => {},
): Record<string, McpServerConfig> {
  return createIntentMcpServer(
    { workspacePath, getRunId: () => 'run-1', signal: new AbortController().signal },
    {
      emit: () => {},
      waitForDecision: async () => ({ decision: 'allow' }),
      broadcastIntents: onSaved,
      onPermissionRequest: () => {},
    },
  )
}

const proj = '/abs/save-tool-proj'
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'c3-save-'))
  process.env.C3_DB_PATH = join(dir, 'c3.db')
  resetDbForTests()
  resetStoreForTests()
})

afterEach(() => {
  resetDbForTests()
  delete process.env.C3_DB_PATH
  rmSync(dir, { recursive: true, force: true })
})

describe('save_intents tool handler', () => {
  it('exposes the tool on the c3 server (mcp__c3__save_intents)', () => {
    // AC-4.1: the agent submits via a tool named save_intents on server `c3`.
    const servers = mkServer(proj)
    expect(Object.keys(servers)).toEqual(['c3'])
    const c3 = servers.c3 as unknown as {
      name: string
      instance: { _registeredTools: Record<string, unknown> }
    }
    expect(c3.name).toBe('c3')
    expect(Object.keys(c3.instance._registeredTools)).toContain('save_intents')
  })

  it('marks the tool always-load so it stays resident (no ToolSearch before save)', () => {
    // ADR 0007: the intent agent must not have to ToolSearch `save_intents`
    // back before every save. `createSdkMcpServer({ alwaysLoad: true })` stamps
    // `_meta['anthropic/alwaysLoad'] = true` on each registered tool (≡ API
    // `defer_loading: false`), keeping the schema in the turn-1 prompt. Asserting
    // the meta — not just the tool's existence — guards the deferral behaviour.
    const servers = mkServer(proj)
    const c3 = servers.c3 as unknown as {
      instance: { _registeredTools: Record<string, { _meta?: Record<string, unknown> }> }
    }
    expect(c3.instance._registeredTools.save_intents._meta).toMatchObject({
      'anthropic/alwaysLoad': true,
    })
  })

  it('persists a confirmed batch as todo, calls onSaved, returns a success result', async () => {
    // AC-4.3 / AC-4.4: reaching the handler == user allowed; rows land as `todo`,
    // scoped to the project; onSaved fires so the server can broadcast a refresh.
    const onSaved = vi.fn()
    const handler = getSaveHandler(mkServer(proj, onSaved))

    const res = await handler(
      {
        intents: [
          { title: 'Login', shortEnTitle: 'auto', content: 'auth flow', priority: 'P0' },
          {
            title: 'Logout',
            shortEnTitle: 'auto',
            content: 'end session',
            priority: 'P1',
            dependsOn: ['x'],
          },
        ],
      },
      {},
    )

    expect(res.isError).toBeFalsy()
    expect(res.content[0].type).toBe('text')
    expect(res.content[0].text).toContain('已保存 2 条意图')
    expect(res.content[0].text).toContain('Login')

    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onSaved).toHaveBeenCalledWith(proj)

    const saved = listIntents(proj)
    expect(saved.map((r) => r.title).sort()).toEqual(['Login', 'Logout'])
    expect(saved.every((r: Intent) => r.status === 'todo')).toBe(true)
    const logout = saved.find((r) => r.title === 'Logout')!
    expect(logout.dependsOn).toEqual(['x'])
  })

  it('resolves intra-batch dependsOnIndexes to the sibling real id through the handler', async () => {
    // RM-R17: an item can reference a sibling in the same batch by 0-based index;
    // the handler (via insertIntents) resolves it to that sibling's minted id.
    const handler = getSaveHandler(mkServer(proj))
    const res = await handler(
      {
        intents: [
          { title: 'Schema', shortEnTitle: 'auto', content: '', priority: 'P0' },
          {
            title: 'Migration',
            shortEnTitle: 'auto',
            content: '',
            priority: 'P0',
            dependsOnIndexes: [0],
          },
        ],
      },
      {},
    )
    expect(res.isError).toBeFalsy()
    const saved = listIntents(proj)
    const schema = saved.find((r) => r.title === 'Schema')!
    const migration = saved.find((r) => r.title === 'Migration')!
    expect(migration.dependsOn).toEqual([schema.id])
  })

  it('returns isError without persisting when an intra-batch reference is invalid (cycle)', async () => {
    // A cyclic / out-of-range index makes insertIntents throw; the handler catches
    // it and reports a保存失败 so the agent learns nothing was written (atomic reject).
    const onSaved = vi.fn()
    const handler = getSaveHandler(mkServer(proj, onSaved))
    const res = await handler(
      {
        intents: [
          { title: 'A', shortEnTitle: 'auto', content: '', priority: 'P0', dependsOnIndexes: [1] },
          { title: 'B', shortEnTitle: 'auto', content: '', priority: 'P0', dependsOnIndexes: [0] },
        ],
      },
      {},
    )
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('保存失败')
    expect(onSaved).not.toHaveBeenCalled()
    expect(listIntents(proj)).toEqual([])
  })

  it('upserts: a batch item with an id updates the original in place, no new row', async () => {
    // AC-1/5: refine's定稿 carries the original id → the entry is updated, not duplicated.
    const onSaved = vi.fn()
    const [r] = insertIntents(proj, [
      { title: 'old', shortEnTitle: 'auto', content: 'before', priority: 'P2' },
    ])
    const handler = getSaveHandler(mkServer(proj, onSaved))
    const res = await handler(
      {
        intents: [
          { id: r.id, title: 'new', shortEnTitle: 'auto', content: 'after', priority: 'P0' },
        ],
      },
      {},
    )
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('更新 1')
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(listIntents(proj)).toHaveLength(1) // updated in place, no duplicate
    expect(getIntent(r.id)!.title).toBe('new')
  })

  it('upserts a cancelled intent and reactivates it to todo', async () => {
    // AC-2: cancelled + id → updated and status flips back to todo.
    const [r] = insertIntents(proj, [
      { title: 'c', shortEnTitle: 'auto', content: 'x', priority: 'P0' },
    ])
    updateStatus(r.id, 'cancelled')
    const handler = getSaveHandler(mkServer(proj))
    const res = await handler(
      { intents: [{ id: r.id, title: 'c2', shortEnTitle: 'auto', content: 'y', priority: 'P0' }] },
      {},
    )
    expect(res.isError).toBeFalsy()
    const got = getIntent(r.id)!
    expect(got.status).toBe('todo')
    expect(got.title).toBe('c2')
  })

  it('returns isError without persisting when a target is in_progress (locked)', async () => {
    // AC-3: an immutable target rejects the whole batch; the agent learns it cannot save.
    const onSaved = vi.fn()
    const [r] = insertIntents(proj, [
      { title: 'locked', shortEnTitle: 'auto', content: 'orig', priority: 'P0' },
    ])
    updateStatus(r.id, 'in_progress')
    const handler = getSaveHandler(mkServer(proj, onSaved))
    const res = await handler(
      {
        intents: [
          { id: r.id, title: 'hacked', shortEnTitle: 'auto', content: 'no', priority: 'P3' },
          { title: 'sibling', shortEnTitle: 'auto', content: '', priority: 'P0' },
        ],
      },
      {},
    )
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('保存失败')
    expect(onSaved).not.toHaveBeenCalled()
    expect(getIntent(r.id)!.title).toBe('locked')
    expect(listIntents(proj)).toHaveLength(1) // sibling not inserted (atomic)
  })

  it('returns isError without persisting for an unknown / cross-project id', async () => {
    // AC-4: a foreign or non-existent id rejects the whole batch.
    const onSaved = vi.fn()
    const handler = getSaveHandler(mkServer(proj, onSaved))
    const res = await handler(
      { intents: [{ id: 'ghost', title: 'x', shortEnTitle: 'auto', content: '', priority: 'P0' }] },
      {},
    )
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('保存失败')
    expect(onSaved).not.toHaveBeenCalled()
    expect(listIntents(proj)).toEqual([])
  })

  it('handles a mixed update+insert batch in one transaction', async () => {
    // AC-6: one item updates (id) while another inserts (no id), atomically.
    const [r] = insertIntents(proj, [
      { title: 'base', shortEnTitle: 'auto', content: '', priority: 'P0' },
    ])
    const handler = getSaveHandler(mkServer(proj))
    const res = await handler(
      {
        intents: [
          { id: r.id, title: 'base2', shortEnTitle: 'auto', content: '', priority: 'P0' },
          {
            title: 'fresh',
            shortEnTitle: 'auto',
            content: '',
            priority: 'P1',
            dependsOnIndexes: [0],
          },
        ],
      },
      {},
    )
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('新建 1、更新 1')
    expect(listIntents(proj)).toHaveLength(2)
    const fresh = listIntents(proj).find((x) => x.title === 'fresh')!
    expect(fresh.dependsOn).toEqual([r.id])
  })

  it('binds to the closure project path, not a wire-supplied one (no cross-project save)', async () => {
    // Design R6 / §4.5: workspacePath is captured in the closure so the agent can't
    // redirect the save elsewhere. Two servers for two projects stay isolated.
    const handlerA = getSaveHandler(mkServer('/abs/proj-a'))
    const handlerB = getSaveHandler(mkServer('/abs/proj-b'))
    await handlerA(
      { intents: [{ title: 'A', shortEnTitle: 'auto', content: '', priority: 'P0' }] },
      {},
    )
    await handlerB(
      { intents: [{ title: 'B', shortEnTitle: 'auto', content: '', priority: 'P0' }] },
      {},
    )
    expect(listIntents('/abs/proj-a').map((r) => r.title)).toEqual(['A'])
    expect(listIntents('/abs/proj-b').map((r) => r.title)).toEqual(['B'])
  })

  it('returns isError without persisting when the store is unavailable', async () => {
    // §4.5: db-down ⇒ the handler tells the agent it was not saved (isError) so the
    // agent does not claim success. Force unavailability with a bad db path.
    resetDbForTests()
    resetStoreForTests()
    // Point at a path under a non-directory so open/mkdir fails ⇒ db unavailable.
    process.env.C3_DB_PATH = '/dev/null/cannot/c3.db'
    const onSaved = vi.fn()
    const handler = getSaveHandler(mkServer(proj, onSaved))
    const res = await handler(
      { intents: [{ title: 'X', shortEnTitle: 'auto', content: '', priority: 'P0' }] },
      {},
    )
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('不可用')
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe('save_intents confirmation gate (handler-owned, vendor-preApproval-immune)', () => {
  /** Build the c3 server with explicit gate deps so the gate flow is observable. */
  function gatedServer(deps: {
    emit?: (runId: string, frame: { type: string }) => void
    decision: 'allow' | 'deny'
    broadcastIntents?: (p: string) => void
    onPermissionRequest?: () => void
    onDecide?: () => void
  }): Record<string, McpServerConfig> {
    return createIntentMcpServer(
      { workspacePath: proj, getRunId: () => 'run-gate', signal: new AbortController().signal },
      {
        emit: (deps.emit ?? (() => {})) as never,
        waitForDecision: async () => {
          deps.onDecide?.()
          return { decision: deps.decision }
        },
        broadcastIntents: deps.broadcastIntents ?? (() => {}),
        onPermissionRequest: deps.onPermissionRequest,
      },
    )
  }

  const oneIntent = { intents: [{ title: 'X', shortEnTitle: 'auto', content: '', priority: 'P0' }] }

  it('runs the gate inside the handler — proving the handler is the SINGLE gate (no canUseTool involved)', async () => {
    // The handler is invoked DIRECTLY here (no SDK `canUseTool` in the loop), the
    // exact shape of a vendor pre-approval that skips `canUseTool`. It must STILL
    // raise the confirmation: a `permission_request` is emitted before persistence.
    let emittedRequest = false
    const broadcast = vi.fn()
    const handler = getSaveHandler(
      gatedServer({
        decision: 'allow',
        broadcastIntents: broadcast,
        emit: (_runId, frame) => {
          if (frame.type === 'permission_request') emittedRequest = true
        },
      }),
    )
    const res = await handler(oneIntent, {})
    expect(emittedRequest).toBe(true)
    expect(res.isError).toBeFalsy()
    expect(broadcast).toHaveBeenCalledWith(proj)
    expect(listIntents(proj)).toHaveLength(1)
  })

  it('a DENY decision persists nothing and tells the agent it was not saved', async () => {
    // AC: cancel / close / reject all resolve to a non-allow decision ⇒ zero store
    // writes, no broadcast, and a "not saved" result the agent can read.
    const broadcast = vi.fn()
    let emittedRequest = false
    const handler = getSaveHandler(
      gatedServer({
        decision: 'deny',
        broadcastIntents: broadcast,
        emit: (_runId, frame) => {
          if (frame.type === 'permission_request') emittedRequest = true
        },
      }),
    )
    const res = await handler(oneIntent, {})
    expect(emittedRequest).toBe(true) // still confirmed — the gate ran
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('未落库')
    expect(broadcast).not.toHaveBeenCalled()
    expect(listIntents(proj)).toEqual([])
  })

  it('fires the WorkCenter hook BEFORE the wire frame, and decides BEFORE persisting', async () => {
    // Ordering invariant (claude-parity with the codex gate): onPermissionRequest →
    // permission_request → waitForDecision → store, so the save lands in the
    // pending-items panel and nothing persists until the user decides.
    const seq: string[] = []
    const handler = getSaveHandler(
      gatedServer({
        decision: 'allow',
        onPermissionRequest: () => seq.push('onPermissionRequest'),
        emit: (_runId, frame) => {
          if (frame.type === 'permission_request') seq.push('emit')
        },
        onDecide: () => seq.push('decide'),
        broadcastIntents: () => seq.push('store'),
      }),
    )
    await handler(oneIntent, {})
    expect(seq).toEqual(['onPermissionRequest', 'emit', 'decide', 'store'])
  })
})

describe('read-only query tool handlers (find_intents / view_intent)', () => {
  it('registers both query tools on the c3 server, marked always-load', () => {
    const servers = mkServer(proj)
    const c3 = servers.c3 as unknown as {
      instance: {
        _registeredTools: Record<string, { _meta?: Record<string, unknown> }>
      }
    }
    const names = Object.keys(c3.instance._registeredTools)
    expect(names).toContain('find_intents')
    expect(names).toContain('view_intent')
    // resident in the turn-1 prompt, same as save_intents (ADR 0007)
    expect(c3.instance._registeredTools.find_intents._meta).toMatchObject({
      'anthropic/alwaysLoad': true,
    })
    expect(c3.instance._registeredTools.view_intent._meta).toMatchObject({
      'anthropic/alwaysLoad': true,
    })
  })

  it('find_intents returns a slim list (id/title/module/priority/status/dependsOn) filtered by keyword', async () => {
    insertIntents(proj, [
      {
        title: '登录鉴权',
        shortEnTitle: 'auto',
        content: 'oauth',
        priority: 'P0',
        module: '认证',
        dependsOn: ['ext'],
      },
      { title: '导出报表', shortEnTitle: 'auto', content: 'csv', priority: 'P2' },
    ])
    const find = getHandler(mkServer(proj), 'find_intents')
    const res = await find({ keyword: '鉴权' }, {})
    expect(res.isError).toBeFalsy()
    // the text carries a JSON array; parse the slim rows out of it
    const json = res.content[0].text.slice(res.content[0].text.indexOf('['))
    const rows = JSON.parse(json) as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      id: expect.any(String),
      title: '登录鉴权',
      module: '认证',
      priority: 'P0',
      status: 'todo',
      dependsOn: ['ext'],
    })
    // slim shape: no `content` field leaks into the list
    expect(rows[0]).not.toHaveProperty('content')
  })

  it('find_intents reports a friendly empty result when nothing matches', async () => {
    insertIntents(proj, [{ title: 'A', shortEnTitle: 'auto', content: '', priority: 'P0' }])
    const find = getHandler(mkServer(proj), 'find_intents')
    const res = await find({ keyword: 'zzz' }, {})
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('未找到')
  })

  it('find_intents binds to the closure project (no cross-project read)', async () => {
    insertIntents('/abs/proj-a', [
      { title: 'AOnly', shortEnTitle: 'auto', content: 'shared', priority: 'P0' },
    ])
    insertIntents('/abs/proj-b', [
      { title: 'BOnly', shortEnTitle: 'auto', content: 'shared', priority: 'P0' },
    ])
    const findA = getHandler(mkServer('/abs/proj-a'), 'find_intents')
    const res = await findA({ keyword: 'shared' }, {})
    expect(res.content[0].text).toContain('AOnly')
    expect(res.content[0].text).not.toContain('BOnly')
  })

  it('view_intent returns one intent full detail by id (incl. content/dependsOn)', async () => {
    const [r] = insertIntents(proj, [
      {
        title: 'Detail',
        shortEnTitle: 'auto',
        content: 'long body',
        priority: 'P1',
        dependsOn: ['ext'],
      },
    ])
    const view = getHandler(mkServer(proj), 'view_intent')
    const res = await view({ id: r.id }, {})
    expect(res.isError).toBeFalsy()
    const detail = JSON.parse(res.content[0].text) as Record<string, unknown>
    expect(detail.id).toBe(r.id)
    expect(detail.content).toBe('long body')
    expect(detail.dependsOn).toEqual(['ext'])
  })

  it('view_intent gives a friendly (non-error) prompt for an unknown id', async () => {
    const view = getHandler(mkServer(proj), 'view_intent')
    const res = await view({ id: 'does-not-exist' }, {})
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('未找到')
    expect(res.content[0].text).toContain('does-not-exist')
  })

  it('view_intent refuses an id from another project (treated as not found)', async () => {
    const [other] = insertIntents('/abs/proj-b', [
      { title: 'Secret', shortEnTitle: 'auto', content: 's', priority: 'P0' },
    ])
    const view = getHandler(mkServer('/abs/proj-a'), 'view_intent')
    const res = await view({ id: other.id }, {})
    // exists in the ledger, but not in proj-a → not found (no cross-project leak)
    expect(res.content[0].text).toContain('未找到')
    expect(res.content[0].text).not.toContain('Secret')
  })
})

describe('save_intents input validation (shortEnTitle required)', () => {
  const schema = z.object(saveSchema)

  it('rejects a batch when an item is missing shortEnTitle', () => {
    const parsed = schema.safeParse({
      intents: [{ title: 'A', content: 'c', priority: 'P0' }],
    })
    expect(parsed.success).toBe(false)
  })

  it('accepts a batch when shortEnTitle is present', () => {
    const parsed = schema.safeParse({
      intents: [{ title: 'A', shortEnTitle: 'a-slug', content: 'c', priority: 'P0' }],
    })
    expect(parsed.success).toBe(true)
  })
})

describe('intentSessionId field exposure / isolation', () => {
  it('save_intents schema accepts an optional intentSessionId', () => {
    const schema = z.object(saveSchema)
    const parsed = schema.safeParse({
      intents: [
        {
          title: 'A',
          shortEnTitle: 'a',
          content: 'c',
          priority: 'P0',
          intentSessionId: 'sess-1',
        },
      ],
    })
    expect(parsed.success).toBe(true)
    // It is optional: a batch without it still validates.
    expect(
      schema.safeParse({
        intents: [{ title: 'A', shortEnTitle: 'a', content: 'c', priority: 'P0' }],
      }).success,
    ).toBe(true)
  })

  it('save_intent_directly schema STRIPS intentSessionId (no comm-session semantics)', () => {
    // z.object strips unknown keys by default, so a supplied intentSessionId must not
    // survive parsing — the schedule path can never carry a back-link.
    const schema = z.object(saveIntentDirectlySchema)
    const parsed = schema.safeParse({
      intents: [
        {
          title: 'A',
          shortEnTitle: 'a',
          content: 'c',
          priority: 'P0',
          intentSessionId: 'sess-1',
        },
      ],
    })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.intents[0]).not.toHaveProperty('intentSessionId')
  })
})

describe('save_intents single-intent session back-link (gate normalization)', () => {
  it('normalizes a single intent intentSessionId to the bound run id (open_intent_session-resolvable)', async () => {
    // The model echoes the injected (pending) session id; the gate overwrites it with
    // binding.getRunId() (here 'run-1') so the persisted value matches the bound comm
    // session that open_intent_session resolves against.
    const handler = getSaveHandler(mkServer(proj))
    const res = await handler(
      {
        intents: [
          {
            title: 'Solo',
            shortEnTitle: 'solo',
            content: '',
            priority: 'P0',
            intentSessionId: 'pending:whatever',
          },
        ],
      },
      {},
    )
    expect(res.isError).toBeFalsy()
    const [saved] = listIntents(proj)
    expect(getIntent(saved.id)?.intentSessionId).toBe('run-1')
  })

  it('does NOT back-link any row when more than one intent is saved (batch ignored)', async () => {
    const handler = getSaveHandler(mkServer(proj))
    const res = await handler(
      {
        intents: [
          {
            title: 'A',
            shortEnTitle: 'a',
            content: '',
            priority: 'P0',
            intentSessionId: 'pending:x',
          },
          {
            title: 'B',
            shortEnTitle: 'b',
            content: '',
            priority: 'P1',
            intentSessionId: 'pending:y',
          },
        ],
      },
      {},
    )
    expect(res.isError).toBeFalsy()
    for (const r of listIntents(proj)) expect(getIntent(r.id)?.intentSessionId).toBeNull()
  })

  it('leaves intent_session_id null when a single intent omits the field', async () => {
    const handler = getSaveHandler(mkServer(proj))
    await handler(
      { intents: [{ title: 'Solo', shortEnTitle: 'solo', content: '', priority: 'P0' }] },
      {},
    )
    const [saved] = listIntents(proj)
    expect(getIntent(saved.id)?.intentSessionId).toBeNull()
  })
})
