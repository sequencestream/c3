/**
 * Integration tests for the `save_requirements` MCP tool handler (US-4).
 *
 * The handler is reached only AFTER the requirement gate (claude.ts) has already
 * obtained the user's confirmation, so these tests exercise the post-confirmation
 * contract directly: persist via the store, notify via `onSaved`, and return a
 * `CallToolResult` (with `isError` on failure / db-unavailable).
 *
 * We drive the real handler the SDK registered (`instance._registeredTools`),
 * not a re-implementation, so the test fails if the tool's wiring changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { Requirement } from '@ccc/shared/protocol'
import { resetDbForTests } from '../db.js'
import { createRequirementMcpServer } from './save-tool.js'
import { insertRequirements, listRequirements, resetStoreForTests } from './store.js'

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
  return getHandler(servers, 'save_requirements')
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

describe('save_requirements tool handler', () => {
  it('exposes the tool on the c3 server (mcp__c3__save_requirements)', () => {
    // AC-4.1: the agent submits via a tool named save_requirements on server `c3`.
    const servers = createRequirementMcpServer(proj, () => {})
    expect(Object.keys(servers)).toEqual(['c3'])
    const c3 = servers.c3 as unknown as {
      name: string
      instance: { _registeredTools: Record<string, unknown> }
    }
    expect(c3.name).toBe('c3')
    expect(Object.keys(c3.instance._registeredTools)).toContain('save_requirements')
  })

  it('marks the tool always-load so it stays resident (no ToolSearch before save)', () => {
    // ADR 0007: the requirement agent must not have to ToolSearch `save_requirements`
    // back before every save. `createSdkMcpServer({ alwaysLoad: true })` stamps
    // `_meta['anthropic/alwaysLoad'] = true` on each registered tool (≡ API
    // `defer_loading: false`), keeping the schema in the turn-1 prompt. Asserting
    // the meta — not just the tool's existence — guards the deferral behaviour.
    const servers = createRequirementMcpServer(proj, () => {})
    const c3 = servers.c3 as unknown as {
      instance: { _registeredTools: Record<string, { _meta?: Record<string, unknown> }> }
    }
    expect(c3.instance._registeredTools.save_requirements._meta).toMatchObject({
      'anthropic/alwaysLoad': true,
    })
  })

  it('persists a confirmed batch as todo, calls onSaved, returns a success result', async () => {
    // AC-4.3 / AC-4.4: reaching the handler == user allowed; rows land as `todo`,
    // scoped to the project; onSaved fires so the server can broadcast a refresh.
    const onSaved = vi.fn()
    const handler = getSaveHandler(createRequirementMcpServer(proj, onSaved))

    const res = await handler(
      {
        requirements: [
          { title: 'Login', content: 'auth flow', priority: 'P0' },
          { title: 'Logout', content: 'end session', priority: 'P1', dependsOn: ['x'] },
        ],
      },
      {},
    )

    expect(res.isError).toBeFalsy()
    expect(res.content[0].type).toBe('text')
    expect(res.content[0].text).toContain('已保存 2 条需求')
    expect(res.content[0].text).toContain('Login')

    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(onSaved).toHaveBeenCalledWith(proj)

    const saved = listRequirements(proj)
    expect(saved.map((r) => r.title).sort()).toEqual(['Login', 'Logout'])
    expect(saved.every((r: Requirement) => r.status === 'todo')).toBe(true)
    const logout = saved.find((r) => r.title === 'Logout')!
    expect(logout.dependsOn).toEqual(['x'])
  })

  it('resolves intra-batch dependsOnIndexes to the sibling real id through the handler', async () => {
    // RM-R17: an item can reference a sibling in the same batch by 0-based index;
    // the handler (via insertRequirements) resolves it to that sibling's minted id.
    const handler = getSaveHandler(createRequirementMcpServer(proj, () => {}))
    const res = await handler(
      {
        requirements: [
          { title: 'Schema', content: '', priority: 'P0' },
          { title: 'Migration', content: '', priority: 'P0', dependsOnIndexes: [0] },
        ],
      },
      {},
    )
    expect(res.isError).toBeFalsy()
    const saved = listRequirements(proj)
    const schema = saved.find((r) => r.title === 'Schema')!
    const migration = saved.find((r) => r.title === 'Migration')!
    expect(migration.dependsOn).toEqual([schema.id])
  })

  it('returns isError without persisting when an intra-batch reference is invalid (cycle)', async () => {
    // A cyclic / out-of-range index makes insertRequirements throw; the handler catches
    // it and reports a保存失败 so the agent learns nothing was written (atomic reject).
    const onSaved = vi.fn()
    const handler = getSaveHandler(createRequirementMcpServer(proj, onSaved))
    const res = await handler(
      {
        requirements: [
          { title: 'A', content: '', priority: 'P0', dependsOnIndexes: [1] },
          { title: 'B', content: '', priority: 'P0', dependsOnIndexes: [0] },
        ],
      },
      {},
    )
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('保存失败')
    expect(onSaved).not.toHaveBeenCalled()
    expect(listRequirements(proj)).toEqual([])
  })

  it('binds to the closure project path, not a wire-supplied one (no cross-project save)', async () => {
    // Design R6 / §4.5: projectPath is captured in the closure so the agent can't
    // redirect the save elsewhere. Two servers for two projects stay isolated.
    const handlerA = getSaveHandler(createRequirementMcpServer('/abs/proj-a', () => {}))
    const handlerB = getSaveHandler(createRequirementMcpServer('/abs/proj-b', () => {}))
    await handlerA({ requirements: [{ title: 'A', content: '', priority: 'P0' }] }, {})
    await handlerB({ requirements: [{ title: 'B', content: '', priority: 'P0' }] }, {})
    expect(listRequirements('/abs/proj-a').map((r) => r.title)).toEqual(['A'])
    expect(listRequirements('/abs/proj-b').map((r) => r.title)).toEqual(['B'])
  })

  it('returns isError without persisting when the store is unavailable', async () => {
    // §4.5: db-down ⇒ the handler tells the agent it was not saved (isError) so the
    // agent does not claim success. Force unavailability with a bad db path.
    resetDbForTests()
    resetStoreForTests()
    // Point at a path under a non-directory so open/mkdir fails ⇒ db unavailable.
    process.env.C3_DB_PATH = '/dev/null/cannot/c3.db'
    const onSaved = vi.fn()
    const handler = getSaveHandler(createRequirementMcpServer(proj, onSaved))
    const res = await handler({ requirements: [{ title: 'X', content: '', priority: 'P0' }] }, {})
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('不可用')
    expect(onSaved).not.toHaveBeenCalled()
  })
})

describe('read-only query tool handlers (find_requirements / view_requirement)', () => {
  it('registers both query tools on the c3 server, marked always-load', () => {
    const servers = createRequirementMcpServer(proj, () => {})
    const c3 = servers.c3 as unknown as {
      instance: {
        _registeredTools: Record<string, { _meta?: Record<string, unknown> }>
      }
    }
    const names = Object.keys(c3.instance._registeredTools)
    expect(names).toContain('find_requirements')
    expect(names).toContain('view_requirement')
    // resident in the turn-1 prompt, same as save_requirements (ADR 0007)
    expect(c3.instance._registeredTools.find_requirements._meta).toMatchObject({
      'anthropic/alwaysLoad': true,
    })
    expect(c3.instance._registeredTools.view_requirement._meta).toMatchObject({
      'anthropic/alwaysLoad': true,
    })
  })

  it('find_requirements returns a slim list (id/title/module/priority/status/dependsOn) filtered by keyword', async () => {
    insertRequirements(proj, [
      { title: '登录鉴权', content: 'oauth', priority: 'P0', module: '认证', dependsOn: ['ext'] },
      { title: '导出报表', content: 'csv', priority: 'P2' },
    ])
    const find = getHandler(
      createRequirementMcpServer(proj, () => {}),
      'find_requirements',
    )
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

  it('find_requirements reports a friendly empty result when nothing matches', async () => {
    insertRequirements(proj, [{ title: 'A', content: '', priority: 'P0' }])
    const find = getHandler(
      createRequirementMcpServer(proj, () => {}),
      'find_requirements',
    )
    const res = await find({ keyword: 'zzz' }, {})
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('未找到')
  })

  it('find_requirements binds to the closure project (no cross-project read)', async () => {
    insertRequirements('/abs/proj-a', [{ title: 'AOnly', content: 'shared', priority: 'P0' }])
    insertRequirements('/abs/proj-b', [{ title: 'BOnly', content: 'shared', priority: 'P0' }])
    const findA = getHandler(
      createRequirementMcpServer('/abs/proj-a', () => {}),
      'find_requirements',
    )
    const res = await findA({ keyword: 'shared' }, {})
    expect(res.content[0].text).toContain('AOnly')
    expect(res.content[0].text).not.toContain('BOnly')
  })

  it('view_requirement returns one requirement full detail by id (incl. content/dependsOn)', async () => {
    const [r] = insertRequirements(proj, [
      { title: 'Detail', content: 'long body', priority: 'P1', dependsOn: ['ext'] },
    ])
    const view = getHandler(
      createRequirementMcpServer(proj, () => {}),
      'view_requirement',
    )
    const res = await view({ id: r.id }, {})
    expect(res.isError).toBeFalsy()
    const detail = JSON.parse(res.content[0].text) as Record<string, unknown>
    expect(detail.id).toBe(r.id)
    expect(detail.content).toBe('long body')
    expect(detail.dependsOn).toEqual(['ext'])
  })

  it('view_requirement gives a friendly (non-error) prompt for an unknown id', async () => {
    const view = getHandler(
      createRequirementMcpServer(proj, () => {}),
      'view_requirement',
    )
    const res = await view({ id: 'does-not-exist' }, {})
    expect(res.isError).toBeFalsy()
    expect(res.content[0].text).toContain('未找到')
    expect(res.content[0].text).toContain('does-not-exist')
  })

  it('view_requirement refuses an id from another project (treated as not found)', async () => {
    const [other] = insertRequirements('/abs/proj-b', [
      { title: 'Secret', content: 's', priority: 'P0' },
    ])
    const view = getHandler(
      createRequirementMcpServer('/abs/proj-a', () => {}),
      'view_requirement',
    )
    const res = await view({ id: other.id }, {})
    // exists in the ledger, but not in proj-a → not found (no cross-project leak)
    expect(res.content[0].text).toContain('未找到')
    expect(res.content[0].text).not.toContain('Secret')
  })
})
